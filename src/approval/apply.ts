import { ApprovalStatus, type PendingApproval } from '@prisma/client';
import { prisma } from '@/db/prisma.js';
import { buildContext, getAdapter } from '@/channels/registry.js';
import type { ChannelContext } from '@/channels/types.js';
import { describeError } from '@/lib/errors.js';
import { scoped } from '@/lib/logger.js';
import { formatAmount, renderOutcome, type CardOutcome } from '@/approval/card.js';
import { changeLogAction, changeSnapshot, executeAction } from '@/approval/execute.js';
import { getMessenger } from '@/approval/telegram.js';
import {
  approvalActionSchema,
  readApprovalMeta,
  toJson,
  type ApprovalAction,
} from '@/approval/types.js';

const log = scoped('approval:apply');

/**
 * Маркер «применение началось» в колонке `error`.
 *
 * Отдельного статуса APPLYING в схеме нет, а входной шлюз обязан быть таким же
 * условным UPDATE, как захват в callbacks.ts: `applyApproval` экспортируется наружу,
 * и второй вызов (ретрай-крон, CLI, админка) не должен второй раз потратить деньги.
 * Строка при этом остаётся APPROVED — по ней же работает сверка зависших заявок.
 */
export const APPLY_LEASE_PREFIX = 'apply:in-progress ';

/** Насколько живое значение может разойтись с зафиксированным в карточке. */
const PRECONDITION_TOLERANCE_RATIO = 0.01;

export type ApplyOutcome =
  | {
      status: 'APPLIED';
      dryRun: boolean;
      /** Адаптеру нечего было менять — записи в кабинет не было и dry-run ни при чём. */
      noop?: boolean;
      /** Изменение выполнено, но сопутствующая запись (журнал/статус) не удалась. */
      warning?: string;
    }
  | { status: 'FAILED'; error: string }
  | { status: 'SKIPPED'; reason: string };

/**
 * Применяет одобренную заявку.
 *
 * Функция принципиально не бросает: её зовут из обработчика callback-кнопки, где
 * исключение превратилось бы в «часики» у пользователя и потерянный статус в БД.
 *
 * Главное правило порядка: до `executeAction` любая беда — это FAILED («не применено»),
 * после `executeAction` изменение уже в кабинете, и ни одна упавшая запись в БД не
 * имеет права превратиться в «применить не удалось»: человек прочитает это как
 * «денег не потратили» и нажмёт ещё раз.
 */
export async function applyApproval(approvalId: string, approvedBy: string): Promise<ApplyOutcome> {
  const approval = await leaseForApply(approvalId);
  if ('skipped' in approval) return { status: 'SKIPPED', reason: approval.skipped };
  const row = approval.row;

  const parsed = approvalActionSchema.safeParse(row.payload);
  if (!parsed.success) {
    // Payload писали мы сами; несовпадение схемы означает, что код уехал вперёд БД.
    // Применять «примерно понятное» описание изменения в кабинет клиента нельзя.
    return fail(row, approvedBy, `payload не проходит валидацию: ${parsed.error.message}`);
  }
  const action = parsed.data;

  let ctx: ChannelContext;
  let dryRun: boolean;
  const notes: string[] = [];
  try {
    ctx = await buildContext(action.clientId, action.channel);

    // Режим, обещанный карточкой, против режима, который сейчас реально enforce-ится.
    const promised = readApprovalMeta(row.payload).dryRun;
    dryRun = promised === undefined ? ctx.dryRun : promised || ctx.dryRun;
    if (promised !== undefined && promised !== ctx.dryRun) {
      const divergence = promised
        ? 'карточка обещала запись только в журнал — применяем как dry-run, хотя настройки уже разрешают запись'
        : 'карточка обещала реальное изменение, но сейчас включён dry-run: в кабинет ничего не отправлено';
      notes.push(divergence);
      log.warn({ approvalId: row.id, promised, enforced: ctx.dryRun }, 'dry-run flag diverged');
    }

    const stale = await precondition(ctx, action);
    if (stale) return fail(row, approvedBy, stale);
  } catch (err) {
    return fail(row, approvedBy, describeError(err));
  }

  let result;
  try {
    result = await executeAction({ ...ctx, dryRun }, action);
  } catch (err) {
    return fail(row, approvedBy, describeError(err));
  }

  // ── дальше изменение уже в кабинете: только фиксация факта ──────────────────
  const noop = !result.applied && !dryRun;

  const changeLogError = await writeChangeLog(action, approvedBy, dryRun, result.applied, result.plan);
  if (changeLogError) notes.push(`запись в журнал изменений не удалась: ${changeLogError}`);

  try {
    await prisma.pendingApproval.update({
      where: { id: row.id },
      data: { status: ApprovalStatus.APPLIED, error: notes.length > 0 ? notes.join('; ') : null },
    });
  } catch (err) {
    // Статус не сохранился — но операция выполнена. Строка останется APPROVED с
    // маркером аренды, её поднимет сверка (expire.ts), а человеку скажем правду.
    notes.push(`статус заявки в БД не обновлён: ${describeError(err)}`);
    log.error({ approvalId: row.id, err: describeError(err) }, 'cannot persist APPLIED');
  }

  const warning = notes.length > 0 ? notes.join('; ') : undefined;
  await editCard(row, {
    kind: 'applied',
    by: approvedBy,
    dryRun,
    ...(noop ? { noop: true } : {}),
    ...(warning ? { warning } : {}),
  });

  log.info(
    { approvalId: row.id, kind: action.kind, applied: result.applied, dryRun, noop },
    'approval applied',
  );
  return {
    status: 'APPLIED',
    dryRun,
    ...(noop ? { noop: true } : {}),
    ...(warning ? { warning } : {}),
  };
}

/**
 * Входной шлюз: условный UPDATE вместо «прочитали статус → проверили → пишем».
 *
 * Между чтением и записью есть await, поэтому два параллельных вызова по одной
 * заявке иначе оба увидели бы APPROVED и оба сходили бы в кабинет. Условие
 * проверяет Postgres, выигрывает ровно один вызов.
 */
async function leaseForApply(
  approvalId: string,
): Promise<{ row: PendingApproval } | { skipped: string }> {
  const lease = `${APPLY_LEASE_PREFIX}${new Date().toISOString()}`;
  const res = await prisma.pendingApproval.updateMany({
    where: {
      id: approvalId,
      status: ApprovalStatus.APPROVED,
      // Явная ветка `error: null` — сравнение NULL с LIKE даёт NULL, то есть строку
      // без ошибки условие `not startsWith` не пропустило бы.
      OR: [{ error: null }, { error: { not: { startsWith: APPLY_LEASE_PREFIX } } }],
    },
    data: { error: lease },
  });

  const row = await prisma.pendingApproval.findUnique({ where: { id: approvalId } });
  if (res.count > 0) {
    // Строку читаем после захвата: chatId/messageId/summary нужны для правки карточки.
    return row ? { row } : { skipped: 'approval not found' };
  }

  if (!row) return { skipped: 'approval not found' };
  if (row.status === ApprovalStatus.APPROVED) return { skipped: 'apply already in progress' };
  return { skipped: `status is ${row.status}` };
}

/**
 * Провал ДО записи в кабинет: в кабинете ничего не изменилось, и об этом можно
 * честно сказать «не применено». После `executeAction` этот путь запрещён.
 */
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
 * Проверка предпосылки решения.
 *
 * По TZ payload применяется без пересчёта, и это правильно: человек согласился на
 * конкретное действие. Но «снизить с 5 000 до 3 000» разумно ровно до тех пор, пока
 * в кабинете действительно 5 000. Если за время ожидания бюджет подняли до 20 000,
 * то же самое действие превращается в срез на 85%, которого никто не одобрял.
 *
 * Поэтому: не пересчитываем, а отказываемся. Отказ обратим — оптимизатор на следующем
 * прогоне выпустит новую карточку с настоящими цифрами; ошибочное применение необратимо.
 * Сбой чтения предпосылкой не считается: блокировать решение из-за упавшего GET нельзя.
 *
 * @returns текст отказа либо null, если применять можно.
 */
async function precondition(ctx: ChannelContext, action: ApprovalAction): Promise<string | null> {
  if (action.kind !== 'budget_change') return null;

  const live = await liveDailyBudget(ctx, action);
  if (live === null) return null;

  const tolerance = Math.max(0.01, Math.abs(action.before) * PRECONDITION_TOLERANCE_RATIO);
  if (Math.abs(live - action.before) <= tolerance) return null;

  return (
    `дневной бюджет кампании «${action.campaignName}» изменился после запроса апрува: ` +
    `в карточке ${formatAmount(action.before)}, сейчас ${formatAmount(live)} ₽/сут. ` +
    'Изменение не применено — дождитесь новой рекомендации оптимизатора.'
  );
}

async function liveDailyBudget(
  ctx: ChannelContext,
  action: Extract<ApprovalAction, { kind: 'budget_change' }>,
): Promise<number | null> {
  try {
    const campaigns = await getAdapter(action.channel).listCampaigns(ctx);
    const found = campaigns.find((c) => c.externalId === action.campaignExternalId);
    return found?.dailyBudget ?? null;
  } catch (err) {
    log.warn(
      { channel: action.channel, campaign: action.campaignExternalId, err: describeError(err) },
      'cannot read live budget, precondition not checked',
    );
    return null;
  }
}

/**
 * Журнал изменений. Пишем его и в dry-run — иначе история «что мы собирались
 * сделать» теряется, а именно по ней потом разбирают инциденты.
 *
 * Ошибку не глотаем, а возвращаем: строка заявки должна показывать, что аудита нет.
 *
 * @returns текст ошибки либо null.
 */
async function writeChangeLog(
  action: ApprovalAction,
  approvedBy: string,
  dryRun: boolean,
  applied: boolean,
  plan: Record<string, unknown>,
): Promise<string | null> {
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
        // `dryRun` берём из режима, а не из `applied`: адаптер отвечает applied=false
        // и когда менять было нечего, а это совсем другая история.
        after: toJson({ change: snap.after, dryRun, applied, plan }),
        reason: action.reason,
        approvedBy,
      },
    });
    return null;
  } catch (err) {
    const message = describeError(err);
    log.error({ err: message, kind: action.kind }, 'changelog write failed');
    return message;
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
