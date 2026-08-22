import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/prisma.js', () => ({ prisma: {} }));

import { FakeDb, type FakeErrorRow } from '@/reporter/__tests__/fake-db.js';
import { fakeMessenger, type FakeMessenger } from '@/reporter/__tests__/fake-messenger.js';
import {
  cronIntervalMinutes,
  detectAlerts,
  runAlertScan,
  ALERT_SCAN_INTERVAL_MINUTES,
  ERROR_BURST_THRESHOLD,
  ERROR_LOOKBACK_MINUTES,
  ERROR_WINDOW_MINUTES,
  MAX_ALERTS_PER_RUN,
  MAX_ERROR_ROWS,
  PROVIDER_BURST_THRESHOLD,
} from '@/reporter/alerts.js';
import { REPORT_FAILURE_CODES } from '@/reporter/errors.js';
import { CooldownLimiter } from '@/reporter/rate-limit.js';

const NOW = new Date('2026-08-08T09:00:00Z');
const CHAT = '999';

let db: FakeDb;
let messenger: FakeMessenger;
let limiter: CooldownLimiter;

function deps(now: Date = NOW) {
  return {
    db: db.asDb(),
    messenger: () => messenger,
    now: () => now,
    chatId: CHAT,
    limiter,
    checkSpend: false,
  };
}

/** `count` ошибок за последнюю минуту от одного кабинета. */
function seedBurst(count: number, patch: Partial<FakeErrorRow> = {}): void {
  for (let i = 0; i < count; i += 1) {
    db.seedError({
      createdAt: new Date(NOW.getTime() - 60_000),
      clientId: 'cl1',
      provider: 'YANDEX_DIRECT',
      scope: 'yandex:campaigns',
      code: '152',
      message: 'Bad Request',
      ...patch,
    });
  }
}

/** `count` отказов доставки отчёта от одного клиента. */
function seedReportFailures(count: number, patch: Partial<FakeErrorRow> = {}): void {
  for (let i = 0; i < count; i += 1) {
    db.seedError({
      createdAt: new Date(NOW.getTime() - 60_000),
      clientId: 'cl1',
      provider: null,
      scope: 'reporter:daily',
      code: REPORT_FAILURE_CODES.delivery,
      message: 'Failed to deliver report r1 for client cl1',
      ...patch,
    });
  }
}

/** Отказ площадки: `clients` кабинетов, каждый сам по себе за порогом всплеска. */
function seedOutage(clients: number, createdAt: Date = new Date(NOW.getTime() - 60_000)): void {
  for (let i = 0; i < clients; i += 1) {
    seedBurst(ERROR_BURST_THRESHOLD + 1, {
      clientId: `cl-${i}`,
      provider: 'VK_ADS',
      createdAt,
    });
  }
}

/** Ровная история и всплеск в последний день периода (07.08). */
function seedSpendAnomaly(): void {
  db.seedCampaign({ id: 'c1', clientId: 'cl1' });
  for (const [i, day] of ['01', '02', '03', '04', '05', '06'].entries()) {
    db.seedStat({ entityId: 'c1', date: `2026-08-${day}`, spend: 5_000 + i });
  }
  db.seedStat({ entityId: 'c1', date: '2026-08-07', spend: 60_000 });
}

beforeEach(() => {
  db = new FakeDb();
  messenger = fakeMessenger();
  limiter = new CooldownLimiter(30 * 60_000);
  db.seedClient({ id: 'cl1', name: 'Ромашка', tgUserId: 555n });
});

describe('detectAlerts', () => {
  it('поднимает алерт при более чем 10 ошибках за 5 минут', async () => {
    seedBurst(ERROR_BURST_THRESHOLD + 1);

    const alerts = await detectAlerts(deps());

    expect(alerts.map((a) => a.kind)).toContain('error_burst');
    expect(alerts[0]?.title).toContain('11 ошибок');
  });

  it('ровно 10 ошибок — ещё не всплеск', async () => {
    seedBurst(ERROR_BURST_THRESHOLD);

    expect(await detectAlerts(deps())).toEqual([]);
  });

  it('старые ошибки за окно не считаются', async () => {
    seedBurst(20, { createdAt: new Date(NOW.getTime() - 40 * 60_000) });

    expect(await detectAlerts(deps())).toEqual([]);
  });

  it('ошибки разных кабинетов не складываются в общий всплеск', async () => {
    seedBurst(6);
    seedBurst(6, { clientId: 'cl2', provider: 'VK_ADS' });

    expect(await detectAlerts(deps())).toEqual([]);
  });

  it('одна ошибка авторизации — уже алерт', async () => {
    db.seedError({
      createdAt: NOW,
      clientId: 'cl1',
      provider: 'YANDEX_DIRECT',
      scope: 'yandex:auth',
      code: 'AUTH_FAILED',
      message: 'token rejected',
    });

    const alerts = await detectAlerts(deps());

    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.kind).toBe('auth_error');
    expect(alerts[0]?.severity).toBe('critical');
  });

  it('исчерпание units попадает в алерты отдельным поводом', async () => {
    db.seedError({
      createdAt: NOW,
      clientId: 'cl1',
      provider: 'YANDEX_DIRECT',
      scope: 'yandex:stats',
      code: 'OUT_OF_UNITS',
      message: 'out of units',
    });

    expect((await detectAlerts(deps()))[0]?.kind).toBe('out_of_units');
  });

  it('ловит аномальный расход по статистике клиента', async () => {
    seedSpendAnomaly();

    const alerts = await detectAlerts({ ...deps(), checkSpend: true });

    expect(alerts.map((a) => a.kind)).toContain('spend_anomaly');
  });

  it('не считает незагруженный день остановкой расхода', async () => {
    db.seedCampaign({ id: 'c1', clientId: 'cl1' });
    for (const [i, day] of ['01', '02', '03', '04', '05', '06'].entries()) {
      db.seedStat({ entityId: 'c1', date: `2026-08-${day}`, spend: 5_000 + i });
    }
    // За 07.08 строк нет вовсе — раньше это читалось как расход, упавший в ноль.

    expect(await detectAlerts({ ...deps(), checkSpend: true })).toEqual([]);
  });

  it('ошибка одного клиента не уносит уже найденные алерты остальных', async () => {
    db.seedError({
      createdAt: NOW,
      clientId: 'cl1',
      provider: 'YANDEX_DIRECT',
      scope: 'yandex:auth',
      code: 'AUTH_FAILED',
      message: 'token rejected',
    });
    // «Василёк» идёт по алфавиту первым — то есть падает раньше, чем прогон
    // дошёл бы до остальных, и раньше уже найденного 401.
    db.seedClient({ id: 'cl2', name: 'Василёк', tgUserId: 777n });
    db.seedCampaign({ id: 'c2', clientId: 'cl2' });
    db.failOn.statsForClient = { clientId: 'cl2', error: new Error('stat query exploded') };

    const alerts = await detectAlerts({ ...deps(), checkSpend: true });

    expect(alerts.map((a) => a.kind)).toEqual(['auth_error']);
    expect(db.errors.some((e) => e.scope === 'reporter:alerts')).toBe(true);
  });

  it('ошибка чуть старше окна всплеска всё равно поднимает алерт авторизации', async () => {
    // Пропущенный тик крона: ошибка легла между прогонами.
    db.seedError({
      createdAt: new Date(NOW.getTime() - (ERROR_WINDOW_MINUTES * 60_000 + 30_000)),
      clientId: 'cl1',
      provider: 'YANDEX_DIRECT',
      scope: 'yandex:auth',
      code: 'AUTH_FAILED',
      message: 'token rejected',
    });

    expect((await detectAlerts(deps()))[0]?.kind).toBe('auth_error');
  });

  it('недоставленный отчёт поднимает тревогу с первой записи', async () => {
    seedReportFailures(1);

    const alerts = await detectAlerts(deps());

    // Порог всплеска до одной записи не дотягивается никогда, а клиент при этом
    // остался без отчёта — единственного канала, по которому он узнаёт, что
    // происходит с деньгами.
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'report_failed', severity: 'critical' });
    expect(alerts[0]?.title).toContain('daily');
    expect(alerts[0]?.lines.join(' ')).toContain('Клиент за этот период отчёта не получил.');
  });

  it('дневной и недельный отказ одного клиента — разные поводы', async () => {
    seedReportFailures(1);
    seedReportFailures(1, { scope: 'reporter:weekly' });

    const alerts = await detectAlerts(deps());

    expect(alerts.map((a) => a.kind)).toEqual(['report_failed', 'report_failed']);
    // Ключи разные: недельный разбор не должен молчать полчаса из-за дневного.
    expect(new Set(alerts.map((a) => a.key)).size).toBe(2);
  });

  it('несобравшийся отчёт и неушедший — разные поводы с разными заголовками', async () => {
    seedReportFailures(1);
    seedReportFailures(1, {
      code: REPORT_FAILURE_CODES.build,
      message: 'Error: metrics query exploded',
    });

    const alerts = await detectAlerts(deps());

    // Этап один — `daily`, а поломки разные: одна лечится повтором, вторая
    // требует разбора причины. Раньше вид отказа угадывался по имени этапа, и
    // упавший расчёт объявлялся неушедшим клиенту отчётом.
    expect(alerts.map((a) => a.title)).toEqual([
      'Отчёт не ушёл клиенту (daily)',
      'Сбой отчётности (daily)',
    ]);
    expect(new Set(alerts.map((a) => a.key)).size).toBe(2);
    expect(alerts[0]?.lines.join(' ')).toContain('Текст уже в БД');
    expect(alerts[1]?.lines.join(' ')).toContain('Отчёт не собрался');
  });

  it('пачка отказов одного клиента остаётся одним поводом', async () => {
    // Три попытки доставки за окно — одна поломка и одно сообщение, а не три.
    seedReportFailures(3);

    const alerts = await detectAlerts(deps());

    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.lines.join(' ')).toContain('Отказов за выборку: 3');
  });

  it('поломка площадки, размазанная по кабинетам, поднимает тревогу по площадке', async () => {
    seedBurst(6, { clientId: 'cl1' });
    seedBurst(6, { clientId: 'cl2' });

    const alerts = await detectAlerts(deps());

    // По бакету «клиент + площадка» — по шесть ошибок, ни один порог не перебран.
    // Двенадцать ошибок площадки за пять минут — уже её поломка.
    expect(alerts.map((a) => a.kind)).toEqual(['provider_burst']);
    expect(alerts[0]).toMatchObject({ severity: 'critical', clientId: null });
    expect(alerts[0]?.title).toContain('12 ошибок YANDEX_DIRECT');
    expect(alerts[0]?.lines.join(' ')).toContain('Кабинетов задето: 2');
  });

  it('порог по площадке считается по тому же окну, что и порог по кабинету', async () => {
    seedBurst(6, { clientId: 'cl1' });
    seedBurst(6, { clientId: 'cl2', createdAt: new Date(NOW.getTime() - 6 * 60_000) });

    // Шесть из двенадцати старше окна: выборка их видит, порог — нет.
    expect(await detectAlerts(deps())).toEqual([]);
    expect(PROVIDER_BURST_THRESHOLD).toBe(ERROR_BURST_THRESHOLD);
  });

  it('один сломанный кабинет и посторонняя ошибка соседа — это кабинет, а не площадка', async () => {
    seedBurst(50, { clientId: 'cl1' });
    seedBurst(1, { clientId: 'cl2' });

    const alerts = await detectAlerts(deps());

    // Раньше «задето два кабинета» само по себе объявляло поломку площадкой:
    // приходило «51 ошибка YANDEX_DIRECT, кабинетов задето 2» без клиента, а
    // кабинетная тревога, которая назвала бы `cl1`, глушилась. Чинить надо было
    // один кабинет, а сообщение звало разбираться с площадкой.
    expect(alerts.map((a) => a.kind)).toEqual(['error_burst']);
    expect(alerts[0]).toMatchObject({ clientId: 'cl1', provider: 'YANDEX_DIRECT' });
    expect(alerts[0]?.foldedInto).toBeUndefined();
  });

  it('громкий кабинет на фоне мелочи у соседей не становится площадкой', async () => {
    seedBurst(ERROR_BURST_THRESHOLD + 1, { clientId: 'cl1' });
    seedBurst(3, { clientId: 'cl2' });
    seedBurst(3, { clientId: 'cl3' });

    const alerts = await detectAlerts(deps());

    // Поодиночке соседи до порога не дотягивают и вместе тоже (3 + 3 ≤ 10):
    // это фон, а не площадка. Виновник один, и тревога его называет.
    expect(alerts.map((a) => a.kind)).toEqual(['error_burst']);
    expect(alerts[0]?.clientId).toBe('cl1');
  });

  it('громкий кабинет вместе с настоящей поломкой площадки — площадка, но кабинет назван', async () => {
    seedBurst(100, { clientId: 'cl1' });
    seedBurst(6, { clientId: 'cl2' });
    seedBurst(6, { clientId: 'cl3' });

    const alerts = await detectAlerts(deps());

    // `cl2` и `cl3` поодиночке до порога не дотягивают, вместе — перебирают:
    // это площадка. Но `cl1` сыплется сверх неё, и тревога обязана это сказать,
    // иначе «похоже на площадку» означает «с кем разбираться, догадайся сам».
    expect(alerts.map((a) => a.kind)).toEqual(['provider_burst', 'error_burst']);
    expect(alerts[0]?.lines.join(' ')).toContain('Сверх кабинетного порога: cl1 (100)');
    expect(alerts[1]).toMatchObject({
      clientId: 'cl1',
      foldedInto: 'provider_burst:YANDEX_DIRECT',
    });
  });

  it('несколько кабинетов, каждый за порогом, — площадка, а их всплески свёрнуты', async () => {
    seedBurst(ERROR_BURST_THRESHOLD + 1, { clientId: 'cl1' });
    seedBurst(ERROR_BURST_THRESHOLD + 2, { clientId: 'cl2' });

    const alerts = await detectAlerts(deps());

    expect(alerts.map((a) => a.kind)).toEqual(['provider_burst', 'error_burst', 'error_burst']);
    expect(alerts.slice(1).every((a) => a.foldedInto === 'provider_burst:YANDEX_DIRECT')).toBe(
      true,
    );
    expect(alerts[0]?.lines.join(' ')).toContain('Сверх кабинетного порога: cl2 (12), cl1 (11)');
  });

  it('всплеск одного кабинета остаётся кабинетным', async () => {
    seedBurst(ERROR_BURST_THRESHOLD + 1, { clientId: 'cl1' });

    const alerts = await detectAlerts(deps());

    // Ошибки одного клиента — это его кабинет, а не площадка: сообщение обязано
    // называть кабинет, иначе с ним нечего делать.
    expect(alerts.map((a) => a.kind)).toEqual(['error_burst']);
    expect(alerts[0]?.clientId).toBe('cl1');
  });

  it('переавторизация и units остаются кабинетными даже при поломке площадки', async () => {
    seedBurst(6, { clientId: 'cl1' });
    seedBurst(6, { clientId: 'cl2' });
    db.seedError({
      createdAt: NOW,
      clientId: 'cl2',
      provider: 'YANDEX_DIRECT',
      scope: 'yandex:auth',
      code: 'AUTH_FAILED',
      message: 'token rejected',
    });

    const alerts = await detectAlerts(deps());

    // У 401 есть своё действие — переавторизовать конкретный кабинет; в общей
    // тревоге по площадке оно бы потерялось.
    expect(alerts.map((a) => a.kind).sort()).toEqual(['auth_error', 'provider_burst']);
  });

  it('не вычитывает весь журнал целиком, когда кабинет сыплется тысячами строк', async () => {
    seedBurst(MAX_ERROR_ROWS + 200);

    const alerts = await detectAlerts(deps());

    expect(alerts).toHaveLength(1);
    // Счёт обрезан потолком выборки — говорим «больше», а не выдуманное число.
    expect(alerts[0]?.title).toContain('больше');
    expect(alerts[0]?.title).toContain(`${MAX_ERROR_ROWS} ошибок`);
  });
});

describe('runAlertScan', () => {
  it('не повторяет один и тот же алерт, пока не остынет', async () => {
    seedBurst(ERROR_BURST_THRESHOLD + 1);

    const first = await runAlertScan(deps());
    const second = await runAlertScan(deps(new Date(NOW.getTime() + 60_000)));

    expect(first.sent).toBe(1);
    expect(second.detected).toBe(1);
    expect(second.sent).toBe(0);
    expect(second.suppressed).toBe(1);
    expect(messenger.sent).toHaveLength(1);
  });

  it('после остывания тот же повод проходит снова', async () => {
    seedBurst(ERROR_BURST_THRESHOLD + 1);
    await runAlertScan(deps());

    // Через полчаса кабинет всё так же сыпется — молчать дальше нельзя.
    const later = new Date(NOW.getTime() + 31 * 60_000);
    seedBurst(ERROR_BURST_THRESHOLD + 1, { createdAt: later });
    const summary = await runAlertScan(deps(later));

    expect(summary.sent).toBe(1);
    expect(messenger.sent).toHaveLength(2);
  });

  it('сломанный кабинет не заливает чат: разные поводы одного кабинета не суммируются в поток', async () => {
    // 200 ошибок подряд — это по-прежнему один всплеск и одно сообщение.
    seedBurst(200);

    const summary = await runAlertScan(deps());

    expect(summary.detected).toBe(1);
    expect(messenger.sent).toHaveLength(1);
  });

  it('одна аномалия расхода — одно сообщение за сутки, а не каждые полчаса', async () => {
    seedSpendAnomaly();
    const spendDeps = { ...deps(), checkSpend: true };

    const first = await runAlertScan(spendDeps);
    // Следующий тик крона через 35 минут: аномалия та же самая, день тот же.
    const later = new Date(NOW.getTime() + 35 * 60_000);
    const second = await runAlertScan({ ...spendDeps, now: () => later });

    expect(first.sent).toBe(1);
    expect(second.detected).toBe(1);
    expect(second.sent).toBe(0);
    expect(second.suppressed).toBe(1);
    expect(messenger.sent).toHaveLength(1);
  });

  it('проверку расхода не запускает на каждом пятиминутном тике', async () => {
    seedSpendAnomaly();
    // Без явного checkSpend решение принимает сам прогон.
    const scan = { db: db.asDb(), messenger: () => messenger, chatId: CHAT, limiter };

    await runAlertScan({ ...scan, now: () => NOW });
    const afterFirst = db.statQueries;
    await runAlertScan({ ...scan, now: () => new Date(NOW.getTime() + 5 * 60_000) });

    expect(afterFirst).toBeGreaterThan(0);
    expect(db.statQueries).toBe(afterFirst);
  });

  it('отвалившаяся площадка даёт одно сообщение, а не по одному на кабинет', async () => {
    seedOutage(12);

    const summary = await runAlertScan(deps());

    // Двенадцать сломанных кабинетов — двенадцать поводов, но одна поломка.
    // Свёрнуты, а не выброшены: в тексте они названы.
    expect(summary).toMatchObject({ detected: 13, sent: 1, folded: 12, truncated: 0 });
    expect(messenger.sent).toHaveLength(1);
    expect(messenger.sent[0]?.text).toContain('Кабинетов задето: 12');
  });

  it('свёрнутый кабинет не выстреливает вторым прогоном, когда площадка молчит', async () => {
    seedOutage(12);
    await runAlertScan(deps());

    // Следующий тик: площадка всё так же сыплется, тишина по её ключу ещё идёт.
    const later = new Date(NOW.getTime() + 5 * 60_000);
    seedOutage(12, later);
    const second = await runAlertScan(deps(later));

    // Свёрнутый повод человек уже видел строкой — значит его тишина идёт вместе
    // с родительской. Иначе прогон, следующий за поломкой площадки, вываливал бы
    // в чат те самые двенадцать сообщений, от которых свёртка и защищает.
    expect(second).toMatchObject({ sent: 0, folded: 0 });
    expect(second.suppressed).toBe(second.detected);
    expect(messenger.sent).toHaveLength(1);
  });

  it('всплеск у нового кабинета пробивается сквозь тишину по площадке', async () => {
    seedOutage(12);
    await runAlertScan(deps());

    // Через пять минут сломался ещё один кабинет — своя поломка, о которой ещё
    // никто не рассказывал. Раньше кабинетные всплески по «площадочному»
    // провайдеру подавлялись безусловно, и все полчаса тишины по площадке этот
    // кабинет оставался неизвестным.
    const later = new Date(NOW.getTime() + 5 * 60_000);
    seedOutage(12, later);
    seedBurst(ERROR_BURST_THRESHOLD + 1, {
      clientId: 'cl-new',
      provider: 'VK_ADS',
      createdAt: later,
    });

    const second = await runAlertScan(deps(later));

    expect(second.sent).toBe(1);
    expect(messenger.sent).toHaveLength(2);
    expect(messenger.sent[1]?.text).toContain('cl\\-new');
  });

  it('лишние поводы схлопываются в одну строку', async () => {
    for (let i = 0; i < MAX_ALERTS_PER_RUN + 2; i += 1) {
      db.seedError({
        createdAt: NOW,
        clientId: `cl-${i}`,
        provider: 'YANDEX_DIRECT',
        scope: 'yandex:auth',
        code: 'AUTH_FAILED',
        message: 'token rejected',
      });
    }

    const summary = await runAlertScan(deps());

    expect(summary.detected).toBe(MAX_ALERTS_PER_RUN + 2);
    expect(summary.sent).toBe(MAX_ALERTS_PER_RUN);
    expect(summary.truncated).toBe(2);
    expect(messenger.sent).toHaveLength(MAX_ALERTS_PER_RUN + 1);
    expect(messenger.sent.at(-1)?.text).toContain('и ещё 2');
  });

  it('обрезанные поводы доезжают следующим прогоном, а не молчат полчаса', async () => {
    for (let i = 0; i < MAX_ALERTS_PER_RUN + 2; i += 1) {
      db.seedError({
        createdAt: NOW,
        clientId: `cl-${i}`,
        provider: 'YANDEX_DIRECT',
        scope: 'yandex:auth',
        code: 'AUTH_FAILED',
        message: 'token rejected',
      });
    }
    await runAlertScan(deps());
    messenger.sent.length = 0;

    // Следующий тик через минуту: уже отправленные молчат, недоставленные — нет.
    const second = await runAlertScan(deps(new Date(NOW.getTime() + 60_000)));

    expect(second.suppressed).toBe(MAX_ALERTS_PER_RUN);
    expect(second.sent).toBe(2);
    expect(second.truncated).toBe(0);
    expect(messenger.sent).toHaveLength(2);
  });

  it('не доставленный из-за сбоя Telegram алерт повторяется на следующем тике', async () => {
    seedBurst(ERROR_BURST_THRESHOLD + 1);
    messenger.failWith = new Error('Telegram down');
    const first = await runAlertScan(deps());

    messenger.failWith = null;
    const second = await runAlertScan(deps(new Date(NOW.getTime() + 60_000)));

    expect(first.sent).toBe(0);
    // Тишина по ключу не началась: сообщения не было.
    expect(second.suppressed).toBe(0);
    expect(second.sent).toBe(1);
    expect(messenger.sent).toHaveLength(1);
  });

  it('под нож лимита прогона уходит warning, а не критичный повод', async () => {
    db.seedCampaign({ id: 'c1', clientId: 'cl1' });
    for (let i = 0; i < MAX_ALERTS_PER_RUN; i += 1) {
      db.seedError({
        createdAt: NOW,
        clientId: `cl-units-${i}`,
        provider: 'YANDEX_DIRECT',
        scope: 'yandex:stats',
        code: 'OUT_OF_UNITS',
        message: 'out of units',
      });
    }
    db.seedError({
      createdAt: NOW,
      clientId: 'cl-auth',
      provider: 'YANDEX_DIRECT',
      scope: 'yandex:auth',
      code: 'AUTH_FAILED',
      message: 'token rejected',
    });

    const summary = await runAlertScan(deps());

    expect(summary.truncated).toBe(1);
    expect(messenger.sent.some((m) => m.text.includes('Токен не принят'))).toBe(true);
  });

  it('без админского чата ничего не шлёт и говорит об этом в сводке', async () => {
    seedBurst(ERROR_BURST_THRESHOLD + 1);

    const summary = await runAlertScan({ ...deps(), chatId: undefined });

    expect(summary.sent).toBe(0);
    expect(summary.suppressed).toBe(1);
    expect(messenger.sent).toHaveLength(0);
  });

  it('падение отправки одного алерта не роняет прогон', async () => {
    seedBurst(ERROR_BURST_THRESHOLD + 1);
    messenger.failWith = new Error('Telegram down');

    const summary = await runAlertScan(deps());

    expect(summary.detected).toBe(1);
    expect(summary.sent).toBe(0);
  });

  it('отказ отчёта не шлётся каждые пять минут, пока запись лежит в выборке', async () => {
    seedReportFailures(1);

    const first = await runAlertScan(deps());
    const second = await runAlertScan(deps(new Date(NOW.getTime() + 60_000)));

    expect(first.sent).toBe(1);
    expect(second.detected).toBe(1);
    expect(second.sent).toBe(0);
    expect(second.suppressed).toBe(1);
    expect(messenger.sent).toHaveLength(1);
  });

  it('прогон, упавший по всем клиентам, не превращается в поток сообщений', async () => {
    // Telegram недоступен — отчёт не ушёл никому из двадцати клиентов.
    for (let i = 0; i < 20; i += 1) seedReportFailures(1, { clientId: `cl-${i}` });

    const summary = await runAlertScan(deps());

    expect(summary.detected).toBe(20);
    // Лимит прогона держит чат читаемым: пять сообщений и строка про остаток.
    expect(summary.sent).toBe(MAX_ALERTS_PER_RUN);
    expect(messenger.sent).toHaveLength(MAX_ALERTS_PER_RUN + 1);
    expect(messenger.sent.at(-1)?.text).toContain('и ещё 15');
  });

  it('поломка площадки — одно сообщение на площадку, а не на кабинет', async () => {
    for (let i = 0; i < 6; i += 1) seedBurst(2, { clientId: `cl-${i}` });

    const first = await runAlertScan(deps());
    const second = await runAlertScan(deps(new Date(NOW.getTime() + 60_000)));

    expect(first.detected).toBe(1);
    expect(first.sent).toBe(1);
    expect(second.sent).toBe(0);
    expect(messenger.sent).toHaveLength(1);
  });

  it('тишина, когда ничего не случилось', async () => {
    const summary = await runAlertScan(deps());

    expect(summary).toMatchObject({ detected: 0, sent: 0, suppressed: 0 });
  });
});

describe('глубина выборки', () => {
  it('перекрывает два периода крона — иначе пропущенный тик оставляет слепую зону', () => {
    // Прогон видит только своё окно, назад не смотрит никто. При выборке короче
    // двух периодов минуты между пропущенным и следующим тиком не просматривает
    // ни один прогон, и разовый повод (401, units) теряется навсегда.
    expect(ERROR_LOOKBACK_MINUTES).toBeGreaterThanOrEqual(2 * ALERT_SCAN_INTERVAL_MINUTES);
    expect(ERROR_LOOKBACK_MINUTES).toBeGreaterThan(ERROR_WINDOW_MINUTES);
  });

  it('период берётся из расписания крона, а не из отдельной константы', () => {
    expect(cronIntervalMinutes('*/5 * * * *')).toBe(5);
    expect(cronIntervalMinutes('*/30 * * * *')).toBe(30);
    expect(cronIntervalMinutes('0 * * * *')).toBe(60);
    expect(cronIntervalMinutes('0,15,45 * * * *')).toBe(30);
    expect(cronIntervalMinutes('* * * * *')).toBe(1);
    // Суточные и недельные расписания считаются честно. Прежде здесь стояло 60 с
    // объяснением «завысить безопасно» — а это было занижение в двадцать четыре
    // раза, то есть ровно та слепая зона, от которой объяснение защищало.
    expect(cronIntervalMinutes('30 8 * * *')).toBe(1440);
    expect(cronIntervalMinutes('0 10 * * 1')).toBe(10080);
    // Нераспознанное остаётся часовым: это последняя догадка в функции, и она в
    // безопасную сторону — период короче настоящего лишь удлиняет выборку.
    expect(cronIntervalMinutes(null)).toBe(60);
    expect(cronIntervalMinutes('чепуха')).toBe(60);
  });

  it('401 из пропущенного тика доезжает до человека', async () => {
    // Тик в T не состоялся; следующий приходит через два периода.
    const missed = new Date(NOW.getTime() + 2 * ALERT_SCAN_INTERVAL_MINUTES * 60_000);
    db.seedError({
      createdAt: NOW,
      clientId: 'cl1',
      provider: 'YANDEX_DIRECT',
      scope: 'yandex:auth',
      code: 'AUTH_FAILED',
      message: 'token rejected',
    });

    const summary = await runAlertScan(deps(missed));

    expect(summary.sent).toBe(1);
    expect(messenger.sent[0]?.text).toContain('Токен не принят');
  });
});

describe('CooldownLimiter', () => {
  it('первый ключ проходит, повтор — нет', () => {
    const cooldown = new CooldownLimiter(1_000);

    expect(cooldown.allow('k', new Date(0))).toBe(true);
    expect(cooldown.allow('k', new Date(500))).toBe(false);
    expect(cooldown.remainingMs('k', new Date(500))).toBe(500);
    expect(cooldown.allow('k', new Date(1_500))).toBe(true);
  });

  it('разные ключи независимы', () => {
    const cooldown = new CooldownLimiter(1_000);

    expect(cooldown.allow('a', new Date(0))).toBe(true);
    expect(cooldown.allow('b', new Date(0))).toBe(true);
  });

  it('не копит ключи вечно', () => {
    const cooldown = new CooldownLimiter(1_000);
    cooldown.allow('a', new Date(0));
    cooldown.allow('b', new Date(5_000));

    expect(cooldown.size).toBe(1);
  });
});
