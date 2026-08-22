import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/prisma.js', () => ({ prisma: {} }));

import { FakeDb } from '@/reporter/__tests__/fake-db.js';
import { fakeMessenger, type FakeMessenger } from '@/reporter/__tests__/fake-messenger.js';
import {
  buildDailyReport,
  runDailyReports,
  sendDailyReport,
  PROVISIONAL_NOTE,
} from '@/reporter/daily.js';
import { ReportDeliveryError } from '@/reporter/errors.js';
import type { ReportRecipient } from '@/reporter/recipients.js';

const CLIENT = 'cl1';
const RECIPIENT: ReportRecipient = { clientId: CLIENT, name: 'Ромашка', chatId: '555' };

/** 08.08 05:30 UTC = 08:30 МСК — штатный тик крона. Отчёт должен быть за 07.08. */
const CRON_TICK = new Date('2026-08-08T05:30:00Z');

let db: FakeDb;
let messenger: FakeMessenger;

function deps(now: Date = CRON_TICK) {
  return { db: db.asDb(), messenger: () => messenger, now: () => now };
}

beforeEach(() => {
  db = new FakeDb();
  messenger = fakeMessenger();
  db.seedClient({ id: CLIENT, name: 'Ромашка', tgUserId: 555n });
  db.seedCampaign({ id: 'c1', clientId: CLIENT, name: 'Поиск — услуги', targetCpa: 1_000 });
  db.seedCampaign({ id: 'c2', clientId: CLIENT, name: 'РСЯ (ретаргет)' });

  // Вчера: 07.08.
  db.seedStat({
    entityId: 'c1',
    date: '2026-08-07',
    spend: 6_000,
    conversions: 3,
    clicks: 120,
    impressions: 4_000,
  });
  db.seedStat({
    entityId: 'c2',
    date: '2026-08-07',
    spend: 4_000,
    conversions: 5,
    clicks: 200,
    impressions: 9_000,
  });
  // Позавчера: 06.08 — база для сравнения.
  db.seedStat({
    entityId: 'c1',
    date: '2026-08-06',
    spend: 5_000,
    conversions: 5,
    clicks: 100,
    impressions: 4_000,
  });
  db.seedStat({
    entityId: 'c2',
    date: '2026-08-06',
    spend: 4_000,
    conversions: 5,
    clicks: 210,
    impressions: 9_000,
  });
});

describe('buildDailyReport', () => {
  it('берёт вчерашние сутки по МСК и сравнивает с позавчерашними', async () => {
    const content = await buildDailyReport(
      RECIPIENT,
      { from: '2026-08-07', to: '2026-08-07' },
      deps(),
    );

    expect(content.metrics.totals.spend).toBe(10_000);
    expect(content.previous.totals.spend).toBe(9_000);
    expect(content.body).toContain('07\\.08\\.2026');
    expect(content.body).toContain('10 000 ₽');
  });

  it('проговаривает, что вчерашний CPA предварительный', async () => {
    const content = await buildDailyReport(
      RECIPIENT,
      { from: '2026-08-07', to: '2026-08-07' },
      deps(),
    );

    expect(PROVISIONAL_NOTE).toContain('21');
    expect(content.body).toContain('дозаезжают');
  });

  it('подписывает, чьей атрибуцией посчитан CPA', async () => {
    // По умолчанию строки площадочные — так и подписываем: клиент, глядя на CPA,
    // должен понимать, что это не цифра из его Метрики.
    const content = await buildDailyReport(
      RECIPIENT,
      { from: '2026-08-07', to: '2026-08-07' },
      deps(),
    );

    expect(content.body).toContain('по атрибуции рекламного кабинета');
    // Подпись не лезет в сами цифры: строка «Расход» остаётся однострочной.
    expect(content.body).toContain('Расход: *10 000 ₽*');
  });

  it('о смешении моделей предупреждает, а не подписывает мелким шрифтом', async () => {
    const mixed = new FakeDb();
    mixed.seedClient({ id: CLIENT, name: 'Ромашка', tgUserId: 555n });
    mixed.seedCampaign({ id: 'c1', clientId: CLIENT, name: 'Поиск' });
    mixed.seedCampaign({ id: 'c2', clientId: CLIENT, name: 'РСЯ' });
    mixed.seedStat({
      entityId: 'c1',
      date: '2026-08-07',
      spend: 6_000,
      conversions: 3,
      conversionSource: 'METRIKA',
    });
    mixed.seedStat({
      entityId: 'c2',
      date: '2026-08-07',
      spend: 4_000,
      conversions: 5,
      conversionSource: 'PLATFORM',
    });

    const content = await buildDailyReport(
      RECIPIENT,
      { from: '2026-08-07', to: '2026-08-07' },
      { db: mixed.asDb(), messenger: () => messenger, now: () => CRON_TICK },
    );

    expect(content.body).toContain('⚠️');
    expect(content.body).toContain('смешаны две модели атрибуции');
  });

  it('экранирует имена кампаний, чтобы MarkdownV2 не развалился', async () => {
    const content = await buildDailyReport(
      RECIPIENT,
      { from: '2026-08-07', to: '2026-08-07' },
      deps(),
    );

    expect(content.body).toContain('РСЯ \\(ретаргет\\)');
    expect(content.body).toContain('Поиск — услуги');
  });

  it('в день без открутки не делит на ноль и не врёт нулевым CPA', async () => {
    // Строки за день есть, и они нулевые: площадка отчиталась, откручивать было
    // нечего. Именно это — «ноль», в отличие от отсутствия строк ниже.
    db.seedStat({ entityId: 'c1', date: '2026-08-01', spend: 0, conversions: 0 });
    db.seedStat({ entityId: 'c2', date: '2026-08-01', spend: 0, conversions: 0 });

    const content = await buildDailyReport(
      RECIPIENT,
      { from: '2026-08-01', to: '2026-08-01' },
      deps(),
    );

    expect(content.metrics.coverage.hasData).toBe(true);
    expect(content.metrics.totals.cpa).toBeNull();
    // Прочерк вместо «0 ₽» и вместо «+∞%».
    expect(content.body).toContain('CPA: *—*');
    expect(content.body).toContain('Ни одна кампания за период не откручивалась');
  });

  it('незагруженный день не выдаёт себя за обвал расхода и лидов', async () => {
    // 07.08 загрузилось (10 000 ₽, 8 лидов), 08.08 — нет ни одной строки.
    const content = await buildDailyReport(
      RECIPIENT,
      { from: '2026-08-08', to: '2026-08-08' },
      deps(),
    );

    expect(content.metrics.coverage.hasData).toBe(false);
    expect(content.previous.coverage.hasData).toBe(true);
    // Ни «0 ₽», ни «−100%», ни красного инцидента — только честное «данных нет».
    expect(content.body).toContain('Статистики за этот период в базе нет');
    expect(content.body).not.toContain('−100%');
    expect(content.body).not.toContain('Расход:');
    expect(content.anomalies).toEqual([]);
    expect(content.chartUrl).toBeNull();
  });

  it('неполный период проговаривает, за какие дни данных нет', async () => {
    // 05.08 и 06.08 в базе есть, 04.08 — нет.
    db.seedStat({ entityId: 'c1', date: '2026-08-05', spend: 3_000, conversions: 2 });

    const content = await buildDailyReport(
      RECIPIENT,
      { from: '2026-08-04', to: '2026-08-06' },
      deps(),
    );

    expect(content.metrics.coverage.missingDays).toEqual(['2026-08-04']);
    expect(content.body).toContain('Данные неполные');
    expect(content.body).toContain('04\\.08');
  });

  it('добавляет ссылку на график quickchart', async () => {
    const content = await buildDailyReport(
      RECIPIENT,
      { from: '2026-08-07', to: '2026-08-07' },
      deps(),
    );

    expect(content.chartUrl).toContain('quickchart.io');
    expect(content.body).toContain('](https://quickchart.io/chart');
  });
});

describe('sendDailyReport', () => {
  it('сначала сохраняет отчёт, потом отправляет и отмечает sentAt', async () => {
    const outcome = await sendDailyReport(RECIPIENT, deps());

    expect(outcome.sent).toBe(true);
    expect(outcome.period).toEqual({ from: '2026-08-07', to: '2026-08-07' });
    expect(db.reports).toHaveLength(1);
    expect(db.reports[0]?.sentAt).toEqual(CRON_TICK);
    expect(db.reports[0]?.kind).toBe('DAILY');
    expect(messenger.sent[0]?.chatId).toBe('555');
  });

  it('период отчёта уходит в колонки как UTC-полночь', async () => {
    await sendDailyReport(RECIPIENT, deps());

    expect(db.reports[0]?.periodFrom.toISOString()).toBe('2026-08-07T00:00:00.000Z');
    expect(db.reports[0]?.periodTo.toISOString()).toBe('2026-08-07T00:00:00.000Z');
  });

  it('повторный прогон обновляет ту же строку, а не создаёт вторую', async () => {
    await sendDailyReport(RECIPIENT, deps());
    const firstId = db.reports[0]?.id;

    // Второй тик того же дня: отчёт уже отправлен, дубля быть не должно.
    await sendDailyReport(RECIPIENT, deps());

    expect(db.reports).toHaveLength(1);
    expect(db.reports[0]?.id).toBe(firstId);
    expect(messenger.sent).toHaveLength(1);
  });

  it('force пересчитывает и шлёт заново, оставаясь в одной строке', async () => {
    await sendDailyReport(RECIPIENT, deps());
    await sendDailyReport(RECIPIENT, { ...deps(), force: true });

    expect(db.reports).toHaveLength(1);
    expect(messenger.sent).toHaveLength(2);
  });

  it('падение Telegram не уносит с собой посчитанный отчёт', async () => {
    messenger.failWith = new Error('Bad Gateway');

    await expect(sendDailyReport(RECIPIENT, deps())).rejects.toBeInstanceOf(ReportDeliveryError);

    expect(db.reports).toHaveLength(1);
    expect(db.reports[0]?.sentAt).toBeNull();
    expect(db.reports[0]?.body).toContain('Отчёт за');
  });

  it('ретрай после сбоя доставки берёт текст из БД и не считает его заново', async () => {
    messenger.failWith = new Error('Bad Gateway');
    await expect(sendDailyReport(RECIPIENT, deps())).rejects.toThrow();
    const storedBody = db.reports[0]?.body;
    const queriesAfterFirst = db.statQueries;

    messenger.failWith = null;
    const outcome = await sendDailyReport(RECIPIENT, deps());

    expect(outcome.sent).toBe(true);
    expect(outcome.reused).toBe(true);
    expect(db.statQueries).toBe(queriesAfterFirst);
    expect(messenger.sent[0]?.text).toBe(storedBody);
    expect(db.reports).toHaveLength(1);
    expect(db.reports[0]?.sentAt).toEqual(CRON_TICK);
  });
});

describe('runDailyReports', () => {
  it('обходит всех активных клиентов и пропускает архивных', async () => {
    db.seedClient({ id: 'cl2', name: 'Василёк', tgUserId: 777n });
    db.seedClient({ id: 'cl3', name: 'Архив', tgUserId: 888n, status: 'ARCHIVED' });

    const summary = await runDailyReports(deps());

    expect(summary.clients).toBe(2);
    expect(summary.sent).toBe(2);
    expect(summary.period).toEqual({ from: '2026-08-07', to: '2026-08-07' });
    // Порядок — по имени клиента: «Василёк» раньше «Ромашки».
    expect(messenger.sent.map((m) => m.chatId)).toEqual(['777', '555']);
  });

  it('сбой одного клиента не лишает отчёта остальных и попадает в ErrorLog', async () => {
    db.seedClient({ id: 'cl2', name: 'Василёк', tgUserId: 777n });
    let calls = 0;
    const flaky = {
      sendMarkdown: async (chatId: string, text: string) => {
        calls += 1;
        if (chatId === '555') throw new Error('chat not found');
        messenger.sent.push({ chatId, text, options: undefined });
        return { messageId: calls };
      },
    };

    const summary = await runDailyReports({
      ...deps(),
      messenger: () => flaky as unknown as FakeMessenger,
    });

    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]?.clientId).toBe(CLIENT);
    expect(summary.sent).toBe(1);
    expect(messenger.sent.map((m) => m.chatId)).toEqual(['777']);
    expect(db.errors.some((e) => e.scope === 'reporter:daily')).toBe(true);
  });

  it('в 21:30 UTC отчитывается за наступивший по МСК день, а не за предыдущий', async () => {
    // 09.08 00:30 МСК — «вчера» это 08.08, а не 07.08.
    db.seedStat({ entityId: 'c1', date: '2026-08-08', spend: 1_234, conversions: 1 });

    const summary = await runDailyReports(deps(new Date('2026-08-08T21:30:00Z')));

    expect(summary.period).toEqual({ from: '2026-08-08', to: '2026-08-08' });
    expect(db.reports[0]?.periodFrom.toISOString()).toBe('2026-08-08T00:00:00.000Z');
    expect(messenger.sent[0]?.text).toContain('1 234 ₽');
  });
});
