import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { http, HttpResponse } from 'msw';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { E2E_DATABASE_URL, E2E_ENCRYPTION_KEY } from './support/config.js';
import { resetDatabase } from './support/database.js';
import { runAt, seedAccount, type Fixture } from './support/seed.js';
import { createTelegramMock, type TelegramMock } from './support/telegram-mock.js';
import { createYandexApiMock, type YandexApiMock } from './support/yandex-api-mock.js';

import { setMessenger } from '@/approval/index.js';
import { bootstrapChannels } from '@/channels/bootstrap.js';
import { resetYandexRuntimeState } from '@/clients/yandex-direct/http.js';
import { prisma } from '@/db/prisma.js';
import { runScheduledOptimization } from '@/optimizer/index.js';
import { detectAlerts } from '@/reporter/index.js';

const YANDEX_BASE = 'https://api-sandbox.direct.yandex.com/json/v5';

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const probe = fileURLToPath(new URL('./support/prisma-log-probe.ts', import.meta.url));

interface ProbeResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Весь вывод отдельного процесса — единственный способ спросить «что увидел человек». */
async function runProbe(mode: string, envOver: Record<string, string>): Promise<ProbeResult> {
  const env = {
    ...process.env,
    DATABASE_URL: E2E_DATABASE_URL,
    CREDENTIALS_ENCRYPTION_KEY: E2E_ENCRYPTION_KEY,
    NODE_ENV: 'test',
    ...envOver,
  };
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      ['--import', 'tsx', probe, mode, String(Date.now())],
      { cwd: repoRoot, env },
    );
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const failure = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', code: failure.code ?? 1 };
  }
}

const CABINET = [
  { id: 111, name: 'Поиск — Слоны', dailyBudget: 8000, negativeKeywords: [] },
  { id: 112, name: 'РСЯ — импорт из кабинета', dailyBudget: 3000, negativeKeywords: [] },
];

function refuseEverything(refused: string[]) {
  return http.post(`${YANDEX_BASE}/:service`, async ({ request, params }) => {
    const body = (await request.json()) as { method?: string };
    refused.push(`${String(params['service'])}.${String(body.method)}`);
    return HttpResponse.json(
      {
        error: {
          error_code: 152,
          error_string: 'Недостаточно средств',
          error_detail: 'На счёте кампании закончились деньги',
          request_id: '9999999999999999999',
        },
      },
      { headers: { Units: '10/60000/64000', RequestId: '9999999999999999999' } },
    );
  });
}

describe('площадка отвергает записи оптимизатора', () => {
  let fx: Fixture;
  let yandex: YandexApiMock;
  let telegram: TelegramMock;
  const refused: string[] = [];

  beforeAll(async () => {
    await resetDatabase();
    resetYandexRuntimeState();
    bootstrapChannels();

    yandex = createYandexApiMock(CABINET);
    yandex.server.use(refuseEverything(refused));
    yandex.server.listen({ onUnhandledRequest: 'error' });

    telegram = createTelegramMock();
    setMessenger(telegram);

    fx = await seedAccount();
  });

  afterAll(async () => {
    yandex?.server.close();
    setMessenger(null);
    await prisma.$disconnect();
  });

  it('ни одно решение не доехало, и это видно в сводке', async () => {
    const summary = await runScheduledOptimization({ dryRun: false, now: runAt(0) });

    expect(summary.autoApply).toBe(0);
    expect(summary.applyFailed).toBeGreaterThan(0);
    // Отказы настоящие: площадку спросили, и она ответила отказом на каждый запрос.
    expect(refused.length).toBeGreaterThan(0);
    expect(await prisma.changeLog.count()).toBe(0);

    const rows = await prisma.errorLog.findMany();
    expect(rows).toHaveLength(summary.applyFailed);
    expect(rows.every((r) => r.clientId === fx.clientId)).toBe(true);
    expect(rows.every((r) => r.provider === 'YANDEX_DIRECT')).toBe(true);
  });

  it('тревога о всплеске ошибок читает эти строки и называет кабинет', async () => {
    // Порог занижен намеренно: боевой (10) требует одиннадцати отказов, а фикстура
    // даёт пять. Проверяется не число, а то, что строки видны детектору и легли в
    // бакет «клиент × площадка», — иначе тревога промолчит при любом количестве.
    const alerts = await detectAlerts({ burstThreshold: 1 });
    const burst = alerts.filter((a) => a.kind === 'error_burst');

    expect(burst).toHaveLength(1);
    expect(burst[0]?.clientId).toBe(fx.clientId);
    expect(burst[0]?.provider).toBe('YANDEX_DIRECT');
  });
});

describe('карточку апрува доставить некому', () => {
  let fx: Fixture;
  let yandex: YandexApiMock;
  let summary: Awaited<ReturnType<typeof runScheduledOptimization>>;

  beforeAll(async () => {
    await resetDatabase();
    resetYandexRuntimeState();
    bootstrapChannels();

    yandex = createYandexApiMock(CABINET);
    yandex.server.listen({ onUnhandledRequest: 'error' });

    // 403 от Telegram: клиент заблокировал бота. Заявка создастся, нажать её некому.
    setMessenger({
      sendMessage: () => Promise.reject(new Error('403: bot was blocked by the user')),
      editMessageText: () => Promise.resolve(),
      answerCallbackQuery: () => Promise.resolve(),
    });

    fx = await seedAccount();
    summary = await runScheduledOptimization({ dryRun: false, now: runAt(0) });
  });

  afterAll(async () => {
    yandex?.server.close();
    setMessenger(null);
    await prisma.$disconnect();
  });

  it('сводка отделяет недоставленные карточки от выпущенных', async () => {
    const approvals = await prisma.pendingApproval.findMany();
    expect(approvals).toHaveLength(2);
    expect(approvals.every((a) => a.error !== null)).toBe(true);
    expect(approvals.every((a) => a.tgMessageId === null)).toBe(true);

    expect(summary.approvals).toBe(2);
    expect(summary.approvalsUndelivered).toBe(2);
  });

  it('запись в кабинет от этого не пострадала', async () => {
    expect(summary.autoApply).toBe(5);
    expect(summary.applyFailed).toBe(0);

    // Недоставка — тоже повод для журнала: иначе о ней знает только эта сводка,
    // а её читает лишь тот, кто запустил команду руками.
    const rows = await prisma.errorLog.findMany();
    expect(rows.map((r) => r.code)).toEqual(['APPROVAL_NOT_DELIVERED', 'APPROVAL_NOT_DELIVERED']);
    expect(rows.every((r) => r.clientId === fx.clientId)).toBe(true);
  });
});

describe('повтор прогона в те же сутки', () => {
  let yandex: YandexApiMock;
  let telegram: TelegramMock;

  beforeAll(async () => {
    await resetDatabase();
    resetYandexRuntimeState();
    bootstrapChannels();

    yandex = createYandexApiMock(CABINET);
    yandex.server.listen({ onUnhandledRequest: 'error' });
    telegram = createTelegramMock();
    setMessenger(telegram);

    await seedAccount();
    await runScheduledOptimization({ dryRun: false, now: runAt(0) });
    await runScheduledOptimization({ dryRun: false, now: runAt(0) });
  });

  afterAll(async () => {
    yandex?.server.close();
    setMessenger(null);
    await prisma.$disconnect();
  });

  it('второй раз в кабинет не ушло ничего: ключи идемпотентности отсекли решения', async () => {
    expect(await prisma.changeLog.count()).toBe(5);
    expect(await prisma.pendingApproval.count()).toBe(2);
    expect(telegram.sent).toHaveLength(2);
    // Штатный дубль — не отказ: в журнал ошибок он попасть не должен.
    expect(await prisma.errorLog.count()).toBe(0);
  });

  it('штатная дедупликация не печатает человеку ни строки', async () => {
    const result = await runProbe('duplicate', { LOG_LEVEL: 'silent' });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('а настоящий отказ Postgres по-прежнему виден — через Pino и со scope', async () => {
    // Обратная сторона правки: гасится не канал ошибок Prisma, а один ожидаемый
    // отказ в одном месте. Тот же P2002 у вызывающего, который его не ждёт,
    // обязан доехать до лога — иначе вместо шума получилась бы слепота.
    const result = await runProbe('unexpected', { LOG_LEVEL: 'error' });

    expect(result.code).toBe(0);
    const printed = `${result.stdout}\n${result.stderr}`;
    expect(printed).toContain('"scope":"db"');
    expect(printed).toContain('Unique constraint failed');
    // Дамп Prisma мимо Pino: именно он ложился поверх сводки команды.
    expect(printed).not.toContain('prisma:error');
  });
});
