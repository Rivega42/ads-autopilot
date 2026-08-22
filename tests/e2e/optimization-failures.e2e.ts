import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { Prisma } from '@prisma/client';
import { http, HttpResponse } from 'msw';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { E2E_DATABASE_URL, E2E_ENCRYPTION_KEY } from './support/config.js';
import { resetDatabase } from './support/database.js';
import { runAt, seedAccount, TARGET_CPA_RUB, type Fixture } from './support/seed.js';
import { createTelegramMock, type TelegramMock } from './support/telegram-mock.js';
import { createYandexApiMock, type YandexApiMock } from './support/yandex-api-mock.js';

import { setMessenger } from '@/approval/index.js';
import { bootstrapChannels } from '@/channels/bootstrap.js';
import { resetYandexRuntimeState } from '@/clients/yandex-direct/http.js';
import { prisma } from '@/db/prisma.js';
import { FAILURE_ROWS_PER_BATCH_CAP } from '@/optimizer/errors.js';
import { runScheduledOptimization } from '@/optimizer/index.js';
import { detectAlerts, ERROR_LOOKBACK_MINUTES } from '@/reporter/index.js';
import { CredentialRepository } from '@/repos/CredentialRepository.js';

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

  it('о недоставленной карточке узнаёт не только тот, кто запустил команду', async () => {
    // Сводку прогона из крона не читает никто, дашборд `ErrorLog` не открывает
    // вовсе — значит либо тревога, либо тишина до самого истечения заявки.
    const alerts = await detectAlerts({ checkSpend: false });
    const undelivered = alerts.find((a) => a.kind === 'approval_undelivered');

    expect(undelivered?.clientId).toBe(fx.clientId);
    expect(undelivered?.lines.join(' ')).toContain('403');
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

/**
 * Кабинет крупного клиента: `campaigns` кампаний по `keywords` фраз, все убыточные.
 *
 * Размер не выдуман под тест: он подобран так, чтобы предохранитель по доле
 * сущностей (30% за прогон) разрешил больше решений, чем помещается в потолок
 * строк `recordFailures`. Именно столько строк журнала и пишет настоящий прогон
 * такого клиента — сколько именно, спрашивается у прогона, а не задаётся.
 */
async function seedLargeCabinet(
  tgUserId: bigint,
  name: string,
  campaigns: number,
  keywords: number,
): Promise<string> {
  const client = await prisma.client.create({
    data: {
      tgUserId,
      name,
      status: 'ACTIVE',
      brief: {
        create: { status: 'COMPLETE', data: { targetCpaRub: TARGET_CPA_RUB, geo: 'Москва' } },
      },
    },
  });
  await new CredentialRepository().save(client.id, 'YANDEX_DIRECT', {
    accessToken: 'e2e-access-token',
    refreshToken: 'e2e-refresh-token',
  });

  const days = [-6, -5, -4, -3, -2, -1, 0].map((offset) => {
    const at = runAt(offset);
    return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  });

  const stats: Prisma.CampaignStatCreateManyInput[] = [];
  for (let c = 0; c < campaigns; c += 1) {
    const campaign = await prisma.campaign.create({
      data: {
        clientId: client.id,
        provider: 'YANDEX_DIRECT',
        externalId: `90${c}`,
        name: `Поиск — направление ${c}`,
        status: 'ACTIVE',
        dailyBudget: 8000,
        handoverMode: 'FULL',
        adGroups: { create: [{ externalId: `80${c}`, name: 'Все фразы' }] },
      },
      include: { adGroups: true },
    });
    const group = campaign.adGroups[0];
    if (!group) throw new Error('группа не создана');

    // Тратим меньше половины бюджета: правила по CPA вооружены.
    for (const date of days) {
      stats.push({
        entityType: 'CAMPAIGN',
        entityId: campaign.id,
        date,
        impressions: 20_000,
        clicks: 900,
        spend: 2800,
        conversions: 5,
      });
    }

    await prisma.keyword.createMany({
      data: Array.from({ length: keywords }, (_u, k) => ({
        adGroupId: group.id,
        externalId: `${c}-${k}`,
        phrase: `мамонт направление ${c} фраза ${k}`,
        bid: 100,
        status: 'ACTIVE' as const,
      })),
    });
    const created = await prisma.keyword.findMany({
      where: { adGroupId: group.id },
      select: { id: true },
    });
    for (const keyword of created) {
      // CPA 2100 при цели 1000 — это снижение ставки на 15%, а не пауза.
      // Пауза не подошла бы: больше десяти пауз за прогон политика уводит на
      // апрув (`MASS_PAUSE_THRESHOLD`), до площадки не доходит ни одна, и
      // отказов площадки в журнале не появляется вовсе.
      for (const [i, date] of days.entries()) {
        stats.push({
          entityType: 'KEYWORD',
          entityId: keyword.id,
          date,
          impressions: 45,
          clicks: 6,
          spend: 300,
          conversions: i === 4 ? 1 : 0,
        });
      }
    }
  }

  // Порциями: у Postgres не больше 32 767 bind-параметров на запрос (docs/LESSONS.md).
  for (let i = 0; i < stats.length; i += 1000) {
    await prisma.campaignStat.createMany({ data: stats.slice(i, i + 1000) });
  }
  return client.id;
}

describe('прогон крупного клиента не ослепляет тревоги по остальным', () => {
  /** Кампаний у крупного клиента. Больше — дольше прогон, картина та же. */
  const CAMPAIGNS = 20;
  /** Фраз в кампании: столько, чтобы решений хватило на потолок строк. */
  const KEYWORDS = 100;

  let yandex: YandexApiMock;
  let floodClientId: string;
  let quietClientId: string;
  let floodRows: number;
  let rowsPerCampaign: number;

  beforeAll(async () => {
    await resetDatabase();
    resetYandexRuntimeState();
    bootstrapChannels();

    yandex = createYandexApiMock(CABINET);
    yandex.server.use(refuseEverything([]));
    yandex.server.listen({ onUnhandledRequest: 'error' });
    setMessenger(createTelegramMock());

    floodClientId = await seedLargeCabinet(770000777n, 'Сеть «Мамонт»', CAMPAIGNS, KEYWORDS);
    quietClientId = await seedLargeCabinet(770000778n, 'Пекарня «Тихая»', 0, 0);

    // Тихий клиент ничего не оптимизирует — у него протух токен, и это
    // единственная его строка в журнале. Она старше флуда: в выборке «свежие
    // сначала» такие и вытеснялись.
    await prisma.errorLog.create({
      data: {
        clientId: quietClientId,
        provider: 'YANDEX_DIRECT',
        scope: 'clients:yandex-direct',
        code: 'AUTH_FAILED',
        message: 'Токен не принят: 401',
        createdAt: new Date(Date.now() - 8 * 60_000),
      },
    });

    await runScheduledOptimization({ dryRun: false, now: runAt(0) });
    floodRows = await prisma.errorLog.count({ where: { clientId: floodClientId } });
    rowsPerCampaign = floodRows / CAMPAIGNS;
  }, 300_000);

  afterAll(async () => {
    yandex?.server.close();
    setMessenger(null);
    await prisma.$disconnect();
  });

  it('одна крупная кампания упирается в потолок строк на пачку', () => {
    // Число снято с прогона, а не назначено: столько решений доживает до записи
    // после предохранителя по доле и столько строк из них помещается в пачку.
    expect(rowsPerCampaign).toBe(FAILURE_ROWS_PER_BATCH_CAP + 1);
  });

  it('тревога соседнего клиента доходит, хотя журнал забит чужим флудом', async () => {
    // Флуд обязан быть больше прежнего потолка выборки (500 строк) — иначе это
    // не воспроизведение, а более мягкий случай.
    expect(floodRows).toBeGreaterThan(500);

    const alerts = await detectAlerts({ checkSpend: false });

    expect(alerts.map((a) => `${a.kind}:${String(a.clientId)}`)).toContain(
      `auth_error:${quietClientId}`,
    );
    // И флудящий не потерян: чинить придётся обоих.
    expect(alerts.map((a) => `${a.kind}:${String(a.clientId)}`)).toContain(
      `error_burst:${floodClientId}`,
    );
  });

  it('прежняя выборка на этих же данных соседа не видела', async () => {
    // Ровно тот запрос, что стоял в скане до правки: 500 свежих строк одной
    // выборкой на всех клиентов. Оставлен здесь как воспроизведение дефекта на
    // живых данных — без него «починили» держалось бы на слове.
    const fetched = await prisma.errorLog.findMany({
      where: { createdAt: { gte: new Date(Date.now() - ERROR_LOOKBACK_MINUTES * 60_000) } },
      select: { clientId: true },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });

    expect(fetched).toHaveLength(500);
    expect(fetched.some((row) => row.clientId === quietClientId)).toBe(false);
  });

  it('счёт во всплеске точный, а не обрезанный потолком выборки', async () => {
    const alerts = await detectAlerts({ checkSpend: false });
    const burst = alerts.find((a) => a.kind === 'error_burst' && a.clientId === floodClientId);

    expect(burst?.title).toBe(`${floodRows} ошибок за 5 мин`);
  });
});
