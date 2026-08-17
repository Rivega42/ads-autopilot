import { createHash } from 'node:crypto';

import { AdGroupStatus, CampaignStatus, ClientStatus, Prisma, type Provider } from '@prisma/client';

import { evaluateAdExperiment, type AdExperiment } from './ab/experiment.js';
import { losingVariantIds, type AbTestConfig } from './ab/select.js';

import { approvalActionSchema, createApproval, type ApprovalAction } from '@/approval/index.js';
import { prisma } from '@/db/prisma.js';
import { env } from '@/env.js';
import { describeError } from '@/lib/errors.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'creatives.scheduled' });

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Окно наблюдения A/B-теста.
 *
 * Оно обязано быть длиннее `maxCollectingDays` (14 дней в DEFAULT_AB_TEST): при коротком
 * окне показы, набранные в начале теста, выпадают из счёта, вариант никогда не добирает
 * своих 500 показов, и эксперимент вечно висит в «данные набираются» — ровно до тех пор,
 * пока не сработает таймаут сбора и человек не получит «решайте сами» без единой цифры.
 */
export const AB_WINDOW_DAYS = 30;

/** Одно объявление — это не эксперимент. Сравнивать не с чем, статистику не запрашиваем. */
const MIN_ADS_IN_EXPERIMENT = 2;

/**
 * С какого числа кандидатов прогон стоит считать долгим.
 *
 * Жёсткого потолка здесь намеренно нет: обрезать список значит навсегда оставить хвост
 * групп без оценки и молча — а молчание тут неотличимо от «победителей не нашлось».
 * Вместо потолка — предупреждение в лог, по которому видно, что пора укладывать
 * оценку в пакетные запросы.
 */
const SLOW_RUN_CANDIDATES = 500;

const IDEMPOTENCY_SCOPE = 'creatives:ab';
/**
 * Прогон в dry-run занимает собственный ключ.
 *
 * DRY_RUN включён по умолчанию везде. С общим ключом неделя прогонов «вхолостую»
 * забирала бы ключ боевого решения, и после перехода на DRY_RUN=false карточка по этим
 * группам не пришла бы уже никогда: ключ живёт до решения человека, а решения не было.
 */
const DRY_RUN_SCOPE = 'creatives:ab:dry-run';
const AB_SCOPES = [IDEMPOTENCY_SCOPE, DRY_RUN_SCOPE] as const;
const KEY_TTL_DAYS = 30;

export interface AbEvaluationOptions {
  /** Только этот клиент. Пусто — все активные. */
  clientId?: string;
  dryRun: boolean;
  now?: Date;
  windowDays?: number;
  config?: AbTestConfig;
}

export interface AbEvaluationSummary {
  /** Групп, похожих на эксперимент (два и более наших варианта). */
  adGroups: number;
  collecting: number;
  inconclusive: number;
  /** Объявлений много, а вариант один: тестировать нечего. */
  singleVariant: number;
  winners: number;
  approvals: number;
  /** Карточка по этому решению уже уходила человеку — второй раз не шлём. */
  approvalsDuplicate: number;
  approvalsFailed: number;
  /** Победитель есть, но проигравших не к чему адресовать: карточка не собралась. */
  unbuildable: number;
  failed: number;
}

/**
 * Суточная оценка A/B-тестов креативов (TZ §13.3).
 *
 * Чаще раза в сутки смысла нет: решение принимается по накопленным показам, а они за час
 * не меняют картину — зато каждый прогон это запрос статистики по каждой группе.
 *
 * Эксперимент — это только те группы, где не меньше двух НАШИХ вариантов (`Ad.llmVariant`).
 * Рукописные объявления клиента и всё, что приехало через ingestion (TZ §15), кандидатами
 * не становятся: предлагать человеку выключить объявления, которых система не писала, она
 * права не имеет.
 *
 * Результат «есть победитель» превращается в заявку на паузу проигравших вариантов, и
 * уходит она человеку карточкой, а не в кабинет напрямую. Причина не в осторожности
 * вообще, а в цене ошибки: выключенное объявление перестаёт собирать показы, то есть
 * ошибочная пауза не исправляется следующим прогоном — вариант больше никогда не наберёт
 * данных, чтобы себя оправдать. Плюс это ровно тот случай из TZ §3.5, где решение
 * касается LLM-креативов.
 *
 * Падение на одной группе не останавливает остальные: у одного клиента может протухнуть
 * токен, и это не повод оставить без оценки все эксперименты сразу.
 */
export async function runAbEvaluation(options: AbEvaluationOptions): Promise<AbEvaluationSummary> {
  const now = options.now ?? new Date();
  const windowDays = options.windowDays ?? AB_WINDOW_DAYS;
  // Границы — календарные даты: колонка `CampaignStat.date` объявлена как @db.Date,
  // и сравнение с моментом времени внутри суток отрезало бы сегодняшнюю строку.
  const to = startOfUtcDay(now);
  const from = new Date(to.getTime() - (windowDays - 1) * DAY_MS);
  // Формула та же, что в `approval/create.ts#effectiveDryRun`: карточка уйдёт именно в
  // этом режиме, а от режима зависит, какой ключ она занимает.
  const dryRun = env.DRY_RUN || options.dryRun;

  const candidates = await findExperimentGroups(options.clientId);

  const summary: AbEvaluationSummary = {
    adGroups: candidates.length,
    collecting: 0,
    inconclusive: 0,
    singleVariant: 0,
    winners: 0,
    approvals: 0,
    approvalsDuplicate: 0,
    approvalsFailed: 0,
    unbuildable: 0,
    failed: 0,
  };

  const idempotency = createAbIdempotencyStore();

  for (const group of candidates) {
    // clientId и provider в каждой строке: типичная причина падения — протухший токен
    // конкретного кабинета, а по одному adGroupId в алерте непонятно, чей он.
    const ctx = {
      adGroupId: group.id,
      clientId: group.campaign.clientId,
      provider: group.campaign.provider,
    };

    let experiment: AdExperiment;
    try {
      experiment = await evaluateAdExperiment(group.id, {
        from,
        to,
        db: prisma,
        ...(options.config ? { config: options.config } : {}),
      });
    } catch (err) {
      summary.failed += 1;
      log.error({ ...ctx, err: describeError(err) }, 'A/B evaluation failed');
      continue;
    }

    if (experiment.adsWithoutStats.length > 0) {
      log.warn(
        { ...ctx, ads: experiment.adsWithoutStats.length, windowDays },
        'ads in experiment have no stats for the whole window',
      );
    }

    const { decision } = experiment;
    if (decision.status === 'collecting') {
      summary.collecting += 1;
      continue;
    }
    if (decision.status !== 'winner') {
      if (decision.reasonCode === 'NOT_ENOUGH_VARIANTS') summary.singleVariant += 1;
      else summary.inconclusive += 1;
      continue;
    }

    summary.winners += 1;
    try {
      const outcome = await requestLoserPause(experiment, group, { dryRun, idempotency });
      summary.approvals += outcome.created;
      summary.approvalsDuplicate += outcome.duplicate;
      summary.unbuildable += outcome.unbuildable;
    } catch (err) {
      summary.approvalsFailed += 1;
      log.error({ ...ctx, err: describeError(err) }, 'failed to create A/B approval card');
    }
  }

  log.info({ ...summary, dryRun }, 'creative A/B evaluation finished');
  return summary;
}

interface GroupRow {
  id: string;
  name: string;
  campaign: { clientId: string; provider: Provider };
}

/**
 * Группы, похожие на эксперимент.
 *
 * Отбор делает Postgres, а не память процесса: раньше сюда приезжали все активные группы
 * всех клиентов, и `_count.ads >= 2` считался уже здесь — на кабинете с тысячей групп это
 * тысяча лишних строк и столько же ненужных обходов.
 */
async function findExperimentGroups(clientId?: string): Promise<GroupRow[]> {
  const grouped = await prisma.ad.groupBy({
    by: ['adGroupId'],
    where: {
      llmVariant: { not: null },
      adGroup: {
        status: AdGroupStatus.ACTIVE,
        campaign: {
          status: CampaignStatus.ACTIVE,
          // Клиент на паузе или в архиве не должен получать карточки на свои кампании.
          client: { status: ClientStatus.ACTIVE },
          ...(clientId ? { clientId } : {}),
        },
      },
    },
    _count: { _all: true },
    having: { adGroupId: { _count: { gte: MIN_ADS_IN_EXPERIMENT } } },
  });

  if (grouped.length === 0) return [];
  if (grouped.length >= SLOW_RUN_CANDIDATES) {
    log.warn({ candidates: grouped.length }, 'A/B evaluation run is getting large');
  }

  return prisma.adGroup.findMany({
    where: { id: { in: grouped.map((row) => row.adGroupId) } },
    select: {
      id: true,
      name: true,
      campaign: { select: { clientId: true, provider: true } },
    },
  });
}

interface PauseOutcome {
  created: number;
  duplicate: number;
  unbuildable: number;
}

interface PauseDeps {
  dryRun: boolean;
  idempotency: AbIdempotencyStore;
}

/**
 * Заявка на паузу проигравших вариантов.
 *
 * Проигравшие — те, кого сравнили с победителем и кто уступил (`losingVariantIds`), а не
 * «все остальные». Вариант, не набравший минимума показов, в сравнении не участвовал:
 * выключить его значит закрыть ему единственный путь набрать данные.
 *
 * Паузим объявления, а не варианты: у площадки нет понятия «вариант текста», и один
 * вариант обычно живёт в нескольких объявлениях группы.
 */
async function requestLoserPause(
  experiment: AdExperiment,
  group: GroupRow,
  deps: PauseDeps,
): Promise<PauseOutcome> {
  const losers = losingVariantIds(experiment.decision);
  const loserAdIds = losers.flatMap((variantId) => experiment.adsByVariant.get(variantId) ?? []);
  if (loserAdIds.length === 0) return { created: 0, duplicate: 0, unbuildable: 1 };

  const rows = await prisma.ad.findMany({
    where: { id: { in: loserAdIds } },
    select: { id: true, externalId: true, title: true },
  });
  // Заголовки берём только у адресатов паузы: объявление без внешнего id в карточку
  // не попадёт, и называть его человеку значит обещать то, чего не произойдёт.
  const addressed = rows.filter((row) => row.externalId.length > 0);
  const externalIds = normalizeExternalIds(addressed.map((row) => row.externalId));
  if (externalIds.length === 0) {
    log.warn(
      { adGroupId: group.id, clientId: group.campaign.clientId, losers: loserAdIds.length },
      'A/B winner found, but losing ads have no external ids',
    );
    return { created: 0, duplicate: 0, unbuildable: 1 };
  }

  const action: ApprovalAction = {
    kind: 'pause_entities',
    clientId: group.campaign.clientId,
    channel: group.campaign.provider,
    level: 'ad',
    externalIds,
    reason:
      `A/B-тест группы «${group.name}». ${experiment.decision.reason} ` +
      `На паузу уходят проигравшие объявления (${externalIds.length}): ` +
      `${listTitles(addressed.map((row) => row.title))}.`,
  };

  const key = abApprovalIdempotencyKey(group.id, externalIds, { dryRun: deps.dryRun });
  if ((await deps.idempotency.reserve(key, group.id, deps.dryRun)) === 'duplicate') {
    log.info({ adGroupId: group.id, clientId: group.campaign.clientId }, 'A/B card already sent');
    return { created: 0, duplicate: 1, unbuildable: 0 };
  }

  try {
    await createApproval(action, { dryRun: deps.dryRun });
    return { created: 1, duplicate: 0, unbuildable: 0 };
  } catch (err) {
    // Карточки нет — держать ключ занятым нельзя, иначе завтрашний прогон промолчит
    // и человек так и не узнает про победителя.
    await deps.idempotency.release([key]);
    throw err;
  }
}

/** Заголовки объявлений для карточки: человек должен узнать текст, а не cuid. */
function listTitles(titles: readonly string[]): string {
  const unique = [...new Set(titles.filter((title) => title.trim().length > 0))];
  const shown = unique.slice(0, 3).map((title) => `«${title}»`);
  const rest = unique.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} и ещё ${rest}` : shown.join(', ');
}

/** Порядок и дубли не должны менять ключ: иначе та же заявка даст вторую карточку. */
function normalizeExternalIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => id.length > 0))].sort();
}

/**
 * Ключ карточки: режим + группа + адресаты паузы.
 *
 * Даты в ключе намеренно нет, в отличие от оптимизатора (`optimizer/scheduled.ts`).
 * Там решение пересчитывается каждые сутки и назавтра оно другое, здесь — то же самое:
 * победитель, определённый вчера, останется победителем и завтра, и послезавтра. С
 * посуточным ключом клиент получал бы одну и ту же карточку каждую ночь, пока не нажмёт
 * кнопку.
 *
 * Победителя в ключе нет по другой причине: ключ обязан опознавать ПРЕДЛАГАЕМОЕ
 * ДЕЙСТВИЕ, а действие — это «выключить вот эти объявления». Две заявки на один и тот же
 * набор объявлений — одна и та же заявка, чем бы её ни объясняли. Заодно такой ключ
 * пересчитывается из самой карточки, и `releaseAbApprovalKeys` умеет его освободить,
 * когда карточка истекла.
 */
export function abApprovalIdempotencyKey(
  adGroupId: string,
  externalIds: readonly string[],
  opts: { dryRun: boolean },
): string {
  const digest = createHash('sha1')
    .update(normalizeExternalIds(externalIds).join('\u0000'))
    .digest('hex')
    .slice(0, 16);
  return `${opts.dryRun ? DRY_RUN_SCOPE : IDEMPOTENCY_SCOPE}:${adGroupId}:${digest}`;
}

/**
 * Освобождение ключа истёкшей карточки.
 *
 * Вешается на крон экспирации (`scheduler/handlers.ts`). Без этого решение теряется
 * навсегда: ключ занят до решения человека, а решения не будет — карточка ушла в EXPIRED
 * ночью, человек открыл телефон утром, и следующий прогон промолчит, потому что «уже
 * отправляли». Освобождённый ключ означает ровно одно: завтра спросим ещё раз.
 *
 * Оба режима чистятся вместе: dry-run-ключ на ту же группу после истечения карточки
 * не защищает уже ничего.
 *
 * @returns сколько ключей освобождено.
 */
export async function releaseAbApprovalKeys(approval: {
  id: string;
  payload: unknown;
}): Promise<number> {
  const parsed = approvalActionSchema.safeParse(approval.payload);
  if (!parsed.success) return 0;
  const action = parsed.data;
  if (action.kind !== 'pause_entities' || action.level !== 'ad') return 0;

  const externalIds = normalizeExternalIds(action.externalIds);
  if (externalIds.length === 0) return 0;

  // Группу берём из объявлений: в карточке живут только внешние id площадки.
  const ads = await prisma.ad.findMany({
    where: { externalId: { in: [...externalIds] } },
    select: { adGroupId: true },
  });
  const adGroupIds = [...new Set(ads.map((row) => row.adGroupId))];
  if (adGroupIds.length === 0) return 0;

  const keys = adGroupIds.flatMap((adGroupId) => [
    abApprovalIdempotencyKey(adGroupId, externalIds, { dryRun: false }),
    abApprovalIdempotencyKey(adGroupId, externalIds, { dryRun: true }),
  ]);
  const released = await createAbIdempotencyStore().release(keys);
  if (released > 0) {
    log.info(
      { approvalId: approval.id, adGroupIds, released },
      'A/B idempotency keys released on expiry',
    );
  }
  return released;
}

interface AbIdempotencyStore {
  reserve(key: string, adGroupId: string, dryRun: boolean): Promise<'reserved' | 'duplicate'>;
  release(keys: readonly string[]): Promise<number>;
}

/**
 * Резервирование через `IdempotencyKey`.
 *
 * Своя копия, а не `createPrismaIdempotencyStore` из оптимизатора: тот пишет в строку
 * `scope: 'optimizer'` и пустые `entityType`/`entityId`. Колонки существуют ровно затем,
 * чтобы по таблице было видно, кто и что зарезервировал, и заполнять их чужим именем
 * хуже, чем повторить пять строк.
 *
 * Уникальность обеспечивает Postgres, а не проверка «сначала прочитать»: два воркера
 * иначе оба увидели бы пусто и оба отправили бы карточку.
 *
 * `expiresAt` не декоративен: просроченные строки удаляет крон экспирации
 * (`scheduler/purge.ts`), поэтому TTL здесь — настоящий срок жизни ключа.
 */
function createAbIdempotencyStore(
  db: Pick<typeof prisma, 'idempotencyKey'> = prisma,
): AbIdempotencyStore {
  return {
    async reserve(key: string, adGroupId: string, dryRun: boolean) {
      try {
        await db.idempotencyKey.create({
          data: {
            key,
            scope: dryRun ? DRY_RUN_SCOPE : IDEMPOTENCY_SCOPE,
            entityType: 'ADGROUP',
            entityId: adGroupId,
            expiresAt: new Date(Date.now() + KEY_TTL_DAYS * DAY_MS),
          },
        });
        return 'reserved';
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          return 'duplicate';
        }
        throw err;
      }
    },
    async release(keys: readonly string[]): Promise<number> {
      // deleteMany, а не delete: освобождение зовут по пути ошибки и по истечении
      // карточки, и «строки уже нет» там нормальный исход, а не новость.
      const { count } = await db.idempotencyKey.deleteMany({
        where: { key: { in: [...keys] }, scope: { in: [...AB_SCOPES] } },
      });
      return count;
    },
  };
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
