import { ClientStatus, type Provider } from '@prisma/client';

import { registeredChannels } from '@/channels/registry.js';
import { describeError } from '@/lib/errors.js';
import { logger } from '@/logger.js';
import { resolveDeps, type ModerationDb, type ModerationDeps } from '@/moderation/deps.js';
import { describeFailure, recordFailure, type ModerationFailure } from '@/moderation/errors.js';
import {
  pollAdModeration,
  type MissingAd,
  type ModerationTarget,
  type RejectedAd,
} from '@/moderation/poll.js';
import { escalateMissingAd, repairRejectedAd, type RepairContext } from '@/moderation/repair.js';
import { RULES_COUNT } from '@/moderation/rules.js';

const log = logger.child({ scope: 'moderation:run' });

/**
 * Крон `check-moderation` целиком: TZ §13.4. Период — в `scheduler/schedule.ts`.
 *
 * Кабинеты обходятся последовательно и независимо — протухший токен одного клиента
 * не должен лишить проверки всех остальных, поэтому отказ пишется в `ErrorLog`,
 * попадает в сводку и прогон идёт дальше. То же правило действует на уровне
 * объявления: одно упавшее переписывание не отменяет остальные.
 *
 * Наложение прогонов безопасно: обновления статусов идут `updateMany` с условием на
 * текущее состояние, а отправка нового текста защищена атомарным захватом строки
 * (см. `repairRejectedAd`).
 */

/**
 * Потолок переписываний за один тик.
 *
 * Каждое — это два вызова модели и одна операция в кабинете. Кабинет, где разом
 * отклонили сотню объявлений, обычно означает системную проблему (сломался сайт,
 * кончилась лицензия), и сто вызовов подряд её не решат, а деньги потратят.
 */
export const MAX_REPAIRS_PER_RUN = 20;

export interface RunModerationOptions extends Partial<ModerationDeps> {
  /** Ограничить прогон одним клиентом — используется при ручном запуске из CLI. */
  clientId?: string;
  channels?: () => Provider[];
  maxRepairs?: number;
}

export interface ModerationRunSummary {
  targets: number;
  /** Кабинетов, прошедших без единого отказа. */
  ok: number;
  adsPolled: number;
  statusUpdated: number;
  /** Строк, снятых с зависшего `REWRITING`. Ненулевое — след упавшего прогона. */
  reclaimed: number;
  /** Строк, чьего объявления нет в листинге кабинета: по каждой позвали человека. */
  missing: number;
  rejected: number;
  rewritten: number;
  /** Посчитано и показано планом, но не отправлено из-за dry-run. */
  planned: number;
  /**
   * Отклонённых объявлений, по которым предпросмотр в dry-run уже показывали и с
   * тех пор ничего не изменилось: модель не звали. Ненулевое — это норма при
   * включённом DRY_RUN, а не признак застоя.
   */
  unchanged: number;
  escalated: number;
  skipped: number;
  /**
   * Объявления, отставленные после упавшей починки (`REPAIR_BACKOFF_MINUTES`).
   * Ненулевое — это не застой, а очередь: слот потолка ушёл соседнему отказу.
   */
  backedOff: number;
  /** Отклонённые объявления, до которых прогон не дошёл из-за потолка. */
  deferred: number;
  rulesCount: number;
  failures: ModerationFailure[];
}

/**
 * Кабинеты, которые есть смысл опрашивать: активный клиент, сохранённые секреты и
 * зарегистрированный адаптер канала.
 *
 * Список тот же, что у загрузки статистики, но своя функция: `ModerationDb` — это
 * шесть моделей, а не весь `PrismaClient`, и ради общей строки не хочется тащить
 * в модуль всю схему.
 */
export async function listModerationTargets(
  db: ModerationDb,
  options: Pick<RunModerationOptions, 'clientId' | 'channels'> = {},
): Promise<ModerationTarget[]> {
  const known = new Set((options.channels ?? registeredChannels)());
  const rows = await db.credential.findMany({
    where: {
      client: { status: ClientStatus.ACTIVE },
      ...(options.clientId ? { clientId: options.clientId } : {}),
    },
    select: { clientId: true, provider: true },
    orderBy: [{ clientId: 'asc' }, { provider: 'asc' }],
  });
  return rows.filter((row) => known.has(row.provider));
}

export async function runModerationCheck(
  options: RunModerationOptions = {},
): Promise<ModerationRunSummary> {
  const { clientId, channels, maxRepairs, ...depsPatch } = options;
  const deps = resolveDeps(depsPatch);
  const budget = maxRepairs ?? MAX_REPAIRS_PER_RUN;

  const targetOptions: Pick<RunModerationOptions, 'clientId' | 'channels'> = {};
  if (clientId !== undefined) targetOptions.clientId = clientId;
  if (channels !== undefined) targetOptions.channels = channels;
  const targets = await listModerationTargets(deps.db, targetOptions);

  const summary: ModerationRunSummary = {
    targets: targets.length,
    ok: 0,
    adsPolled: 0,
    statusUpdated: 0,
    reclaimed: 0,
    missing: 0,
    rejected: 0,
    rewritten: 0,
    planned: 0,
    unchanged: 0,
    escalated: 0,
    skipped: 0,
    backedOff: 0,
    deferred: 0,
    rulesCount: RULES_COUNT,
    failures: [],
  };

  let repairsLeft = budget;

  for (const target of targets) {
    const before = summary.failures.length;
    repairsLeft = await checkTarget(deps, target, summary, repairsLeft);
    if (summary.failures.length === before) summary.ok += 1;
  }

  log.info(
    {
      targets: summary.targets,
      ok: summary.ok,
      missing: summary.missing,
      rejected: summary.rejected,
      rewritten: summary.rewritten,
      escalated: summary.escalated,
      failures: summary.failures.length,
    },
    'moderation check finished',
  );
  return summary;
}

async function checkTarget(
  deps: ModerationDeps,
  target: ModerationTarget,
  summary: ModerationRunSummary,
  repairsLeft: number,
): Promise<number> {
  let rejected: RejectedAd[];
  let missing: MissingAd[];
  let rc: RepairContext;

  try {
    const adapter = deps.adapterFor(target.provider);
    const ctx = await deps.contextFor(target.clientId, target.provider);
    const poll = await pollAdModeration(deps.db, target, ctx, adapter, { now: deps.now });

    summary.adsPolled += poll.polled;
    summary.statusUpdated += poll.updated;
    summary.reclaimed += poll.reclaimed;
    summary.rejected += poll.rejected.length;
    rejected = poll.rejected;
    missing = poll.missing;

    rc = { deps, target, ctx, adapter, client: await loadClient(deps, target.clientId) };
  } catch (err) {
    await fail(deps, target, 'poll', err, summary);
    return repairsLeft;
  }

  // Потерянные строки идут до починок и мимо потолка: письмо не стоит ни вызова модели,
  // ни операции в кабинете, а их число само по себе ограничено (`MAX_MISSING_ADS_PER_TARGET`).
  for (const ad of missing) {
    try {
      const outcome = await escalateMissingAd(rc, ad);
      tally(summary, outcome);
      if (outcome.status === 'escalated') summary.missing += 1;
    } catch (err) {
      await fail(deps, target, `missing:${ad.id}`, err, summary);
    }
  }

  let left = repairsLeft;
  for (const ad of rejected) {
    if (left <= 0) {
      summary.deferred += 1;
      continue;
    }
    try {
      const outcome = await repairRejectedAd(rc, ad);
      tally(summary, outcome);
      // Потолок считает работу, а не строки. `skipped` — это объявление, которое уже
      // отдано человеку или захвачено соседним прогоном: ни вызова модели, ни операции
      // в кабинете. Списывать за него бюджет значило бы отдать весь потолок застрявшим
      // объявлениям (порядок `listAds` стабилен, так что тем же самым каждый прогон),
      // а свежие отказы откладывать до бесконечности.
      // `unchanged` в этом смысле то же самое: предпросмотр уже показан, модель не
      // звали, в кабинет не ходили — работы не было. `backoff` — тем более: это
      // объявление уступает очередь как раз потому, что на нём починка падает.
      if (
        outcome.status !== 'skipped' &&
        outcome.status !== 'unchanged' &&
        outcome.status !== 'backoff'
      ) {
        left -= 1;
      }
    } catch (err) {
      // Одно объявление не чинится — остальные в этом же кабинете чинятся.
      left -= 1;
      await fail(deps, target, `repair:${ad.id}`, err, summary);
    }
  }
  return left;
}

function tally(
  summary: ModerationRunSummary,
  outcome: Awaited<ReturnType<typeof repairRejectedAd>>,
): void {
  switch (outcome.status) {
    case 'rewritten':
      summary.rewritten += 1;
      return;
    case 'planned':
      summary.planned += 1;
      return;
    case 'escalated':
      summary.escalated += 1;
      return;
    case 'unchanged':
      summary.unchanged += 1;
      return;
    case 'backoff':
      summary.backedOff += 1;
      return;
    default:
      summary.skipped += 1;
  }
}

async function loadClient(
  deps: ModerationDeps,
  clientId: string,
): Promise<{ name: string; chatId: string }> {
  const row = await deps.db.client.findUnique({
    where: { id: clientId },
    select: { name: true, tgUserId: true },
  });
  // Клиента без строки в БД не бывает: цель прогона взята из его же Credential.
  // Но письмо человеку важнее аккуратного имени, поэтому падать здесь нечем.
  return { name: row?.name ?? clientId, chatId: row ? row.tgUserId.toString() : '' };
}

async function fail(
  deps: ModerationDeps,
  target: ModerationTarget,
  stage: string,
  err: unknown,
  summary: ModerationRunSummary,
): Promise<void> {
  const failure = describeFailure(target.clientId, target.provider, stage, err);
  summary.failures.push(failure);
  log.error({ ...failure, err: describeError(err) }, 'moderation stage failed');
  await recordFailure(deps.db, failure);
}
