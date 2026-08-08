import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/prisma.js', () => ({ prisma: {} }));

import { FakeDb, type FakeErrorRow } from '@/reporter/__tests__/fake-db.js';
import { fakeMessenger, type FakeMessenger } from '@/reporter/__tests__/fake-messenger.js';
import {
  detectAlerts,
  runAlertScan,
  ERROR_BURST_THRESHOLD,
  MAX_ALERTS_PER_RUN,
} from '@/reporter/alerts.js';
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
    db.seedCampaign({ id: 'c1', clientId: 'cl1' });
    for (const [i, day] of ['01', '02', '03', '04', '05', '06'].entries()) {
      db.seedStat({ entityId: 'c1', date: `2026-08-${day}`, spend: 5_000 + i });
    }
    db.seedStat({ entityId: 'c1', date: '2026-08-07', spend: 60_000 });

    const alerts = await detectAlerts({ ...deps(), checkSpend: true });

    expect(alerts.map((a) => a.kind)).toContain('spend_anomaly');
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

  it('тишина, когда ничего не случилось', async () => {
    const summary = await runAlertScan(deps());

    expect(summary).toMatchObject({ detected: 0, sent: 0, suppressed: 0 });
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
