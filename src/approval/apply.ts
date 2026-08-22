import { ApprovalDecision, ChangeActor, type PendingApproval } from '@prisma/client';

import { formatAmount, renderOutcome, type CardOutcome } from '@/approval/card.js';
import { changeLogAction, changeSnapshot, executeAction } from '@/approval/execute.js';
import { syncLocalEntities } from '@/approval/local-state.js';
import { markNegatedQueries } from '@/approval/mark-negated.js';
import { getMessenger } from '@/approval/telegram.js';
import {
  approvalActionSchema,
  readApprovalMeta,
  toJson,
  type ApprovalAction,
} from '@/approval/types.js';
import { buildContext, getAdapter } from '@/channels/registry.js';
import type { ChannelContext } from '@/channels/types.js';
import { prisma } from '@/db/prisma.js';
import { describeError } from '@/lib/errors.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'approval:apply' });

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
    ctx = await buildContext(action.clientId, action.channel, { access: { actor: 'approval' } });

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
    if (stale) return fail(row, approvedBy, stale, action);
  } catch (err) {
    return fail(row, approvedBy, describeError(err), action);
  }

  let result;
  try {
    result = await executeAction({ ...ctx, dryRun }, action);
  } catch (err) {
    return fail(row, approvedBy, describeError(err), action);
  }

  // ── дальше изменение уже в кабинете: только фиксация факта ──────────────────
  const noop = !result.applied && !dryRun;

  const changeLogError = await writeChangeLog(
    action,
    approvedBy,
    dryRun,
    result.applied,
    result.plan,
  );
  if (changeLogError) notes.push(`запись в журнал изменений не удалась: ${changeLogError}`);

  const negatedError = await markNegatedIfNeeded(action, dryRun);
  if (negatedError) notes.push(`пометка минус-фраз в статистике не удалась: ${negatedError}`);

  const localStateNote = await syncLocalStateIfNeeded(action, dryRun);
  if (localStateNote) notes.push(localStateNote);

  try {
    await prisma.pendingApproval.update({
      where: { id: row.id },
      data: {
        decision: ApprovalDecision.APPLIED,
        error: notes.length > 0 ? notes.join('; ') : null,
      },
    });
  } catch (err) {
    // Статус не сохранился — но операция выполнена. Строка останется APPLYING,
    // её поднимет сверка зависших (expire.ts), а человеку скажем правду.
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
 * проверяет Postgres, выигрывает ровно один вызов; проигравший видит APPLYING.
 */
async function leaseForApply(
  approvalId: string,
): Promise<{ row: PendingApproval } | { skipped: string }> {
  const res = await prisma.pendingApproval.updateMany({
    where: { id: approvalId, decision: ApprovalDecision.APPROVED },
    data: { decision: ApprovalDecision.APPLYING },
  });

  const row = await prisma.pendingApproval.findUnique({ where: { id: approvalId } });
  if (res.count > 0) {
    // Строку читаем после захвата: chatId/tgMessageId/summary нужны для правки карточки.
    return row ? { row } : { skipped: 'approval not found' };
  }

  if (!row) return { skipped: 'approval not found' };
  if (row.decision === ApprovalDecision.APPLYING) return { skipped: 'apply already in progress' };
  return { skipped: `decision is ${row.decision}` };
}

/**
 * Провал ДО записи в кабинет: в кабинете ничего не изменилось, и об этом можно
 * честно сказать «не применено». После `executeAction` этот путь запрещён.
 */
async function fail(
  approval: PendingApproval,
  approvedBy: string,
  error: string,
  action?: ApprovalAction,
): Promise<ApplyOutcome> {
  log.error({ approvalId: approval.id, err: error }, 'approval apply failed');
  await recordApprovalFailure(approval, error, action);
  try {
    await prisma.pendingApproval.update({
      where: { id: approval.id },
      data: { decision: ApprovalDecision.FAILED, error },
    });
  } catch (dbErr) {
    log.error({ approvalId: approval.id, err: describeError(dbErr) }, 'cannot persist FAILED');
  }
  await editCard(approval, { kind: 'failed', by: approvedBy, error });
  return { status: 'FAILED', error };
}

/**
 * Дублирует отказ в `ErrorLog`.
 *
 * `PendingApproval.error` описывает одну заявку, а алерт про всплеск ошибок
 * (ТЗ §3.6) считает строки `ErrorLog`. Пока апрувы туда не писали, серия отказов
 * на одном канале — протухший токен, лежащее API — не поднимала тревогу вовсе:
 * человек видел разъехавшиеся карточки и не понимал, что сломалось одно и то же.
 *
 * Никогда не бросает: заявка уже провалена, и вторая ошибка поверх первой лишь
 * скроет исходную причину.
 */
async function recordApprovalFailure(
  approval: PendingApproval,
  error: string,
  action?: ApprovalAction,
): Promise<void> {
  try {
    await prisma.errorLog.create({
      data: {
        clientId: approval.clientId,
        provider: action?.channel ?? null,
        scope: 'approval:apply',
        code: action?.kind ?? 'UNPARSED_PAYLOAD',
        message: error,
        context: { approvalId: approval.id, kind: approval.kind },
      },
    });
  } catch (err) {
    log.error({ approvalId: approval.id, err: describeError(err) }, 'cannot persist to ErrorLog');
  }
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
        entityType: snap.entityType,
        entityId: snap.entityId,
        action: changeLogAction(action),
        prevValue: toJson(snap.before),
        // `change` — целевое состояние, рядом с ним метаданные исполнения:
        // snapshot бывает и массивом (ставки), разворачивать его в объект нельзя.
        // `dryRun` берём из режима, а не из `applied`: адаптер отвечает applied=false
        // и когда менять было нечего, а это совсем другая история.
        // `provider` и `approvedBy` тоже здесь: своих колонок под них у ChangeLog нет,
        // а без них по журналу не восстановить, куда и с чьего согласия ушло изменение.
        newValue: toJson({
          change: snap.after,
          dryRun,
          applied,
          plan,
          provider: action.channel,
          approvedBy,
        }),
        reason: action.reason,
        // Изменение выпустил человек кнопкой в карточке, а не ночной прогон.
        actor: ChangeActor.USER,
      },
    });
    return null;
  } catch (err) {
    const message = describeError(err);
    log.error({ err: message, kind: action.kind }, 'changelog write failed');
    return message;
  }
}

/**
 * Пометка применённых минус-фраз — тот же долг, что и у прямого применения
 * (`markNegated` в src/optimizer/scheduled.ts): без неё оптимизатор предложит
 * одобренную человеком фразу завтра, послезавтра и далее без конца.
 *
 * В dry-run не помечаем: на площадке ничего не менялось, и запрет фразы в
 * статистике скрыл бы её от следующего — уже настоящего — прогона.
 *
 * Ошибку возвращаем, а не бросаем: минус-слова в кабинете уже стоят, и провал
 * пометки обязан остаться примечанием, а не превратить исход в FAILED.
 *
 * @returns текст ошибки либо null.
 */
async function markNegatedIfNeeded(
  action: ApprovalAction,
  dryRun: boolean,
): Promise<string | null> {
  if (action.kind !== 'add_negatives' || dryRun) return null;
  try {
    const result = await markNegatedQueries({
      clientId: action.clientId,
      provider: action.channel,
      campaignExternalId: action.campaignExternalId,
      phrases: action.phrases,
    });
    // Несопоставленная кампания видна только в логе, а последствие — вечно
    // повторяющаяся карточка про те же фразы. Человек должен узнать сразу.
    if (!result.mapped) {
      return `кампания ${action.campaignExternalId} не найдена в базе: фразы применены, но пометка не поставлена и предложение вернётся`;
    }
    return null;
  } catch (err) {
    const message = describeError(err);
    log.error({ campaign: action.campaignExternalId, err: message }, 'negated marking failed');
    return message;
  }
}

/**
 * Наши строки после применения — тот же долг, что и пометка минус-фраз выше.
 *
 * Оптимизатор считает решения от значений в нашей БД, поэтому непогашенный
 * `Keyword.status` или прежняя `Keyword.bid` означают, что завтрашний прогон
 * предложит ровно то же самое: новая карточка человеку, новые баллы на площадке
 * и запись в ChangeLog об изменении, которого не было. Раньше это чинил только
 * синк сущностей раз в час.
 *
 * В dry-run не трогаем: на площадке ничего не менялось, и обновлённая строка
 * скрыла бы изменение от следующего — уже настоящего — прогона.
 *
 * Пустой ответ адаптера (`applied: false` вне dry-run) отражаем наравне с
 * применённым по той же причине, что и минус-фразы: «менять было нечего»
 * означает, что нужное состояние в кабинете уже стоит, — отстала как раз наша
 * строка.
 *
 * Ошибку возвращаем, а не бросаем: изменение в кабинете уже сделано, и провал
 * записи обязан остаться примечанием, а не превратить исход в FAILED.
 *
 * @returns текст примечания либо null.
 */
async function syncLocalStateIfNeeded(
  action: ApprovalAction,
  dryRun: boolean,
): Promise<string | null> {
  if (dryRun) return null;
  try {
    const { requested, updated } = await syncLocalEntities(action);
    if (requested > 0 && updated < requested) {
      // Ноль обновлённых — сущности нет в нашей базе; меньше запрошенного — часть
      // строк не нашлась. И то и другое означает, что оптимизатор вернётся с тем же.
      log.warn({ kind: action.kind, requested, updated }, 'local state partially synced');
      return (
        `состояние в базе обновлено частично (${updated} из ${requested}): ` +
        'изменение применено, но оптимизатор предложит это изменение снова'
      );
    }
    return null;
  } catch (err) {
    const message = describeError(err);
    log.error({ kind: action.kind, err: message }, 'local state sync failed');
    return `состояние в базе не обновлено: ${message}`;
  }
}

async function findCampaignId(
  provider: ApprovalAction['channel'],
  externalId: string,
): Promise<string | null> {
  const campaign = await prisma.campaign.findUnique({
    where: { provider_externalId: { provider, externalId } },
    select: { id: true },
  });
  return campaign?.id ?? null;
}

/** Правка карточки — best-effort: статус в БД уже проставлен и он главный. */
export async function editCard(approval: PendingApproval, outcome: CardOutcome): Promise<void> {
  if (approval.tgMessageId === null || approval.chatId === null) return;
  try {
    await getMessenger().editMessageText(
      approval.chatId,
      Number(approval.tgMessageId),
      renderOutcome(approval.summary ?? '', outcome),
    );
  } catch (err) {
    log.warn({ approvalId: approval.id, err: describeError(err) }, 'cannot edit approval card');
  }
}
