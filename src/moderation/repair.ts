import { createHash } from 'node:crypto';

import { AdStatus, ChangeActor, ModerationStatus, type Prisma } from '@prisma/client';

import type { ChannelAdapter, ChannelContext, WriteResult } from '@/channels/types.js';
import { textVariantId } from '@/creatives/types.js';
import { AppError, describeError } from '@/lib/errors.js';
import { logger } from '@/logger.js';
import { classifyRejection } from '@/moderation/classify.js';
import type { ModerationDb, ModerationDeps } from '@/moderation/deps.js';
import { describeFailure, recordFailure } from '@/moderation/errors.js';
import type { EscalationCause, ModerationEscalation } from '@/moderation/escalate.js';
import type { MissingAd, ModerationTarget, RejectedAd } from '@/moderation/poll.js';
import { rewriteRejectedAd } from '@/moderation/rewrite.js';
import { MODERATION_TICK_MINUTES } from '@/moderation/tick.js';
import type { AdText, ClassifiedRejection } from '@/moderation/types.js';

const log = logger.child({ scope: 'moderation:repair' });

/**
 * Шаги 3–6 из TZ §13.4 для одного объявления: классифицировать, переписать,
 * отправить, а после трёх неудач — отдать человеку.
 */

/** Столько переписываний площадка получает, прежде чем задачу заберёт человек. */
export const MAX_MODERATION_RETRIES = 3;

export const REWRITE_ACTION = 'moderation_rewrite';
export const PREVIEW_SCOPE = 'moderation.preview';

/**
 * Сколько живёт отметка о показанном предпросмотре.
 *
 * Ключ содержит отпечаток входа модели, поэтому срок нужен не для правильности,
 * а чтобы таблица не росла вечно: изменившийся текст или новая причина отказа
 * дают новый ключ сразу, не дожидаясь истечения старого.
 */
export const PREVIEW_KEY_TTL_DAYS = 30;
export const ESCALATION_ACTION = 'moderation_escalated';

/** Отметка о том, что починка этого объявления только что упала. */
export const BACKOFF_SCOPE = 'moderation.backoff';

/**
 * Сколько тиков объявление ждёт после упавшей починки.
 *
 * Инвариант: строго больше одного периода крона, иначе отступа нет вовсе. Дальше —
 * размен между честной очередью и скоростью восстановления: шесть тиков означают,
 * что застрявшее объявление стоит не больше восьми оплаченных попыток в сутки
 * вместо сорока восьми, а между двумя его попытками потолок успевает пропустить
 * `MAX_REPAIRS_PER_RUN × 6` чужих отказов. Цена — авария провайдера отодвигает
 * починку не на полчаса, а на три часа; объявление всё это время и так не крутится.
 */
export const REPAIR_BACKOFF_TICKS = 6;

export const REPAIR_BACKOFF_MINUTES = REPAIR_BACKOFF_TICKS * MODERATION_TICK_MINUTES;
export const MISSING_ACTION = 'moderation_missing';

export interface RepairContext {
  deps: ModerationDeps;
  target: ModerationTarget;
  ctx: ChannelContext;
  adapter: ChannelAdapter;
  client: { name: string; chatId: string };
}

export type RepairOutcome =
  | { status: 'rewritten'; retries: number; changes: string }
  | { status: 'planned'; plan: Record<string, unknown> }
  | { status: 'escalated'; cause: EscalationCause }
  /** Предпросмотр по этому входу уже показывали: модель не звали. */
  | { status: 'unchanged' }
  /** Прошлая починка этого объявления упала: ждём, чтобы пропустить очередь. */
  | { status: 'backoff'; until: Date }
  | { status: 'skipped'; reason: string };

/**
 * Отпечаток того, что увидела бы модель: объявление, причина отказа и номер
 * попытки. Всё, что меняет ответ, входит в ключ; всё, что не меняет, — нет.
 */
export function previewKey(ad: RejectedAd): string {
  const reason = createHash('sha256').update(ad.reason).digest('hex').slice(0, 12);
  return `${PREVIEW_SCOPE}:${ad.id}:${textVariantId(ad.ad)}:${ad.retries}:${reason}`;
}

/**
 * Резервирует отметку о предпросмотре. `false` — отметка уже стоит.
 *
 * Нужно только в dry-run. В боевом режиме от повторной оплаты держит захват
 * строки (`REJECTED` → `REWRITING`), а в dry-run записей в БД нет намеренно:
 * счётчик попыток тратится только на реальную отправку. Из-за этого крон каждые
 * полчаса видел одно и то же объявление и каждый раз платил за две модели —
 * 96 оплаченных вызовов в сутки на объявление ради одного и того же ответа.
 */
async function reservePreview(deps: ModerationDeps, ad: RejectedAd): Promise<boolean> {
  const ttlMs = PREVIEW_KEY_TTL_DAYS * 24 * 60 * 60 * 1000;
  try {
    await deps.db.idempotencyKey.create({
      data: {
        key: previewKey(ad),
        scope: PREVIEW_SCOPE,
        entityType: 'ad',
        entityId: ad.id,
        expiresAt: new Date(deps.now().getTime() + ttlMs),
      },
    });
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

/**
 * Снимает резерв предпросмотра.
 *
 * Тем же приёмом, что `optimizer/runtime.ts` и `creatives/scheduled.ts`: занятый ключ
 * после отказа — это молчание вместо работы. Best-effort: наверх обязана уйти исходная
 * ошибка, а не отказ уборки за ней.
 */
async function releasePreview(deps: ModerationDeps, ad: RejectedAd): Promise<void> {
  await bestEffort(ad.id, 'failed to release the moderation preview key', () =>
    deps.db.idempotencyKey.deleteMany({ where: { key: previewKey(ad) } }),
  );
}

export function repairBackoffKey(adId: string): string {
  return `${BACKOFF_SCOPE}:${adId}`;
}

/**
 * До какого времени объявление отставлено после упавшей починки; `null` — не отставлено.
 *
 * Срок проверяется здесь, а не отдаётся на откуп чистке просроченных ключей
 * (`scheduler/purge.ts`): отступ обязан кончаться сам по себе, даже если чистка
 * встала, — иначе одна упавшая починка выключала бы объявление навсегда.
 */
async function backoffUntil(deps: ModerationDeps, adId: string): Promise<Date | null> {
  const row = await deps.db.idempotencyKey.findUnique({
    where: { key: repairBackoffKey(adId) },
    select: { expiresAt: true },
  });
  if (row === null) return null;
  return row.expiresAt > deps.now() ? row.expiresAt : null;
}

/**
 * Отставляет объявление после починки, не оставившей о себе следа.
 *
 * Отдельной сущности под счётчик попыток нет намеренно: ключ с временем жизни в
 * проекте уже есть и уже чистится кроном (`scheduler/purge.ts`). Best-effort: наверх
 * обязана уйти исходная ошибка починки, а не отказ записи отметки.
 */
async function deferRepair(deps: ModerationDeps, ad: RejectedAd): Promise<void> {
  const key = repairBackoffKey(ad.id);
  const expiresAt = new Date(deps.now().getTime() + REPAIR_BACKOFF_MINUTES * 60_000);
  await bestEffort(ad.id, 'failed to defer the ad after a failed repair', () =>
    deps.db.idempotencyKey.upsert({
      where: { key },
      create: {
        key,
        scope: BACKOFF_SCOPE,
        entityType: 'ad',
        entityId: ad.id,
        expiresAt,
      },
      update: { expiresAt },
    }),
  );
}

interface EscalationInput {
  cause: EscalationCause;
  classification: ClassifiedRejection | null;
  ad: AdText;
  problems: readonly string[];
  /**
   * На каком значении счётчика объявление паркуется. По умолчанию — на потолке:
   * «отдали человеку» означает, что автоматика по этому объявлению закончила.
   */
  parkAt?: number;
}

function toJson(value: Record<string, unknown>): Prisma.InputJsonObject {
  // Через JSON-раунд-трип: в объекте попадаются `undefined`, на которых Prisma падает.
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
}

/**
 * Поле, которым канал сообщает, что объявление пришлось пересоздать.
 * Заполняет его `VkAdsAdapter.updateAdText` — и в `result` успешного ответа, и в
 * `context` ошибки `VK_BANNER_REPLACE_ORPHAN`, где замена уже создана, а старый
 * баннер удалить не вышло.
 */
const REPLACEMENT_ID_KEY = 'createdBannerExternalId';

/**
 * Внешний id, которым площадка заменила объявление при правке текста.
 *
 * У VK правка текста — это создание нового баннера и удаление старого, поэтому после
 * успешной отправки `Ad.externalId` указывает на удалённый объект. У Директа
 * (`Ads.update`) замены нет и поля в ответе тоже — тогда `null`, и id не трогаем:
 * выдуманный id хуже устаревшего.
 */
function replacementExternalId(source: unknown): string | null {
  if (typeof source !== 'object' || source === null) return null;
  const value = (source as Record<string, unknown>)[REPLACEMENT_ID_KEY];
  return typeof value === 'string' && value !== '' ? value : null;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'P2002'
  );
}

/**
 * Расхождение между `Ad.externalId` и живым объявлением в кабинете — в `ErrorLog`.
 *
 * Единственный источник такого расхождения — занятая пара `(adGroupId, externalId)`:
 * новый баннер уже завела почасовая загрузка (`ingestion/entities.ts` делает upsert по
 * той же паре). Слить две строки автоматика не вправе — это удаление данных.
 *
 * Запись здесь — только след для разбора: одиночная строка в `ErrorLog` до человека
 * сама не доходит (`reporter/alerts.ts` шлёт `error_burst` от десяти ошибок за пять
 * минут, а расхождение по определению одиночное). Человека зовёт эскалация на месте
 * вызова — без неё строка осталась бы молча расходиться с кабинетом.
 */
async function reportExternalIdLoss(
  rc: RepairContext,
  ad: RejectedAd,
  externalId: string,
  err: unknown,
): Promise<void> {
  const failure = describeFailure(
    rc.target.clientId,
    rc.target.provider,
    `external-id:${ad.id}`,
    err,
  );
  await recordFailure(rc.deps.db, {
    ...failure,
    message: `Ad ${ad.id}: внешний id остался ${ad.externalId}, хотя в кабинете живёт ${externalId} — ${failure.message}`,
  });
}

/**
 * Переезд строки на новый внешний id.
 *
 * Старый id дописывается в `Ad.supersededExternalIds` той же записью, что и сам переезд:
 * у VK правка текста создаёт новый баннер, а уборка старого проходит не всегда, и
 * оставшийся в листинге баннер не принадлежит больше ни одной строке. Загрузка
 * (`ingestion/entities.ts`) узнаёт его по этому списку и заводит под него архивную
 * строку, а не работающее объявление со своим счётчиком попыток.
 *
 * `push`, а не `set`: строку переписывают до трёх раз подряд, и каждая неудавшаяся
 * уборка оставляет в кабинете ещё один такой баннер. Помнить надо все — иначе первый же
 * синк вернул бы предыдущему «работает».
 */
function switchedExternalId(from: string, to: string): Prisma.AdUpdateInput {
  return { externalId: to, supersededExternalIds: { push: from } };
}

/** Поля строки, описывающие отправленный в кабинет текст. */
function rewrittenTextFields(ad: AdText): Prisma.AdUpdateInput {
  return {
    title: ad.title,
    body: ad.text,
    // `llmVariant` — отпечаток текста, по нему A/B-отчёт складывает статистику
    // (см. `creatives/ab/experiment.ts`). Переписывание меняет текст, значит это
    // новый вариант; категория отказа в это поле не помещается ни по смыслу, ни по
    // последствиям — два разных объявления с одной категорией слились бы в один ряд.
    llmVariant: textVariantId(ad),
  };
}

interface RewriteRecord {
  classification: ClassifiedRejection;
  rewrite: { ad: AdText; changes: string; promptVersion: string };
  /** Новый внешний id, если объявление пришлось пересоздать. */
  switchedTo: string | null;
}

/**
 * Запись `moderation_rewrite` в журнал.
 *
 * Нужна не только для аудита: на неё смотрит A/B-отчёт (`TEXT_REWRITE_ACTIONS` в
 * `creatives/ab/experiment.ts`), исключая из сравнения объявления, у которых текст
 * сменился внутри окна. Пропустить её на любой ветке — значит подшить показы нового
 * текста к отпечатку старого варианта.
 */
async function logRewrite(rc: RepairContext, ad: RejectedAd, rec: RewriteRecord): Promise<void> {
  await rc.deps.db.changeLog.create({
    data: {
      campaignId: ad.campaignId,
      entityType: 'AD',
      entityId: ad.id,
      action: REWRITE_ACTION,
      prevValue: toJson({ ...ad.ad, reason: ad.reason }),
      newValue: toJson({
        ...rec.rewrite.ad,
        category: rec.classification.category,
        ruleIds: rec.classification.rules.map((rule) => rule.id),
        retries: ad.retries + 1,
        prompts: [rec.classification.promptVersion, rec.rewrite.promptVersion],
        // Только когда id реально сменился: у Директа объявление правится на месте,
        // и пустая пара полей в каждой записи журнала читалась бы как «было и стало
        // одно и то же», а не «замены не было».
        ...(rec.switchedTo === null
          ? {}
          : { externalIdBefore: ad.externalId, externalIdAfter: rec.switchedTo }),
      }),
      reason: rec.rewrite.changes,
      actor: ChangeActor.AI,
      provider: rc.target.provider,
    },
  });
}

/**
 * Эскалация уже отправлена по этому состоянию объявления?
 *
 * Ключ дедупликации — счётчик, на котором объявление запарковано (`parkedAt`), а не
 * число сделанных попыток: письмо «не смогли переписать» и следующее за ним «попытки
 * кончились» относятся к одному и тому же застрявшему объявлению, и человеку нужно
 * ровно одно из них. Счётчик обнуляется, когда площадка объявление принимает
 * (см. `pollAdModeration`), — следующий цикл отказов снова достучится.
 */
async function alreadyEscalated(
  db: ModerationDb,
  adId: string,
  parkedAt: number,
): Promise<boolean> {
  const rows = await db.changeLog.findMany({
    where: { entityType: 'AD', entityId: adId, action: ESCALATION_ACTION },
    select: { newValue: true },
    orderBy: { appliedAt: 'desc' },
    take: 5,
  });
  return rows.some((row) => {
    const value = row.newValue;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    return (value as Record<string, unknown>)['parkedAt'] === parkedAt;
  });
}

/**
 * Отдаёт объявление человеку и паркует его.
 *
 * Парковка — это перевод счётчика попыток на потолок. Без неё объявление, которое
 * невозможно переписать, каждые полчаса заново оплачивало бы классификацию и три
 * переписывания: счётчик рос только на успешной отправке, а значит не рос никогда.
 * Цена парковки — потерянные остатки попыток, и это правильный размен: письмо человеку
 * уже ушло, и до его решения объявление всё равно остановлено.
 */
async function escalate(
  rc: RepairContext,
  ad: RejectedAd,
  input: EscalationInput,
): Promise<RepairOutcome> {
  const { deps, target } = rc;
  const parkedAt = Math.max(input.parkAt ?? MAX_MODERATION_RETRIES, ad.retries);
  if (await alreadyEscalated(deps.db, ad.id, parkedAt)) {
    return { status: 'skipped', reason: 'already escalated' };
  }

  const escalation: ModerationEscalation = {
    clientId: target.clientId,
    clientName: rc.client.name,
    chatId: rc.client.chatId,
    channel: target.provider,
    campaignName: ad.campaignName,
    adId: ad.id,
    adExternalId: ad.externalId,
    retries: ad.retries,
    reason: ad.reason,
    classification: input.classification,
    ad: input.ad,
    problems: input.problems,
    cause: input.cause,
  };

  // Сначала доставка, потом запись: упавшая отправка обязана повториться в
  // следующем прогоне, а не остаться «уже эскалировано» с непрочитанным письмом.
  await deps.escalate(escalation);

  await deps.db.changeLog.create({
    data: {
      campaignId: ad.campaignId,
      entityType: 'AD',
      entityId: ad.id,
      action: ESCALATION_ACTION,
      prevValue: toJson({ ...input.ad, reason: ad.reason }),
      newValue: toJson({
        retries: ad.retries,
        parkedAt,
        cause: input.cause,
        category: input.classification?.category ?? null,
        problems: [...input.problems],
      }),
      reason: `Модерация: ${input.cause}`,
      actor: ChangeActor.AI,
      provider: target.provider,
    },
  });

  if (parkedAt > ad.retries) {
    // Сверка со счётчиком в условии: если параллельный прогон уже захватил строку,
    // парковать нечего — он сам решит судьбу этой попытки.
    await deps.db.ad.updateMany({
      where: {
        id: ad.id,
        moderationStatus: ModerationStatus.REJECTED,
        moderationRetries: ad.retries,
      },
      data: { moderationRetries: parkedAt },
    });
  }

  log.warn(
    { adId: ad.id, clientId: target.clientId, cause: input.cause, retries: ad.retries, parkedAt },
    'moderation escalated to human',
  );
  return { status: 'escalated', cause: input.cause };
}

/**
 * Строка указывает на объявление, которого нет в листинге кабинета.
 *
 * Чинить нечего: нового id не осталось нигде — он ушёл вместе с процессом, который
 * умер между отправкой замены и записью. Поэтому единственное действие — позвать
 * человека и убрать строку из решений.
 *
 * `ARCHIVED`, а не удаление и не пауза в кабинете: пока строка числится работающей, её
 * показы считает A/B, а оптимизатор предлагает по ней паузу — на объект, которого нет.
 * Пометка сама себя чинит: если объявление всё-таки вернётся в листинг, ближайшая
 * загрузка (`ingestion/entities.ts`) вернёт строке статус кабинета. Она же и дедуплицирует
 * письма — выключенную строку `pollAdModeration` в пропажи больше не отдаёт.
 *
 * Порядок «сначала доставка, потом записи» тот же, что в `escalate`: недоставленное
 * письмо обязано повториться на следующем прогоне, а не остаться разобранным молча.
 */
export async function escalateMissingAd(rc: RepairContext, ad: MissingAd): Promise<RepairOutcome> {
  const { deps, target } = rc;
  const cause: EscalationCause = 'ad_missing';

  await deps.escalate({
    clientId: target.clientId,
    clientName: rc.client.name,
    chatId: rc.client.chatId,
    channel: target.provider,
    campaignName: ad.campaignName,
    adId: ad.id,
    adExternalId: ad.externalId,
    retries: ad.retries,
    reason: ad.reason,
    classification: null,
    ad: ad.ad,
    problems: [
      `объявления ${ad.externalId} нет в листинге кабинета ${target.provider}`,
      'похоже, замена текста ушла в кабинет, а новый id записать не успели: восстановить его нечем',
      'строка помечена как не работающая — если объявление вернётся в листинг, ближайшая загрузка вернёт ей статус кабинета',
    ],
    cause,
  });

  await deps.db.changeLog.create({
    data: {
      campaignId: ad.campaignId,
      entityType: 'AD',
      entityId: ad.id,
      action: MISSING_ACTION,
      prevValue: toJson({ ...ad.ad, externalId: ad.externalId }),
      newValue: toJson({ externalId: ad.externalId, retries: ad.retries, cause }),
      reason: `Модерация: ${cause}`,
      actor: ChangeActor.AI,
      provider: target.provider,
    },
  });

  // Сверка со статусом: строку мог выключить синк между опросом и этой записью — тогда
  // решение уже принято кабинетом, и переписывать его нам незачем.
  await deps.db.ad.updateMany({
    where: { id: ad.id, status: AdStatus.ACTIVE },
    data: { status: AdStatus.ARCHIVED },
  });

  log.warn(
    { adId: ad.id, clientId: target.clientId, externalId: ad.externalId, retries: ad.retries },
    'ad row points at a banner the cabinet no longer lists',
  );
  return { status: 'escalated', cause };
}

/**
 * Побочная работа поверх уже случившегося отказа.
 *
 * Наверх обязана уйти исходная ошибка отправки — её ждёт `ErrorLog` прогона, и по ней
 * человек поймёт, что произошло. Упавший журнал или недоставленное письмо подменять
 * её собой права не имеют.
 */
async function bestEffort(
  adId: string,
  message: string,
  action: () => Promise<unknown>,
): Promise<void> {
  try {
    await action();
  } catch (err) {
    log.error({ adId, err: describeError(err) }, message);
  }
}

/**
 * Была ли попытка засчитана: захват строки (`REJECTED` → `REWRITING`) двигает
 * `Ad.moderationRetries`, и дальше объявление ограничивает себя само — после
 * `MAX_MODERATION_RETRIES` оно паркуется. До захвата отказ не двигает ничего.
 */
interface RepairAttempt {
  claimed: boolean;
}

export async function repairRejectedAd(rc: RepairContext, ad: RejectedAd): Promise<RepairOutcome> {
  const { deps, target, ctx, adapter } = rc;

  // До всего остального: смысл отступа в том, чтобы объявление пропустило очередь,
  // а не в том, чтобы подешевле повторить то же самое.
  const until = await backoffUntil(deps, ad.id);
  if (until !== null) {
    log.info(
      { adId: ad.id, clientId: target.clientId, until: until.toISOString() },
      'repair deferred: previous attempt on this ad failed',
    );
    return { status: 'backoff', until };
  }

  if (ad.status !== AdStatus.ACTIVE) {
    // Выключенное объявление никому не показывается, а починка стоит двух вызовов
    // модели и нового баннера в кабинете. Проверка до классификации — она же и есть
    // цена вопроса.
    return { status: 'skipped', reason: 'ad is not running' };
  }

  if (ad.retries >= MAX_MODERATION_RETRIES) {
    return escalate(rc, ad, {
      cause: 'retries_exhausted',
      classification: null,
      ad: ad.ad,
      problems: [`переписывали ${ad.retries} раза, площадка отклонила каждый вариант`],
    });
  }

  const updateAdText = adapter.updateAdText?.bind(adapter);
  if (!updateAdText) {
    // Переписывать текст, который потом некуда отправить, — это платный вызов модели
    // впустую. Поэтому проверка идёт до классификации.
    return escalate(rc, ad, {
      cause: 'channel_unsupported',
      classification: null,
      ad: ad.ad,
      problems: [`адаптер ${target.provider} не реализует updateAdText`],
    });
  }

  // Резерв идёт до классификации: за ней начинаются платные вызовы.
  if (ctx.dryRun && !(await reservePreview(deps, ad))) {
    return { status: 'unchanged' };
  }

  const attempt: RepairAttempt = { claimed: false };
  try {
    return await rewriteAndResubmit(rc, ad, updateAdText, attempt);
  } catch (err) {
    // Отметка означает «ответ по этому входу уже получен и показан». Отказ её не
    // подтверждает: оставить ключ занятым — значит выключить объявление из починки на
    // весь его срок, причём молча, ведь ненулевой `unchanged` при DRY_RUN документирован
    // как норма. Отпускается только на отказе: `escalated` — это полученный и оплаченный
    // ответ, и платить за него каждые полчаса заново не за что.
    if (ctx.dryRun) await releasePreview(deps, ad);
    // Отступ — только за попытку, которую никто не засчитал. Отказ после захвата
    // строки счётчик уже потратил, и три таких отказа паркуют объявление сами.
    // А отказ до захвата не оставляет следа нигде: в dry-run счётчик не растёт
    // никогда, отпущенный ключ предпросмотра снова разрешает платный вызов, и то
    // же самое объявление забирало бы слот потолка каждые полчаса вечно.
    if (!attempt.claimed) await deferRepair(deps, ad);
    throw err;
  }
}

/**
 * Классификация, переписывание и отправка — всё, за что уже платят деньгами.
 *
 * Отдельная функция ровно ради `try` в `repairRejectedAd`: резерв предпросмотра надо
 * отпустить на любом отказе этого куска, а обрамлять `try` половину тела вызывающего —
 * значит однажды дописать шаг мимо него.
 */
async function rewriteAndResubmit(
  rc: RepairContext,
  ad: RejectedAd,
  updateAdText: NonNullable<ChannelAdapter['updateAdText']>,
  attempt: RepairAttempt,
): Promise<RepairOutcome> {
  const { deps, target, ctx } = rc;

  const classification = await classifyRejection(
    {
      clientId: target.clientId,
      channel: target.provider,
      reason: ad.reason,
      ad: ad.ad,
    },
    { run: deps.runClassify },
  );

  const rewrite = await rewriteRejectedAd(
    {
      clientId: target.clientId,
      channel: target.provider,
      reason: ad.reason,
      classification,
      ad: ad.ad,
      moderationAttempt: ad.retries,
    },
    { run: deps.runRewrite },
  );

  if (!rewrite.ok) {
    // Модель не смогла собрать вариант, проходящий проверки. Отправлять последний
    // черновик нельзя: он не прошёл ровно те же проверки, что и новое объявление.
    return escalate(rc, ad, {
      cause: 'rewrite_failed',
      classification,
      ad: ad.ad,
      problems: rewrite.problems,
    });
  }

  if (ctx.dryRun) {
    // Ни одной записи в БД: счётчик попыток тратится только на реальную отправку.
    const preview = await updateAdText(ctx, ad.externalId, rewrite.ad);
    log.info({ adId: ad.id, category: classification.category }, 'rewrite planned (dry run)');
    return { status: 'planned', plan: preview.plan };
  }

  // Заявка на объявление: перевод REJECTED → REWRITING со сверкой счётчика делает
  // захват атомарным. Два наложившихся прогона не отправят два разных текста —
  // второй увидит count = 0 и уйдёт. Тем же условием ловится объявление, выключенное
  // синком между опросом и отправкой: включать его обратно мы права не имеем.
  const claim = await deps.db.ad.updateMany({
    where: {
      id: ad.id,
      status: AdStatus.ACTIVE,
      moderationStatus: ModerationStatus.REJECTED,
      moderationRetries: ad.retries,
    },
    data: {
      moderationStatus: ModerationStatus.REWRITING,
      moderationRetries: ad.retries + 1,
    },
  });
  if (claim.count === 0) {
    return { status: 'skipped', reason: 'claimed by another run or no longer active' };
  }
  attempt.claimed = true;

  let applied: WriteResult;
  try {
    applied = await updateAdText(ctx, ad.externalId, rewrite.ad);
  } catch (err) {
    // Отказ на полпути: замена уже создана и уже показывается, а старое объявление
    // осталось (адаптер гасит его сам). Единственное место, где сохранился id живого
    // баннера, — контекст ошибки; не забрать его отсюда значит потерять объявление,
    // которое тратит бюджет клиента, навсегда.
    const orphan = replacementExternalId(err instanceof AppError ? err.context : null);
    const live = orphan !== null && orphan !== ad.externalId ? orphan : null;

    // Статус возвращаем, счётчик — нет. У VK «обновление текста» это создание нового
    // баннера с удалением старого, и упасть оно может уже после создания: считать
    // такую попытку несостоявшейся значило бы отправить ещё один текст поверх.
    const release = { moderationStatus: ModerationStatus.REJECTED };
    let liveExternalId = ad.externalId;
    if (live === null) {
      // Сверка со статусом: если захват успел протухнуть и его снял опрос, судьбу
      // строки решает он, а не мы.
      await deps.db.ad.updateMany({
        where: { id: ad.id, moderationStatus: ModerationStatus.REWRITING },
        data: release,
      });
    } else {
      // Новый id и снятие захвата — одной записью. Двумя запросами между ними
      // открывалось бы окно: падение внутри него оставляло бы строку с мёртвым id и
      // потраченной попыткой, а поднять её нечем — старого баннера в листинге нет.
      try {
        await deps.db.ad.update({
          where: { id: ad.id },
          data: {
            ...rewrittenTextFields(rewrite.ad),
            ...release,
            ...switchedExternalId(ad.externalId, live),
          },
        });
        liveExternalId = live;
        log.warn(
          { adId: ad.id, from: ad.externalId, to: live },
          'channel replaced the ad but left the old one; external id switched to the live banner',
        );
      } catch (writeErr) {
        // Захват снять обязаны в любом случае: строка в `REWRITING` с мёртвым id — это
        // объявление, выключенное из модерации до ручного вмешательства.
        await deps.db.ad.updateMany({
          where: { id: ad.id, moderationStatus: ModerationStatus.REWRITING },
          data: release,
        });
        await reportExternalIdLoss(rc, ad, live, writeErr);
      }
    }

    const adopted = liveExternalId !== ad.externalId;
    if (adopted) {
      // Текст в кабинете уже сменился — в журнале это должно быть видно так же, как
      // на успешной ветке, иначе A/B не отсеет смешанную статистику.
      await bestEffort(ad.id, 'failed to log the rewrite of a half-applied update', () =>
        logRewrite(rc, ad, { classification, rewrite, switchedTo: liveExternalId }),
      );
    }

    // Единственный отказ, после которого объявление в кабинете может остаться
    // наполовину обновлённым, — человек обязан о нём узнать. Парковка здесь не нужна:
    // потрачена одна попытка, и следующий прогон имеет право попробовать ещё раз.
    await bestEffort(ad.id, 'failed to escalate apply failure', async () => {
      await escalate(
        rc,
        { ...ad, externalId: liveExternalId },
        {
          cause: 'apply_failed',
          classification,
          ad: rewrite.ad,
          problems: [
            `отправка в кабинет ${target.provider} не удалась: ${describeError(err)}`,
            ...(adopted
              ? [
                  `в кабинете уже показывается новое объявление ${liveExternalId}, старое ${ad.externalId} осталось и остановлено`,
                ]
              : []),
            // Замена создана, а привязать её к строке не вышло: без этой строчки
            // человек не узнает, что в группе крутится ничей баннер.
            ...(live !== null && !adopted
              ? [`в кабинете создано объявление ${live}, но привязать его к строке не удалось`]
              : []),
          ],
          parkAt: ad.retries + 1,
        },
      );
    });
    throw err;
  }

  const data: Prisma.AdUpdateInput = {
    ...rewrittenTextFields(rewrite.ad),
    moderationStatus: ModerationStatus.PENDING,
    moderationReason: null,
  };

  // Новый id идёт той же записью, что и тексты: у VK старого баннера уже нет, и строка,
  // оставшаяся с его id, выпадает из всего сразу — статистика не сопоставится
  // (`ingestion/stats.ts` индексирует по externalId), опрос модерации перестанет её
  // находить (`pollAdModeration` ходит от объявлений кабинета), а пауза и ставка уйдут
  // на несуществующий объект.
  const replacement = replacementExternalId(applied.result);
  const nextExternalId = replacement !== null && replacement !== ad.externalId ? replacement : null;

  let switchedTo = nextExternalId;
  let idConflict: string | null = null;
  try {
    await deps.db.ad.update({
      where: { id: ad.id },
      data:
        nextExternalId === null
          ? data
          : { ...data, ...switchedExternalId(ad.externalId, nextExternalId) },
    });
  } catch (err) {
    if (nextExternalId === null || !isUniqueViolation(err)) throw err;
    // Пару `(adGroupId, externalId)` занял кто-то ещё. Тексты и статус всё равно
    // сохраняем: иначе объявление осталось бы в `REWRITING` до ближайшего опроса.
    //
    // Строка при этом указывает на баннер, которого в кабинете больше нет: заменяя
    // текст, канал его удалил. Сама она не починится — `pollAdModeration` ищет по паре
    // `(adGroupId, externalId)` и такой пары в листинге не найдёт, а `syncAds` чужие
    // строки не архивирует. Поэтому объявление помечается как не работающее (иначе
    // оптимизатор вечно предлагал бы паузу несуществующему баннеру, а A/B считал бы
    // его показы) и уходит человеку письмом.
    switchedTo = null;
    idConflict = nextExternalId;
    await deps.db.ad.update({ where: { id: ad.id }, data: { ...data, status: AdStatus.ARCHIVED } });
    await reportExternalIdLoss(rc, ad, nextExternalId, err);
  }

  await logRewrite(rc, ad, { classification, rewrite, switchedTo });

  log.info(
    {
      adId: ad.id,
      clientId: target.clientId,
      category: classification.category,
      retries: ad.retries + 1,
      regenerated: rewrite.regenerated,
      externalId: switchedTo ?? ad.externalId,
    },
    'rejected ad rewritten and resubmitted',
  );

  if (idConflict !== null) {
    return escalate(rc, ad, {
      cause: 'external_id_taken',
      classification,
      ad: rewrite.ad,
      problems: [
        `текст заменён, но в кабинете это уже другое объявление ${idConflict}, а пара (группа, ${idConflict}) занята другой строкой нашей БД`,
        `строка ${ad.id} осталась с внешним id ${ad.externalId}, которого в кабинете больше нет, и помечена как не работающая`,
      ],
      parkAt: ad.retries + 1,
    });
  }

  return { status: 'rewritten', retries: ad.retries + 1, changes: rewrite.changes };
}
