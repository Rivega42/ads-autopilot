import { AdStatus, ModerationStatus, type Provider } from '@prisma/client';

import type { ChannelAdapter, ChannelContext, RemoteAd } from '@/channels/types.js';
import { toModerationStatus } from '@/ingestion/mapping.js';
import { logger } from '@/logger.js';
import type { ModerationDb } from '@/moderation/deps.js';
import { MODERATION_TICK_MINUTES } from '@/moderation/tick.js';
import type { AdText } from '@/moderation/types.js';

const log = logger.child({ scope: 'moderation:poll' });

/**
 * Шаг 1 из TZ §13.4: опрос статусов модерации по кабинетам.
 *
 * Почему отдельно от почасовой загрузки сущностей: `check-moderation` ходит своим
 * кроном и читает ровно два поля, а `runIngestion` тянет кампании, группы, ставки
 * и статистику. Смысл мэппинга статусов при этом один и тот же, поэтому
 * `toModerationStatus` берётся оттуда, а не переписывается заново: разойдись эти две
 * таблицы, и «ACCEPTED» стал бы значить в модерации не то, что в отчётах.
 */

export interface ModerationTarget {
  clientId: string;
  provider: Provider;
}

/** Отклонённое объявление вместе со всем, что нужно для переписывания. */
export interface RejectedAd {
  id: string;
  externalId: string;
  campaignId: string;
  campaignName: string;
  /** Крутится ли объявление. Переписывать имеет смысл только работающее. */
  status: AdStatus;
  /** Сколько раз это объявление уже переписывалось. */
  retries: number;
  /** Причина отказа дословно от площадки. */
  reason: string;
  /** Тексты с площадки, а не из нашей БД: там актуальная версия, которую и отклонили. */
  ad: AdText;
}

/**
 * Строка, которая указывает на объявление, отсутствующее в листинге кабинета.
 *
 * Появляется, когда процесс умер между успешной отправкой замены и записью нового id:
 * у VK правка текста удаляет старый баннер, новый id ушёл вместе с процессом, и
 * восстановить его нечем. Изнутри цикла по объявлениям кабинета такую строку не увидеть
 * никогда — поэтому её ищет отдельный проход, а зовёт человека прогон.
 */
export interface MissingAd {
  id: string;
  externalId: string;
  campaignId: string;
  campaignName: string;
  /** Сколько раз это объявление уже переписывалось. */
  retries: number;
  /** Последняя известная причина отказа. */
  reason: string;
  /** Тексты из нашей БД: кабинет по этому id уже ничего не отдаёт. */
  ad: AdText;
}

export interface PollResult {
  polled: number;
  /** Строк, у которых статус или причина реально изменились. */
  updated: number;
  /** Объявления кабинета, которых нет в нашей БД: их заведёт ingestion. */
  orphaned: number;
  /** Строк, снятых с зависшего `REWRITING`. Ненулевое значение — след падения процесса. */
  reclaimed: number;
  rejected: RejectedAd[];
  /** Строки, чьего объявления нет в листинге. Пусто, когда листингу нельзя верить. */
  missing: MissingAd[];
}

/**
 * Сколько потерянных строк в одном кабинете считаем правдой.
 *
 * Внешний id теряется в одном-единственном месте: между захватом строки и записью
 * нового id, а захват держится ровно на одно объявление за раз (`repairRejectedAd`
 * работает последовательно). Значит один убитый процесс уносит одну строку, и даже
 * несколько падений подряд дают единицы. Пачка сразу — это не столько потерянных
 * объявлений, а неполный листинг: оборванная пагинация, фильтр статусов, ошибка
 * кабинета на середине. Отправить по такому листингу веер писем — гарантированно
 * приучить человека их не читать, поэтому молчим и пишем `warn`.
 */
export const MAX_MISSING_ADS_PER_TARGET = 3;

/**
 * Сколько длится самый долгий живой захват.
 *
 * Захват держится от `updateMany` до ответа кабинета на отправку текста (модель зовут
 * до него, см. `repairRejectedAd`), то есть ровно один сетевой вызов с ретраями:
 * у Директа это три попытки с таймаутом в минуту на каждую, у VK — четыре попытки с
 * тем же таймаутом и паузами до 30 секунд, вместе меньше шести минут. Десять — тот же запас с той же
 * стороны: перебрать здесь значит подождать лишний тик, недобрать — снять захват с
 * живой отправки и отправить второй текст поверх первого.
 *
 * Величина не расписания, а сети: на смену крона она не реагирует и реагировать не
 * должна. Поэтому она отдельная константа, а не «столько же, сколько между запусками».
 */
export const REWRITING_APPLY_BUDGET_MINUTES = 10;

/**
 * Сколько строка имеет право числиться в `REWRITING`.
 *
 * Снимает захват один-единственный процесс — сам крон `check-moderation`, в начале
 * прогона. Отсюда обе границы:
 *
 *  • не меньше периода крона: срок короче тика не снимает захваты быстрее (снимать их
 *    всё равно некому до следующего прогона), зато рискует застать живую отправку
 *    соседнего прогона — тогда два прогона возьмутся за одно объявление;
 *  • не меньше `REWRITING_APPLY_BUDGET_MINUTES`: на частом кроне период перестаёт
 *    перекрывать саму отправку, и предыдущая граница уже ничего не гарантирует.
 *
 * Больше нужного тоже плохо: строка в `REWRITING` пропускается опросом безусловно, и
 * процесс, убитый между захватом и отправкой, выключает объявление из модерации на
 * весь этот срок. Поэтому — максимум из двух границ, а не запас поверх них.
 */
export const REWRITING_STALE_MINUTES = Math.max(
  MODERATION_TICK_MINUTES,
  REWRITING_APPLY_BUDGET_MINUTES,
);

export const REWRITING_STALE_MS = REWRITING_STALE_MINUTES * 60_000;

interface LocalAd {
  id: string;
  adGroupId: string;
  externalId: string;
  title: string;
  body: string;
  status: AdStatus;
  moderationStatus: ModerationStatus;
  moderationReason: string | null;
  moderationRetries: number;
  updatedAt: Date;
}

export interface PollOptions {
  now?: () => Date;
}

/**
 * Возвращает в `REJECTED` все зависшие захваты кабинета.
 *
 * Одним запросом по группам, а не внутри обхода объявлений кабинета: строка, чей
 * баннер уже удалён (у VK правка текста — это создание нового и удаление старого),
 * в листинге не появится никогда, а `REWRITING` опрос пропускает безусловно. Такая
 * строка выключена из модерации навсегда, и снять с неё захват больше нечем.
 *
 * Условие на `updatedAt` — в самом `where`: между чтением и записью мог начаться
 * другой прогон, и он имеет право на свою попытку.
 */
async function reclaimStale(
  db: ModerationDb,
  adGroupIds: readonly string[],
  before: Date,
): Promise<number> {
  const freed = await db.ad.updateMany({
    where: {
      adGroupId: { in: [...adGroupIds] },
      moderationStatus: ModerationStatus.REWRITING,
      updatedAt: { lt: before },
    },
    data: { moderationStatus: ModerationStatus.REJECTED },
  });
  return freed.count;
}

interface LocalGroup {
  id: string;
  externalId: string;
  campaignId: string;
  campaign: { name: string };
}

function key(adGroupId: string, externalId: string): string {
  // Разделитель — NUL: он не может встретиться ни в cuid, ни во внешнем id площадки.
  return `${adGroupId}\u0000${externalId}`;
}

function remoteText(ad: RemoteAd): AdText {
  const text: AdText = { title: ad.title, text: ad.text };
  if (ad.title2) text.title2 = ad.title2;
  return text;
}

/**
 * Строки, чьего объявления в листинге не оказалось.
 *
 * Три условия отсекают временное отсутствие от настоящей потери:
 *
 *  • группа, из которой не приехало ни одного объявления, не рассматривается вовсе —
 *    это тот же предохранитель, что у архивации в `ingestion/entities.ts`: пустой ответ
 *    по группе означает «до неё не доехало», а не «объявлений там нет»;
 *  • строка должна нести след нашей же попытки переписать (`REJECTED` и счётчик больше
 *    нуля). Внешний id теряется только в замене текста, которую делаем мы; объявление,
 *    которое мы не трогали, пропало из кабинета по воле клиента — это работа загрузки, а
 *    не повод писать человеку. Заодно отсекается только что созданное объявление: у него
 *    попыток нет;
 *  • живой захват (`REWRITING`) пропускаем: там прямо сейчас идёт замена, и у VK старого
 *    баннера в этот момент уже нет — нормальное состояние, а не пропажа.
 *
 * Выключенные строки не рассматриваются: они ничего не показывают и денег не тратят,
 * а уже отданная человеку строка помечена именно так (см. `escalateMissingAd`) — иначе
 * одно и то же письмо уходило бы каждые полчаса.
 */
function collectMissing(
  locals: readonly LocalAd[],
  groupById: ReadonlyMap<string, LocalGroup>,
  answeredGroupIds: ReadonlySet<string>,
  seenKeys: ReadonlySet<string>,
): MissingAd[] {
  const missing: MissingAd[] = [];
  for (const local of locals) {
    if (!answeredGroupIds.has(local.adGroupId)) continue;
    if (seenKeys.has(key(local.adGroupId, local.externalId))) continue;
    if (local.status !== AdStatus.ACTIVE) continue;
    if (local.moderationStatus !== ModerationStatus.REJECTED) continue;
    if (local.moderationRetries <= 0) continue;

    const group = groupById.get(local.adGroupId);
    if (!group) continue;
    missing.push({
      id: local.id,
      externalId: local.externalId,
      campaignId: group.campaignId,
      campaignName: group.campaign.name,
      retries: local.moderationRetries,
      reason: local.moderationReason ?? '',
      ad: { title: local.title, text: local.body },
    });
  }
  return missing;
}

/**
 * Обходит объявления одного кабинета и приводит `Ad.moderationStatus` к тому,
 * что говорит площадка.
 *
 * Прогон идемпотентен и безопасен при наложении на самого себя: все записи —
 * `updateMany` с условием на текущее состояние, а строки в статусе `REWRITING`
 * не трогаются вовсе. `REWRITING` означает «прямо сейчас другой прогон отправляет
 * туда новый текст»; перезаписать его вердиктом, полученным до отправки, — значит
 * потерять факт отправки и переписать объявление второй раз.
 *
 * Исключение — захват старше `REWRITING_STALE_MS`: такого прогона уже нет в живых
 * (процесс убит между захватом и отправкой), и строка возвращается в `REJECTED`.
 * Попытка при этом остаётся потраченной — счётчик сдвинут захватом, и обнулять его
 * нельзя: текст мог уйти в кабинет ровно перед падением.
 *
 * В переписывание идут только работающие объявления (`Ad.status`). Выключенное никому
 * не показывается, а починка стоит двух вызовов модели и нового баннера в кабинете.
 */
export async function pollAdModeration(
  db: ModerationDb,
  target: ModerationTarget,
  ctx: ChannelContext,
  adapter: ChannelAdapter,
  options: PollOptions = {},
): Promise<PollResult> {
  const result: PollResult = {
    polled: 0,
    updated: 0,
    orphaned: 0,
    reclaimed: 0,
    rejected: [],
    missing: [],
  };
  const now = options.now ?? ((): Date => new Date());
  const staleBefore = new Date(now().getTime() - REWRITING_STALE_MS);

  const groups: LocalGroup[] = await db.adGroup.findMany({
    where: { campaign: { clientId: target.clientId, provider: target.provider } },
    select: {
      id: true,
      externalId: true,
      campaignId: true,
      campaign: { select: { name: true } },
    },
  });
  if (groups.length === 0) return result;

  const groupByExternalId = new Map(groups.map((group) => [group.externalId, group]));
  const groupIds = groups.map((group) => group.id);

  // До похода в кабинет: зависший захват снимается независимо от того, отдаёт ли
  // площадка это объявление, — и, если листинг вообще не ответит, тоже.
  result.reclaimed = await reclaimStale(db, groupIds, staleBefore);

  const locals: LocalAd[] = await db.ad.findMany({
    where: { adGroupId: { in: groupIds } },
    select: {
      id: true,
      adGroupId: true,
      externalId: true,
      title: true,
      body: true,
      status: true,
      moderationStatus: true,
      moderationReason: true,
      moderationRetries: true,
      updatedAt: true,
    },
  });
  const localByKey = new Map(locals.map((ad) => [key(ad.adGroupId, ad.externalId), ad]));

  const remote = await adapter.listAds(ctx, [...groupByExternalId.keys()]);

  const answeredGroupIds = new Set<string>();
  const seenKeys = new Set<string>();

  for (const ad of remote) {
    const group = groupByExternalId.get(ad.adGroupExternalId);
    if (!group) {
      result.orphaned += 1;
      continue;
    }
    answeredGroupIds.add(group.id);
    seenKeys.add(key(group.id, ad.externalId));

    const local = localByKey.get(key(group.id, ad.externalId));
    if (!local) {
      result.orphaned += 1;
      continue;
    }

    result.polled += 1;

    // Захват не трогаем: прямо сейчас другой прогон отправляет туда текст. Зависшие
    // сняты до чтения строк, поэтому здесь остались только живые.
    if (local.moderationStatus === ModerationStatus.REWRITING) continue;

    const known = local.moderationStatus;
    const status = toModerationStatus(ad.moderationStatus);
    const reason = ad.moderationReason ?? null;

    if (status !== known || reason !== local.moderationReason) {
      const written = await db.ad.updateMany({
        where: { id: local.id, moderationStatus: { not: ModerationStatus.REWRITING } },
        data: {
          moderationStatus: status,
          moderationReason: reason,
          // Объявление приняли — прошлые отказы больше не в счёт, и следующая
          // правка текста снова получит все три попытки.
          ...(status === ModerationStatus.APPROVED ? { moderationRetries: 0 } : {}),
        },
      });
      if (written.count > 0) result.updated += 1;
    }

    if (status !== ModerationStatus.REJECTED) continue;
    if (local.status !== AdStatus.ACTIVE) continue;

    result.rejected.push({
      id: local.id,
      externalId: ad.externalId,
      campaignId: group.campaignId,
      campaignName: group.campaign.name,
      status: local.status,
      retries: local.moderationRetries,
      reason: reason ?? '',
      ad: remoteText(ad),
    });
  }

  const groupById = new Map(groups.map((group) => [group.id, group]));
  const missing = collectMissing(locals, groupById, answeredGroupIds, seenKeys);
  if (missing.length > MAX_MISSING_ADS_PER_TARGET) {
    log.warn(
      { ...target, missing: missing.length, limit: MAX_MISSING_ADS_PER_TARGET },
      'too many local ads absent from the listing, treating the listing as incomplete',
    );
  } else {
    result.missing = missing;
  }

  return result;
}
