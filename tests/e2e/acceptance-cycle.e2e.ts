import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  obliterateCycleQueues,
  registerSchedules,
  runAcceptance,
  seedDeliveredReport,
  seedLiveBase,
  seedRuns,
} from './support/acceptance-seed.js';
import { resetDatabase } from './support/database.js';

import {
  closeCycleConnections,
  collectCycleEvidence,
  cycleWindow,
  judgeCycle,
  judgeDay,
  renderCycleText,
  CYCLE_QUEUES,
} from '@/acceptance/index.js';
import { prisma } from '@/db/prisma.js';
import { QUEUE_NAMES, type QueueName } from '@/scheduler/queues.js';

/**
 * Приёмка ТЗ §9.6 на живых Postgres и Redis.
 *
 * Проверяется не «формула считает», а то, ради чего проверка написана: что она
 * не говорит «пройдено» там, где сказать нечего. Поэтому сценариев три и все три
 * — про молчание: пустая база, пустая история очередей и частичный прогон, где
 * часть кронов отработала, а часть нет. Именно на них отчёт врёт легче всего.
 *
 * История прогонов кладётся настоящими задачами через настоящий воркер BullMQ:
 * проверка читает `returnvalue` и `timestamp`, расставленные самим BullMQ.
 */

/** Сутки, за которые судим: вчерашние по МСК — первые полные для проверки. */
const DAY = cycleWindow(1)[0] as string;

/**
 * Предыдущие сутки. Пара прогонов там — не украшение сценария, а условие, при
 * котором вердикт вообще возможен: пока история не достаёт до начала проверяемых
 * суток, «крон молчал» неотличимо от «Redis подняли только что». На живом стенде
 * это то же самое, что «первые полные сутки — вторые по счёту после запуска».
 */
const DAY_BEFORE = cycleWindow(2)[0] as string;

/** Три очереди, которых хватает, чтобы показать разницу «отработал / не отработал». */
const TRIO: readonly QueueName[] = [
  QUEUE_NAMES.fetchStats,
  QUEUE_NAMES.optimizeBids,
  QUEUE_NAMES.dailyReport,
];

const HEALTHY: Record<string, Record<string, unknown>> = {
  [QUEUE_NAMES.fetchStats]: { targets: 1, ok: 1, statsWritten: 12, failures: [] },
  [QUEUE_NAMES.optimizeBids]: {
    campaigns: 1,
    autoApply: 0,
    failed: 0,
    applyFailed: 0,
    approvalsFailed: 0,
    approvalsUndelivered: 0,
    localStateFailed: 0,
  },
  [QUEUE_NAMES.dailyReport]: { clients: 1, sent: 1, skipped: 0, failures: [] },
};

async function judgeTrio(): Promise<ReturnType<typeof judgeDay>> {
  const [evidence] = await collectCycleEvidence({ dates: [DAY], queues: TRIO });
  if (!evidence) throw new Error('улики не собрались');
  return judgeDay(evidence);
}

afterAll(async () => {
  await closeCycleConnections();
});

describe('пустой стенд', () => {
  beforeAll(async () => {
    await resetDatabase();
    await obliterateCycleQueues();
  });

  it('ничего не знает и говорит именно это, а не «всё хорошо»', async () => {
    const verdict = await judgeTrio();

    expect(verdict.status).toBe('no-data');
    expect(verdict.status).not.toBe('passed');
    // Ни одна проверка не имеет права сказать «сорвано»: сказать нечего вовсе.
    expect(verdict.checks.filter((c) => c.status === 'fail')).toEqual([]);
    expect(verdict.checks.filter((c) => c.status === 'unknown').map((c) => c.id)).toContain(
      `cron:${QUEUE_NAMES.dailyReport}`,
    );
    expect(verdict.checks.find((c) => c.id === 'db:clients')?.status).toBe('unknown');
  });

  it('весь цикл целиком на пустом стенде не засчитывается', async () => {
    const evidence = await collectCycleEvidence({ dates: cycleWindow(3) });
    const cycle = judgeCycle(evidence.map(judgeDay), 3);
    expect(cycle.status).not.toBe('passed');
    expect(cycle.passed).toBe(0);
    expect(renderCycleText(cycle)).not.toContain('ПРОЙДЕН');
  });

  it('команда отделяет «не смог проверить» от обоих исходов отдельным кодом', async () => {
    const result = await runAcceptance(['--days', '1']);
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('НЕТ ДАННЫХ');
  });
});

describe('расписание есть, прогонов нет', () => {
  beforeAll(async () => {
    await resetDatabase();
    await obliterateCycleQueues();
    await registerSchedules(TRIO);
    const fixture = await seedLiveBase();
    await seedDeliveredReport(fixture.clientId, DAY);
  });

  it('подчищенная история — «нет данных», а не «сорвано»', async () => {
    const verdict = await judgeTrio();

    expect(verdict.status).toBe('no-data');
    for (const queue of TRIO) {
      const check = verdict.checks.find((c) => c.id === `cron:${queue}`);
      expect(check?.status).toBe('unknown');
      expect(check?.detail).toContain('история очереди не достаёт');
    }
  });
});

describe('частичный прогон: два крона из трёх', () => {
  beforeAll(async () => {
    await resetDatabase();
    await obliterateCycleQueues();
    await registerSchedules(TRIO);
    const fixture = await seedLiveBase();
    await seedDeliveredReport(fixture.clientId, DAY);

    await seedRuns(QUEUE_NAMES.fetchStats, DAY_BEFORE, {
      count: 2,
      result: HEALTHY[QUEUE_NAMES.fetchStats],
    });
    await seedRuns(QUEUE_NAMES.fetchStats, DAY, { result: HEALTHY[QUEUE_NAMES.fetchStats] });
    await seedRuns(QUEUE_NAMES.optimizeBids, DAY, { result: HEALTHY[QUEUE_NAMES.optimizeBids] });
    // `daily-report` не запускался вовсе.
  });

  it('сутки объявляются сорванными и называют молчащий крон', async () => {
    const verdict = await judgeTrio();

    expect(verdict.status).toBe('failed');
    const silent = verdict.checks.find((c) => c.id === `cron:${QUEUE_NAMES.dailyReport}`);
    expect(silent?.status).toBe('fail');
    expect(silent?.detail).toContain('0 из 1');
    // Отработавшие кроны при этом засчитаны — вердикт адресный, а не «всё плохо».
    expect(verdict.checks.find((c) => c.id === `cron:${QUEUE_NAMES.fetchStats}`)?.status).toBe(
      'pass',
    );
  });

  it('в тексте для человека срыв стоит в первой строке', async () => {
    const text = renderCycleText(judgeCycle([await judgeTrio()], 3));
    expect(text.split('\n')[0]).toContain('СОРВАН');
  });

  it('команда возвращает единицу, а не ноль: crontab читает код, а не текст', async () => {
    const result = await runAcceptance(['--days', '1', '--until', DAY]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('СОРВАН');
  });
});

describe('полные сутки', () => {
  beforeAll(async () => {
    await resetDatabase();
    await obliterateCycleQueues();
    await registerSchedules(CYCLE_QUEUES);
    const fixture = await seedLiveBase();
    await seedDeliveredReport(fixture.clientId, DAY);

    await seedRuns(QUEUE_NAMES.fetchStats, DAY_BEFORE, {
      count: 2,
      result: HEALTHY[QUEUE_NAMES.fetchStats],
    });
    for (const queue of CYCLE_QUEUES) {
      await seedRuns(queue, DAY, { result: summaryFor(queue) });
    }
  }, 180_000);

  it('засчитываются целиком', async () => {
    const [evidence] = await collectCycleEvidence({ dates: [DAY] });
    if (!evidence) throw new Error('улики не собрались');
    const verdict = judgeDay(evidence);

    expect(verdict.checks.filter((c) => c.status !== 'pass')).toEqual([]);
    expect(verdict.status).toBe('passed');
  });

  it('команда на здоровых сутках возвращает ноль и печатает «ПРОЙДЕН»', async () => {
    const result = await runAcceptance(['--days', '1', '--until', DAY]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('ПРОЙДЕН');
  });

  it('одна упавшая задача внутри тех же суток обнуляет вердикт', async () => {
    await seedRuns(QUEUE_NAMES.optimizeBids, DAY, {
      count: 1,
      result: null,
      failWith: 'ECONNREFUSED api.direct.yandex.com',
    });

    const [evidence] = await collectCycleEvidence({ dates: [DAY] });
    if (!evidence) throw new Error('улики не собрались');
    const verdict = judgeDay(evidence);

    expect(verdict.status).toBe('failed');
    expect(
      verdict.checks.find((c) => c.id === `cron:${QUEUE_NAMES.optimizeBids}`)?.detail,
    ).toContain('ECONNREFUSED');
  });

  it('запуск команды руками внутри суток виден как вмешательство', async () => {
    await prisma.auditLog.create({
      data: {
        actor: 'cli:credentials',
        action: 'credential.save',
        resource: 'credential:YANDEX_DIRECT:x',
        createdAt: new Date(new Date(`${DAY}T09:00:00.000Z`).getTime()),
      },
    });

    const [evidence] = await collectCycleEvidence({ dates: [DAY] });
    if (!evidence) throw new Error('улики не собрались');
    const verdict = judgeDay(evidence);

    expect(verdict.status).toBe('failed');
    expect(verdict.checks.find((c) => c.id === 'db:manual')?.detail).toContain('cli:credentials');
  });
});

/** Сводка, какую вернул бы обработчик на кабинете без происшествий. */
function summaryFor(queue: QueueName): Record<string, unknown> {
  const healthy = HEALTHY[queue];
  if (healthy) return healthy;
  switch (queue) {
    case QUEUE_NAMES.checkModeration:
      return { targets: 1, ok: 1, failures: [] };
    case QUEUE_NAMES.pauseLosers:
      return HEALTHY[QUEUE_NAMES.optimizeBids] as Record<string, unknown>;
    case QUEUE_NAMES.refreshTokens:
      return { checked: 1, refreshed: 0, failures: [] };
    case QUEUE_NAMES.evaluateAbTests:
      return { adGroups: 0, failed: 0, approvalsFailed: 0, unbuildable: 0 };
    default:
      return {};
  }
}
