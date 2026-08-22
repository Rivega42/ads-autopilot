import { Api } from 'grammy';
import { setupServer, type SetupServer } from 'msw/node';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { resetDatabase } from './support/database.js';
import { at, clearErrors, seedCabinet, seedErrors } from './support/reporter-alerts-seed.js';
import { createWeeklyReviewStub, type WeeklyReviewStub } from './support/reporter-review-stub.js';
import {
  MORNING_RUN,
  PREVIOUS_WEEK,
  REPORT_DAY,
  daysBetween,
  plain,
  seedReportClient,
  type SeededReportClient,
} from './support/reporter-seed.js';
import {
  createReportTelegramMock,
  parseMarkdownV2,
  TELEGRAM_TEXT_MAX,
  type ReportTelegramMock,
} from './support/reporter-telegram.js';

import {
  clampMarkdown,
  createApiReportMessenger,
  runAlertScan,
  runDailyReports,
  runWeeklyReports,
  CooldownLimiter,
  type ReportMessenger,
} from '@/reporter/index.js';
import { mdRaw } from '@/reporter/markdown.js';

/**
 * Настоящая отправка отчёта: `createApiReportMessenger` против Telegram, который
 * разбирает MarkdownV2 (ТЗ §3.4, §9.2; CLAUDE.md §5).
 *
 * Остальные сценарии отчётности подменяют интерфейс `ReportMessenger`, то есть
 * не проходят через единственное место, где текст становится запросом:
 * `api.sendMessage(..., { parse_mode: 'MarkdownV2' })`. Экранирование там
 * сверялось по сырому тексту, а «Telegram принял бы это» не показывало ничто.
 *
 * Здесь наоборот: транспорт настоящий, а Telegram — msw, который разбирает
 * разметку и отвечает `400 can't parse entities` ровно там, где ответила бы
 * площадка. Имена кампаний и клиента набраны из спецсимволов MarkdownV2
 * специально: их пишет клиент, и «Английский с нуля (Москва) — скидка 20%!» —
 * не выдуманный, а типичный случай.
 */

const TOKEN = '7770001:report-transport-e2e';
const ADMIN_CHAT = 'admin-chat-report';

/** Названия, которые клиент действительно пишет: скобки, точки, дефисы, звёздочки. */
const HOSTILE_CAMPAIGNS = [
  'Английский с нуля (Москва) — скидка 20%!',
  'Ремонт «под ключ» [B2B] | осень+зима',
  'Пицца_24/7 ~ доставка *быстро*',
  'Курсы: {питон} = 3.14 > всех',
  'Тире — и дефис - вместе',
  'Кэшбэк `10%` #промо',
] as const;

let server: SetupServer;
let tg: ReportTelegramMock;
let messenger: ReportMessenger;
let review: WeeklyReviewStub;
let hostile: SeededReportClient;

/** Ровный расход на каждый день недели, включая базу сравнения. */
function week(): Array<{
  ymd: string;
  impressions: number;
  clicks: number;
  spend: number;
  conversions: number;
}> {
  return daysBetween(PREVIOUS_WEEK.from, REPORT_DAY).map((ymd, index) => ({
    ymd,
    impressions: 1_200 + index * 10,
    clicks: 90 + index,
    // Дробные суммы — чтобы в тексте была точка, а не только круглые рубли.
    spend: 3_333.33 + index * 111.11,
    conversions: 4 + (index % 3),
  }));
}

const REVIEW = {
  // Модель пишет обычным текстом: точки, дефисы, скобки и проценты в нём есть всегда.
  summary: 'Неделя ровная: расход +12%, лиды -3% (в пределах шума).',
  worked: ['Поиск по «тортам» держит CPA ниже цели — 480 ₽ против 500 ₽'],
  sagging: [{ problem: 'РСЯ даёт 1 лид/день', proposal: 'Сузить площадки [список в кабинете]' }],
  nextSteps: ['Перелить бюджет из РСЯ в поиск (шаг 20%)', 'Добавить минус-слова по «бесплатно»'],
};

describe('транспорт отчётов: MarkdownV2 против настоящего Telegram', () => {
  beforeAll(async () => {
    await resetDatabase();

    tg = createReportTelegramMock(TOKEN);
    server = setupServer(...tg.handlers);
    // Любой запрос мимо api.telegram.org — сам по себе поломка: отчёты наружу
    // не ходят, а график Telegram разворачивает сам.
    server.listen({ onUnhandledRequest: 'error' });

    messenger = createApiReportMessenger(new Api(TOKEN));
    review = createWeeklyReviewStub(REVIEW);

    hostile = await seedReportClient({
      tgUserId: 991_001n,
      name: 'ООО «Ромашка» (Москва) — реклама #1!',
      campaigns: HOSTILE_CAMPAIGNS.map((name, index) => ({
        alias: `c${index}`,
        externalId: `hostile-${index}`,
        name,
        targetCpa: 500,
        days: week(),
      })),
    });
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    tg.reset();
  });

  it('дневной отчёт с враждебными именами Telegram принимает', async () => {
    const summary = await runDailyReports({
      clientId: hostile.clientId,
      messenger: () => messenger,
      now: () => MORNING_RUN,
    });

    expect(summary.failures).toEqual([]);
    expect(summary.sent).toBe(1);
    expect(tg.refusals).toEqual([]);

    const sent = tg.last();
    expect(sent.chatId).toBe(hostile.chatId);
    expect(sent.parseMode).toBe('MarkdownV2');

    // Текст не просто ушёл — он донёс имена целиком, а не обрезанные до
    // первого спецсимвола.
    const shown = plain(sent.text);
    expect(shown).toContain('ООО «Ромашка» (Москва) — реклама #1!');
    for (const name of HOSTILE_CAMPAIGNS.slice(0, 4)) {
      expect(shown, name).toContain(name.slice(0, 20));
    }
  });

  it('ссылка на график уходит с включённым превью и целым адресом', async () => {
    await runDailyReports({
      clientId: hostile.clientId,
      force: true,
      messenger: () => messenger,
      now: () => MORNING_RUN,
    });

    const sent = tg.last();
    expect(sent.linkPreview).toBe(true);

    const link = /\]\((https:\/\/quickchart\.io\/chart[^)]+)\)/.exec(sent.text);
    expect(link?.[1], `в сообщении нет ссылки на график:\n${sent.text}`).toBeDefined();
    // Адрес внутри `(...)` не должен нести лишних `\`: превью Telegram открывает его как есть.
    expect(link?.[1]).not.toContain('\\');
  });

  it('недельный разбор с текстом модели Telegram принимает', async () => {
    const summary = await runWeeklyReports({
      clientId: hostile.clientId,
      messenger: () => messenger,
      now: () => MORNING_RUN,
      run: review.run,
    });

    expect(summary.failures).toEqual([]);
    expect(tg.refusals).toEqual([]);
    expect(plain(tg.last().text)).toContain(
      'Неделя ровная: расход +12%, лиды -3% (в пределах шума).',
    );
  });

  it('тревога с текстом ошибки площадки Telegram принимает', async () => {
    const cabinet = await seedCabinet(991_002n, 'Кабинет «Ромашки» (осн.)');
    await seedErrors([
      {
        clientId: cabinet.clientId,
        code: 'HTTP_500',
        // Сообщение площадки — чужой текст, и спецсимволов в нём сколько угодно.
        message: 'Yandex.Direct ответил 500: {"error": "internal - retry later"} [req-42]',
        minutes: -5,
        count: 12,
      },
    ]);

    const summary = await runAlertScan({
      chatId: ADMIN_CHAT,
      clientId: cabinet.clientId,
      limiter: new CooldownLimiter(),
      checkSpend: false,
      messenger: () => messenger,
      now: () => at(0),
    });

    await clearErrors();

    expect(summary.sent).toBeGreaterThan(0);
    expect(tg.refusals).toEqual([]);
    expect(tg.last().chatId).toBe(ADMIN_CHAT);
  });

  it('обрезка по лимиту не оставляет разметку разорванной', async () => {
    // Аварийная ветка `clampMarkdown`: одна строка длиннее лимита, резать по
    // границе строк нечего. Пока её никто не проверял парсером, обрыв посреди
    // пары `\.` или внутри `*жирного*` был бы виден только в проде.
    const long = mdRaw(`*${'а'.repeat(TELEGRAM_TEXT_MAX)}*`);
    const clamped = clampMarkdown(long);

    expect(clamped.length).toBeLessThanOrEqual(TELEGRAM_TEXT_MAX);
    await expect(messenger.sendMarkdown(hostile.chatId, clamped)).resolves.toBeDefined();
    expect(tg.refusals).toEqual([]);
  });

  it('обрезка по строкам не оставляет сущность, открытую в одной строке', async () => {
    // Живая ветка `clampMarkdown`: строк много, режем по их границе. Строки отчёта
    // самодостаточны ровно до тех пор, пока никто не открыл `*жирное*` в одной и
    // не закрыл в другой — разбор Telegram про наши намерения не знает. Проверяется
    // не форма результата, а последствие: площадка обязана его принять.
    for (const [open, close] of [
      ['*', '*'],
      ['||', '||'],
      ['```', '```'],
    ]) {
      const filler = `${'строка отчёта'.repeat(20)}\n`;
      const inside = filler.repeat(Math.ceil(TELEGRAM_TEXT_MAX / filler.length) + 1);
      const clamped = clampMarkdown(mdRaw(`${open}\n${inside}${close}\nхвост`));

      expect(clamped.length, open).toBeLessThanOrEqual(TELEGRAM_TEXT_MAX);
      await expect(messenger.sendMarkdown(hostile.chatId, clamped)).resolves.toBeDefined();
    }
    expect(tg.refusals).toEqual([]);
  });

  it('мок не подыгрывает: неэкранированный текст он отвергает так же, как Telegram', async () => {
    // Без этой проверки все зелёные выше ничего не стоят: мок, принимающий что
    // угодно, неотличим от мока, который разбирает разметку.
    await expect(
      messenger.sendMarkdown(hostile.chatId, mdRaw('Пицца_24/7 — доставка. Скидка -20%!')),
    ).rejects.toThrow(/can't parse entities/);

    await expect(
      messenger.sendMarkdown(hostile.chatId, mdRaw('*незакрытый жирный')),
    ).rejects.toThrow(/can't parse entities/);

    await expect(
      messenger.sendMarkdown(hostile.chatId, mdRaw('хвост с висящим слэшем\\')),
    ).rejects.toThrow(/can't parse entities/);

    expect(tg.sent).toEqual([]);
    expect(tg.refusals).toHaveLength(3);
  });

  it('разборщик мока согласен с документацией Bot API', () => {
    // Границы самого мока: он часть проверки, и его собственное поведение
    // должно быть видно, а не подразумеваться.
    expect(() => parseMarkdownV2('Расход: *1 234 ₽* за 20\\.08\\.2026')).not.toThrow();
    expect(() =>
      parseMarkdownV2('[График](https://quickchart.io/chart?c=%7B%22a%22%3A1%7D)'),
    ).not.toThrow();
    expect(() => parseMarkdownV2('```\nбюджет = 5000\n```')).not.toThrow();
    expect(() => parseMarkdownV2('Скидка 20%.')).toThrow(/'\.' is reserved/);
    expect(() => parseMarkdownV2('[подпись](https://a.b')).toThrow(/link entity/);
  });
});
