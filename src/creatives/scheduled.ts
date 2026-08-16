import { createHash } from 'node:crypto';

import { AdGroupStatus, CampaignStatus, ClientStatus, Prisma, type Provider } from '@prisma/client';

import { evaluateAdExperiment, type AdExperiment } from './ab/experiment.js';
import type { AbTestConfig } from './ab/select.js';

import { createApproval, type ApprovalAction } from '@/approval/index.js';
import { prisma } from '@/db/prisma.js';
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

const IDEMPOTENCY_SCOPE = 'creatives:ab';
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
  /** Групп, похожих на эксперимент (два и более объявления). */
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

  const groups = await prisma.adGroup.findMany({
    where: {
      status: AdGroupStatus.ACTIVE,
      campaign: {
        status: CampaignStatus.ACTIVE,
        // Клиент на паузе или в архиве не должен получать карточки на свои кампании.
        client: { status: ClientStatus.ACTIVE },
        ...(options.clientId ? { clientId: options.clientId } : {}),
      },
    },
    select: {
      id: true,
      name: true,
      campaign: { select: { clientId: true, provider: true } },
      _count: { select: { ads: true } },
    },
  });

  const candidates = groups.filter((g) => g._count.ads >= MIN_ADS_IN_EXPERIMENT);

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
      log.error({ adGroupId: group.id, err: describeError(err) }, 'A/B evaluation failed');
      continue;
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
      const outcome = await requestLoserPause(experiment, group, {
        dryRun: options.dryRun,
        idempotency,
      });
      summary.approvals += outcome.created;
      summary.approvalsDuplicate += outcome.duplicate;
      summary.unbuildable += outcome.unbuildable;
    } catch (err) {
      summary.approvalsFailed += 1;
      log.error(
        { adGroupId: group.id, err: describeError(err) },
        'failed to create A/B approval card',
      );
    }
  }

  log.info({ ...summary, dryRun: options.dryRun }, 'creative A/B evaluation finished');
  return summary;
}

interface GroupRow {
  id: string;
  name: string;
  campaign: { clientId: string; provider: Provider };
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
 * Паузим объявления, а не варианты: у площадки нет понятия «вариант текста», и один
 * вариант обычно живёт в нескольких объявлениях группы. Победитель в список не попадает
 * никогда — иначе тест выключил бы ровно тот текст, ради которого проводился.
 */
async function requestLoserPause(
  experiment: AdExperiment,
  group: GroupRow,
  deps: PauseDeps,
): Promise<PauseOutcome> {
  const winner = experiment.decision.winner;
  if (winner === null) return { created: 0, duplicate: 0, unbuildable: 1 };

  const loserAdIds = [...experiment.adsByVariant]
    .filter(([variantId]) => variantId !== winner)
    .flatMap(([, adIds]) => adIds);
  if (loserAdIds.length === 0) return { created: 0, duplicate: 0, unbuildable: 1 };

  const rows = await prisma.ad.findMany({
    where: { id: { in: loserAdIds } },
    select: { id: true, externalId: true },
  });
  // Сортировка не косметика: порядок строк из БД не гарантирован, а по этому списку
  // считается ключ идемпотентности — при другом порядке он дал бы вторую карточку.
  const externalIds = [...new Set(rows.map((row) => row.externalId).filter(Boolean))].sort();
  if (externalIds.length === 0) {
    log.warn(
      { adGroupId: group.id, losers: loserAdIds.length },
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
      `На паузу уходят проигравшие варианты: объявлений — ${externalIds.length}.`,
  };

  const key = abApprovalIdempotencyKey(group.id, winner, externalIds);
  if ((await deps.idempotency.reserve(key, group.id)) === 'duplicate') {
    log.info({ adGroupId: group.id, key }, 'A/B approval card already sent');
    return { created: 0, duplicate: 1, unbuildable: 0 };
  }

  try {
    await createApproval(action, { dryRun: deps.dryRun });
    return { created: 1, duplicate: 0, unbuildable: 0 };
  } catch (err) {
    // Карточки нет — держать ключ занятым нельзя, иначе завтрашний прогон промолчит
    // и человек так и не узнает про победителя.
    await deps.idempotency.release(key);
    throw err;
  }
}

/**
 * Ключ карточки: группа + победитель + адресаты паузы.
 *
 * Даты в ключе намеренно нет, в отличие от оптимизатора (`optimizer/scheduled.ts`).
 * Там решение пересчитывается каждые сутки и назавтра оно другое, здесь — то же самое:
 * победитель, определённый вчера, останется победителем и завтра, и послезавтра. С
 * посуточным ключом клиент получал бы одну и ту же карточку каждую ночь, пока не нажмёт
 * кнопку. Меняется набор объявлений или победитель — меняется и ключ, карточка уйдёт.
 *
 * По той же причине в ключ не входит текст заявки: в нём CTR и p-value, а они дрейфуют
 * от прогона к прогону, не меняя сути решения.
 */
export function abApprovalIdempotencyKey(
  adGroupId: string,
  winnerVariantId: string,
  externalIds: readonly string[],
): string {
  const digest = createHash('sha1')
    .update([winnerVariantId, ...externalIds].join('\n'))
    .digest('hex')
    .slice(0, 16);
  return `${IDEMPOTENCY_SCOPE}:${adGroupId}:${digest}`;
}

interface AbIdempotencyStore {
  reserve(key: string, adGroupId: string): Promise<'reserved' | 'duplicate'>;
  release(key: string): Promise<void>;
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
 */
function createAbIdempotencyStore(
  db: Pick<typeof prisma, 'idempotencyKey'> = prisma,
): AbIdempotencyStore {
  return {
    async reserve(key: string, adGroupId: string): Promise<'reserved' | 'duplicate'> {
      try {
        await db.idempotencyKey.create({
          data: {
            key,
            scope: IDEMPOTENCY_SCOPE,
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
    async release(key: string): Promise<void> {
      await db.idempotencyKey.deleteMany({ where: { key } });
    },
  };
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
