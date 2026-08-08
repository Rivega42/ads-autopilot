import { ApprovalStatus, type PendingApproval } from '@prisma/client';
import { prisma } from '@/db/prisma.js';
import { buildContext } from '@/channels/registry.js';
import { describeError } from '@/lib/errors.js';
import { scoped } from '@/lib/logger.js';
import { renderOutcome, type CardOutcome } from '@/approval/card.js';
import { changeLogAction, changeSnapshot, executeAction } from '@/approval/execute.js';
import { getMessenger } from '@/approval/telegram.js';
import { approvalActionSchema, toJson, type ApprovalAction } from '@/approval/types.js';

const log = scoped('approval:apply');

export type ApplyOutcome =
  | { status: 'APPLIED'; dryRun: boolean }
  | { status: 'FAILED'; error: string }
  | { status: 'SKIPPED'; reason: string };

/**
 * Применяет одобренную заявку.
 *
 * Функция принципиально не бросает: её зовут из обработчика callback-кнопки, где
 * исключение превратилось бы в «часики» у пользователя и потерянный статус в БД.
 * Любая беда становится строкой `FAILED` + текстом ошибки в карточке.
 */
export async function applyApproval(approvalId: string, approvedBy: string): Promise<ApplyOutcome> {
  const approval = await prisma.pendingApproval.findUnique({ where: { id: approvalId } });
  if (!approval) return { status: 'SKIPPED', reason: 'approval not found' };
  if (approval.status !== ApprovalStatus.APPROVED) {
    return { status: 'SKIPPED', reason: `status is ${approval.status}` };
  }

  const parsed = approvalActionSchema.safeParse(approval.payload);
  if (!parsed.success) {
    // Payload писали мы сами; несовпадение схемы означает, что код уехал вперёд БД.
    // Применять «примерно понятное» описание изменения в кабинет клиента нельзя.
    return fail(approval, approvedBy, `payload не проходит валидацию: ${parsed.error.message}`);
  }
  const action = parsed.data;

  try {
    const ctx = await buildContext(action.clientId, action.channel);
    const result = await executeAction(ctx, action);

    await writeChangeLog(action, approvedBy, result.applied, result.plan);

    await prisma.pendingApproval.update({
      where: { id: approval.id },
      data: { status: ApprovalStatus.APPLIED, error: null },
    });
    await editCard(approval, {
      kind: 'applied',
      by: approvedBy,
      dryRun: !result.applied,
    });

    log.info(
      { approvalId: approval.id, kind: action.kind, applied: result.applied },
      'approval applied',
    );
    return { status: 'APPLIED', dryRun: !result.applied };
  } catch (err) {
    return fail(approval, approvedBy, describeError(err));
  }
}

async function fail(
  approval: PendingApproval,
  approvedBy: string,
  error: string,
): Promise<ApplyOutcome> {
  log.error({ approvalId: approval.id, err: error }, 'approval apply failed');
  try {
    await prisma.pendingApproval.update({
      where: { id: approval.id },
      data: { status: ApprovalStatus.FAILED, error },
    });
  } catch (dbErr) {
    log.error({ approvalId: approval.id, err: describeError(dbErr) }, 'cannot persist FAILED');
  }
  await editCard(approval, { kind: 'failed', by: approvedBy, error });
  return { status: 'FAILED', error };
}

/**
 * Журнал изменений. Пишем его и в dry-run — иначе история «что мы собирались
 * сделать» теряется, а именно по ней потом разбирают инциденты. Факт того, что
 * в кабинет ничего не ушло, помечен флагом `dryRun` в `after`.
 */
async function writeChangeLog(
  action: ApprovalAction,
  approvedBy: string,
  applied: boolean,
  plan: Record<string, unknown>,
): Promise<void> {
  try {
    const snap = changeSnapshot(action);
    const campaignId = snap.campaignExternalId
      ? await findCampaignId(action.channel, snap.campaignExternalId)
      : null;

    await prisma.changeLog.create({
      data: {
        campaignId,
        channel: action.channel,
        action: changeLogAction(action),
        targetType: snap.targetType,
        targetId: snap.targetId,
        before: toJson(snap.before),
        // `change` — целевое состояние, рядом с ним метаданные исполнения:
        // snapshot бывает и массивом (ставки), разворачивать его в объект нельзя.
        after: toJson({ change: snap.after, dryRun: !applied, plan }),
        reason: action.reason,
        approvedBy,
      },
    });
  } catch (err) {
    // Операция в кабинете уже выполнена — откатывать статус из-за упавшего аудита хуже,
    // чем потерять строку журнала: повторный APPLY применил бы изменение дважды.
    log.error({ err: describeError(err), kind: action.kind }, 'changelog write failed');
  }
}

async function findCampaignId(
  channel: ApprovalAction['channel'],
  externalId: string,
): Promise<string | null> {
  const campaign = await prisma.campaign.findUnique({
    where: { channel_externalId: { channel, externalId } },
    select: { id: true },
  });
  return campaign?.id ?? null;
}

/** Правка карточки — best-effort: статус в БД уже проставлен и он главный. */
export async function editCard(approval: PendingApproval, outcome: CardOutcome): Promise<void> {
  if (!approval.messageId) return;
  try {
    await getMessenger().editMessageText(
      approval.chatId,
      Number(approval.messageId),
      renderOutcome(approval.summary, outcome),
    );
  } catch (err) {
    log.warn({ approvalId: approval.id, err: describeError(err) }, 'cannot edit approval card');
  }
}
