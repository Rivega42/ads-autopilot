import { AdStatus, ChangeActor, ModerationStatus, type Prisma } from '@prisma/client';

import type { ChannelAdapter, ChannelContext, WriteResult } from '@/channels/types.js';
import { textVariantId } from '@/creatives/types.js';
import { AppError, describeError } from '@/lib/errors.js';
import { logger } from '@/logger.js';
import { classifyRejection } from '@/moderation/classify.js';
import type { ModerationDb, ModerationDeps } from '@/moderation/deps.js';
import { describeFailure, recordFailure } from '@/moderation/errors.js';
import type { EscalationCause, ModerationEscalation } from '@/moderation/escalate.js';
import type { ModerationTarget, RejectedAd } from '@/moderation/poll.js';
import { rewriteRejectedAd } from '@/moderation/rewrite.js';
import type { AdText, ClassifiedRejection } from '@/moderation/types.js';

const log = logger.child({ scope: 'moderation:repair' });

/**
 * Шаги 3–6 из TZ §13.4 для одного объявления: классифицировать, переписать,
 * отправить, а после трёх неудач — отдать человеку.
 */

/** Столько переписываний площадка получает, прежде чем задачу заберёт человек. */
export const MAX_MODERATION_RETRIES = 3;

export const REWRITE_ACTION = 'moderation_rewrite';
export const ESCALATION_ACTION = 'moderation_escalated';

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
  | { status: 'skipped'; reason: string };

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

export async function repairRejectedAd(rc: RepairContext, ad: RejectedAd): Promise<RepairOutcome> {
  const { deps, target, ctx, adapter } = rc;

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
          data: { ...rewrittenTextFields(rewrite.ad), ...release, externalId: live },
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
      data: nextExternalId === null ? data : { ...data, externalId: nextExternalId },
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
