import { ReportKind } from '@prisma/client';
import { setupServer, type SetupServer } from 'msw/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resetDatabase } from './support/database.js';
import {
  createReportMessengerMock,
  type ReportMessengerMock,
} from './support/reporter-messenger.js';
import { createWeeklyReviewStub, type WeeklyReviewStub } from './support/reporter-review-stub.js';
import {
  addStat,
  BAKERY,
  dateColumn,
  EVENING_RUN,
  int,
  MORNING_RUN,
  PAST_MIDNIGHT_RUN,
  pctChange,
  plain,
  PREVIOUS_DAY,
  PREVIOUS_WEEK,
  ratio,
  REPORT_DAY,
  REPORT_WEEK,
  rub,
  seedBakery,
  seedFlaky,
  seedPaused,
  seedSilent,
  seedTimezone,
  seedWithoutCampaigns,
  spendByDayFromDb,
  totalsFromDb,
  type SeededReportClient,
} from './support/reporter-seed.js';

import { prisma } from '@/db/prisma.js';
import {
  CooldownLimiter,
  NO_DATA_NOTE,
  PROVISIONAL_NOTE,
  runAlertScan,
  runDailyReports,
  runWeeklyReports,
  setReportMessenger,
  WEEKLY_PROMPT_VERSION,
  WEEKLY_SYSTEM_PROMPT,
} from '@/reporter/index.js';

/**
 * Сквозной прогон отчётности на живом Postgres (ТЗ §3.4, §9.2, §13.6).
 *
 * Отчёт — единственный канал, через который человек узнаёт, что происходит с
 * его деньгами, и «сообщение ушло» о нём не говорит ничего. Поэтому здесь
 * каждая цифра сообщения сверяется с суммой, посчитанной отдельным запросом к
 * той же базе, а границы суток — с колонкой `@db.Date` в строке `Report`.
 *
 * Наружу не уходит ничего: msw поднят без единого обработчика и с
 * `onUnhandledRequest: 'error'`, транспорт Telegram подменён, недельный вызов
 * модели заменён детерминированной заглушкой (CLAUDE.md §5). Живая только наша
 * БД — мокать её запрещено.
 *
 * У каждого сценария свой клиент: прогон обходит всех активных разом, и общий
 * клиент означал бы, что сводка одного сценария складывается из строк другого.
 */

const REVIEW = {
  summary: 'Неделя ровная: расход и лиды выросли на несколько процентов.',
  worked: ['Поиск по тортам держит CPA ниже цели'],
  sagging: [{ problem: 'РСЯ приносит один лид в день', proposal: 'Сузить площадки' }],
  nextSteps: ['Перелить бюджет из РСЯ в поиск', 'Добавить минус-слова по «бесплатно»'],
};

let server: SetupServer;
let tg: ReportMessengerMock;
let review: WeeklyReviewStub;
let bakery: SeededReportClient;
let silent: SeededReportClient;
let bare: SeededReportClient;
let paused: SeededReportClient;
let flaky: SeededReportClient;
let tz: SeededReportClient;

/** Зависимости прогона: живая БД, подменённый транспорт, фиксированный момент. */
function deps(now: Date = MORNING_RUN): { messenger: () => ReportMessengerMock; now: () => Date } {
  return { messenger: () => tg, now: () => now };
}

/** Тело последнего сообщения со снятым экранированием MarkdownV2. */
function lastPlain(): string {
  return plain(tg.last().text);
}

function chartUrlOf(text: string): string {
  const match = /\]\((https:\/\/quickchart\.io\/chart[^)]+)\)/.exec(text);
  if (!match?.[1]) throw new Error(`в сообщении нет ссылки на график:\n${text}`);
  return match[1];
}

/** Прогон под чужой таймзоной процесса: даты отчёта обязаны остаться московскими. */
async function withTz<T>(zone: string, run: () => Promise<T>): Promise<T> {
  const before = process.env['TZ'];
  process.env['TZ'] = zone;
  try {
    return await run();
  } finally {
    if (before === undefined) delete process.env['TZ'];
    else process.env['TZ'] = before;
  }
}

describe('отчёты клиенту: дневной и недельный', () => {
  beforeAll(async () => {
    await resetDatabase();

    // Ни одного обработчика: любой сетевой вызов — сам по себе поломка. Отчёты
    // не ходят наружу вовсе, и проверяется здесь именно это.
    server = setupServer();
    server.listen({ onUnhandledRequest: 'error' });

    tg = createReportMessengerMock();
    review = createWeeklyReviewStub(REVIEW);
    // Глобальный транспорт остаётся пустым: путь без явной подстановки обязан
    // падать на отсутствующем токене, а не молча уходить в настоящий Telegram.
    setReportMessenger(null);

    bakery = await seedBakery();
    silent = await seedSilent();
    bare = await seedWithoutCampaigns();
    paused = await seedPaused();
    flaky = await seedFlaky();
    tz = await seedTimezone();
  });

  afterAll(async () => {
    server?.close();
    setReportMessenger(null);
    await prisma.$disconnect();
  });

  describe('дневной отчёт', () => {
    it('собран за вчерашние сутки МСК и сходится с суммами в базе', async () => {
      const summary = await runDailyReports({ clientId: bakery.clientId, ...deps() });

      expect(summary).toMatchObject({
        period: { from: REPORT_DAY, to: REPORT_DAY },
        clients: 1,
        sent: 1,
        skipped: 0,
        failures: [],
      });

      // Границы периода лежат в колонке `@db.Date`: любой лишний сдвиг на
      // часовой пояс виден здесь сразу, до всякого текста.
      const report = await prisma.report.findFirstOrThrow({
        where: { clientId: bakery.clientId, kind: ReportKind.DAILY },
      });
      expect(report.periodFrom.toISOString()).toBe(dateColumn(REPORT_DAY).toISOString());
      expect(report.periodTo.toISOString()).toBe(dateColumn(REPORT_DAY).toISOString());
      expect(report.sentAt).not.toBeNull();

      expect(tg.sent).toHaveLength(1);
      expect(tg.last().chatId).toBe(bakery.chatId);
      // Превью обязано быть включено: без него ссылка на график остаётся ссылкой,
      // а картинку, ради которой она в сообщении, никто не увидит.
      expect(tg.last().linkPreview).toBe(true);
      // Отправлено ровно то, что сохранено: иначе переотправка после сбоя пошлёт другой текст.
      expect(tg.last().text).toBe(report.body);

      const day = await totalsFromDb(bakery.allCampaignIds, { from: REPORT_DAY, to: REPORT_DAY });
      const base = await totalsFromDb(bakery.allCampaignIds, {
        from: PREVIOUS_DAY,
        to: PREVIOUS_DAY,
      });
      expect(day.conversions).toBeGreaterThan(0);

      const text = lastPlain();
      expect(text).toContain('📊 *Отчёт за 20.08.2026* — Пекарня «Хлеб и Соль»');
      expect(text).toContain(
        `Расход: *${rub(day.spend)}* ↑ ${pctChange(day.spend, base.spend)} к 19.08.2026`,
      );
      expect(text).toContain(
        `Лиды: *${int(day.conversions)}* ↑ ${pctChange(day.conversions, base.conversions)} (было ${int(base.conversions)})`,
      );
      expect(text).toContain(
        `CPA: *${rub(day.spend / day.conversions)}* (было ${rub(base.spend / base.conversions)})`,
      );
      expect(text).toContain(
        `Клики: ${int(day.clicks)} · CTR ${ratio(day.clicks / day.impressions)}`,
      );
      expect(text).toContain(PROVISIONAL_NOTE);
      expect(text).toContain('Конверсии и CPA — по атрибуции рекламного кабинета, не по Метрике.');
      // Период полный: оговорке о дырках в данных взяться неоткуда.
      expect(text).not.toContain('Данные неполные');
      expect(text).not.toContain(NO_DATA_NOTE);
    });

    it('строки по кампаниям повторяют разрез базы, а не общий итог', async () => {
      const text = lastPlain();

      const search = await totalsFromDb([bakery.campaignIds[BAKERY.search] as string], {
        from: REPORT_DAY,
        to: REPORT_DAY,
      });
      const network = await totalsFromDb([bakery.campaignIds[BAKERY.network] as string], {
        from: REPORT_DAY,
        to: REPORT_DAY,
      });

      expect(text).toContain(
        `• Поиск — торты (Москва) — ${rub(search.spend)}, лидов ${int(search.conversions)}, CPA ${rub(search.spend / search.conversions)}`,
      );
      expect(text).toContain(
        `• РСЯ — доставка — ${rub(network.spend)}, лидов ${int(network.conversions)}, CPA ${rub(network.spend / network.conversions)}`,
      );

      // Порядок по расходу: дороже — выше. Иначе самое важное уезжает под срез.
      expect(text.indexOf('• Поиск — торты')).toBeLessThan(text.indexOf('• РСЯ — доставка'));
    });

    it('аномалия названа по кампании, а не по клиенту целиком', async () => {
      const text = lastPlain();

      // Расход поисковой кампании вырос ровно в полтора раза (порог всплеска —
      // 50%), а по клиенту целиком — на 40%. Значит проблема ровно одна и она
      // адресная: «в целом» здесь было бы ложью, на которую нечего ответить.
      expect(text).toContain('*Топ проблем*');
      expect(text).toContain(
        '⚠️ «Поиск — торты (Москва)»: расход вырос на 50% — 3 000 ₽ против 2 000 ₽',
      );
      expect(text).not.toContain('В целом:');
      expect(text).not.toContain('Ничего требующего внимания не нашлось.');
    });

    it('имя кампании экранировано: неэкранированная скобка роняет отправку целиком', () => {
      // Проверяется сырое тело, а не снятое: MarkdownV2 считает `(`, `)` и `.`
      // спецсимволами, и отчёт клиента с такими символами в названии уходил бы
      // в 400 «can't parse entities» — причём только у него одного.
      expect(tg.last().text).toContain('Поиск — торты \\(Москва\\)');
      expect(tg.last().text).toContain('Отчёт за 20\\.08\\.2026');
      expect(tg.last().text).not.toContain('торты (Москва)');
    });

    it('график построен по тем же дням, что лежат в базе', async () => {
      const url = new URL(chartUrlOf(tg.last().text));
      const config = JSON.parse(url.searchParams.get('c') ?? '{}') as {
        data: { labels: string[]; datasets: Array<{ data: number[] }> };
      };

      const window = { from: '2026-08-07', to: REPORT_DAY };
      const spendByDay = await spendByDayFromDb(bakery.allCampaignIds, window);

      expect(config.data.labels).toHaveLength(14);
      expect(config.data.labels.at(-1)).toBe('20 авг');
      expect(config.data.labels[0]).toBe('7 авг');
      expect(config.data.datasets[0]?.data.at(-1)).toBe(
        Math.round(spendByDay.get(REPORT_DAY) ?? 0),
      );
      expect(config.data.datasets[0]?.data[0]).toBe(Math.round(spendByDay.get('2026-08-07') ?? 0));
      // Ссылка ушла без экранированных скобок: их Telegram в URL не развернёт.
      expect(url.toString()).not.toContain('\\');
    });

    it('слепок метрик сохранён вместе с текстом', async () => {
      const report = await prisma.report.findFirstOrThrow({
        where: { clientId: bakery.clientId, kind: ReportKind.DAILY },
      });
      const metrics = report.metrics as {
        kind: string;
        totals: { spend: number; conversions: number };
        previousTotals: { spend: number };
        anomalies: Array<{ kind: string }>;
      };
      const day = await totalsFromDb(bakery.allCampaignIds, { from: REPORT_DAY, to: REPORT_DAY });

      expect(metrics.kind).toBe('daily');
      expect(metrics.totals.spend).toBe(day.spend);
      expect(metrics.totals.conversions).toBe(day.conversions);
      expect(metrics.previousTotals.spend).toBe(2500);
      expect(metrics.anomalies.map((a) => a.kind)).toEqual(['spend_spike']);
    });

    it('повторный прогон тех же суток не шлёт второе сообщение', async () => {
      const summary = await runDailyReports({ clientId: bakery.clientId, ...deps() });

      expect(summary).toMatchObject({ clients: 1, sent: 0, skipped: 1, failures: [] });
      expect(tg.sent).toHaveLength(1);
      expect(
        await prisma.report.count({ where: { clientId: bakery.clientId, kind: ReportKind.DAILY } }),
      ).toBe(1);
    });
  });

  describe('границы суток', () => {
    it('вечерний и ночной запуск дают те же сутки, что утренний крон', async () => {
      const runs = [
        { label: 'утро 08:30 МСК', now: MORNING_RUN, tz: 'Europe/Moscow' },
        // UTC+14: по местному календарю уже 22 августа. Наивное «вчера» дало бы
        // 21-е — сутки, за которые статистики нет вовсе.
        { label: 'вечер 21:30 МСК', now: EVENING_RUN, tz: 'Pacific/Kiritimati' },
        // UTC−11: по местному календарю ещё 20 августа.
        { label: 'ночь 00:30 МСК', now: PAST_MIDNIGHT_RUN, tz: 'Pacific/Niue' },
      ];

      const bodies: string[] = [];
      for (const run of runs) {
        const summary = await withTz(run.tz, () =>
          runDailyReports({ clientId: tz.clientId, force: true, ...deps(run.now) }),
        );
        expect({ label: run.label, ...summary }).toMatchObject({
          label: run.label,
          period: { from: REPORT_DAY, to: REPORT_DAY },
          sent: 1,
          failures: [],
        });
        bodies.push(tg.last().text);
      }

      // Один и тот же отчёт трижды: если бы граница суток зависела от таймзоны
      // машины, тексты разошлись бы — и клиент получил бы отчёт за чужой день.
      expect(new Set(bodies).size).toBe(1);
      expect(plain(bodies[0] as string)).toContain('📊 *Отчёт за 20.08.2026*');

      // Строка `Report` по-прежнему одна: уникальный ключ держится на датах периода.
      const rows = await prisma.report.findMany({
        where: { clientId: tz.clientId, kind: ReportKind.DAILY },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.periodFrom.toISOString()).toBe(dateColumn(REPORT_DAY).toISOString());
    });
  });

  describe('недоставленный отчёт', () => {
    it('переживает сбой Telegram и уходит со второй попытки тем же текстом', async () => {
      const sentBefore = tg.sent.length;
      tg.failNext(1);

      const failed = await runDailyReports({ clientId: flaky.clientId, ...deps() });
      expect(failed).toMatchObject({ clients: 1, sent: 0, skipped: 0 });
      expect(failed.failures).toHaveLength(1);
      expect(failed.failures[0]?.message).toContain('Failed to deliver report');
      expect(tg.sent).toHaveLength(sentBefore);

      const saved = await prisma.report.findFirstOrThrow({
        where: { clientId: flaky.clientId, kind: ReportKind.DAILY },
      });
      // Тело уже в базе: посчитанный отчёт не должен уезжать вместе с Telegram.
      expect(saved.sentAt).toBeNull();
      expect(saved.body).toContain('1 500');

      // Между попытками доехала ещё одна строка статистики. Пересчёт показал бы
      // другую сумму — значит по тексту видно, переиспользован отчёт или собран заново.
      await addStat(flaky.campaignIds['late'] as string, {
        ymd: REPORT_DAY,
        impressions: 1_000,
        clicks: 50,
        spend: 999,
        conversions: 1,
      });

      const retried = await runDailyReports({ clientId: flaky.clientId, ...deps() });
      expect(retried).toMatchObject({ clients: 1, sent: 1, failures: [] });
      expect(tg.sent).toHaveLength(sentBefore + 1);
      expect(tg.last().text).toBe(saved.body);
      expect(lastPlain()).toContain(rub(1_500));
      expect(lastPlain()).not.toContain(rub(2_499));

      const marked = await prisma.report.findUniqueOrThrow({ where: { id: saved.id } });
      expect(marked.sentAt).not.toBeNull();
    });

    it('отказ записан в ErrorLog — и одиночной записи не хватает ни на одну тревогу', async () => {
      const failures = await prisma.errorLog.findMany({ where: { scope: 'reporter:daily' } });
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ clientId: flaky.clientId, code: 'REPORT_FAILED' });
      expect(failures[0]?.message).toContain('Failed to deliver report');

      // И вот цена этой записи. `now` здесь настоящий — строка создана секунду
      // назад и лежит в самом центре окна всплеска.
      const scan = await runAlertScan({
        chatId: 'admin-chat',
        messenger: () => tg,
        now: () => new Date(),
        limiter: new CooldownLimiter(),
        checkSpend: false,
      });

      // ДЕФЕКТ (описан в отчёте, не чинится здесь): порог всплеска — больше 10
      // ошибок за 5 минут в одном бакете, а код `REPORT_FAILED` не входит ни в
      // набор авторизационных, ни в набор units. Значит недоставленный отчёт не
      // поднимает тревогу никогда: человек узнаёт о нём, только если сам полезет
      // в `ErrorLog`. «Записали в журнал» и «сообщили человеку» — разные вещи.
      expect(scan).toMatchObject({ detected: 0, sent: 0, suppressed: 0 });
    });
  });

  describe('недельный разбор', () => {
    it('дневной отчёт модель не звал ни разу', () => {
      // Дневной отчёт считается кодом целиком. Вызов модели здесь стоил бы денег
      // клиента каждое утро и не добавил бы ни одной цифры.
      expect(review.calls).toHaveLength(0);
    });

    it('собран за последние семь полных суток и показывает разбор модели', async () => {
      const summary = await runWeeklyReports({
        clientId: bakery.clientId,
        run: review.run,
        ...deps(),
      });

      expect(summary).toMatchObject({
        period: { from: REPORT_WEEK.from, to: REPORT_WEEK.to },
        clients: 1,
        sent: 1,
        degraded: 0,
        failures: [],
      });
      expect(review.calls).toHaveLength(1);

      const week = await totalsFromDb(bakery.allCampaignIds, REPORT_WEEK);
      const before = await totalsFromDb(bakery.allCampaignIds, PREVIOUS_WEEK);

      const text = lastPlain();
      expect(text).toContain('📈 *Недельный разбор (14.08 — 20.08.2026)* — Пекарня «Хлеб и Соль»');
      expect(text).toContain(
        `Расход: *${rub(week.spend)}* ↑ ${pctChange(week.spend, before.spend)} к прошлой`,
      );
      expect(text).toContain(
        `Лиды: *${int(week.conversions)}* ↑ ${pctChange(week.conversions, before.conversions)} (было ${int(before.conversions)})`,
      );
      expect(text).toContain(
        `CPA: *${rub(week.spend / week.conversions)}* (было ${rub(before.spend / before.conversions)},`,
      );
      expect(text).toContain(
        `Клики: ${int(week.clicks)} · CTR ${ratio(week.clicks / week.impressions)}`,
      );

      expect(text).toContain(REVIEW.summary);
      expect(text).toContain('*Что сработало*');
      expect(text).toContain(`✅ ${REVIEW.worked[0]}`);
      expect(text).toContain('*Что проседает*');
      expect(text).toContain(`⚠️ ${REVIEW.sagging[0]?.problem}`);
      expect(text).toContain(`→ ${REVIEW.sagging[0]?.proposal}`);
      expect(text).toContain('*Планы на след. неделю*');
      expect(text).toContain(`1. ${REVIEW.nextSteps[0]}`);
      expect(text).toContain(`2. ${REVIEW.nextSteps[1]}`);
      expect(text).toContain(PROVISIONAL_NOTE);
    });

    it('модель получила ровно те факты, что лежат в базе', async () => {
      const facts = review.lastFacts() as {
        period: { from: string; to: string; label: string };
        previousPeriod: { from: string; to: string };
        totals: { spend: number; conversions: number; clicks: number; impressions: number };
        previousTotals: { spend: number };
        changes: { spendPct: number; conversionsPct: number };
        campaigns: Array<{ name: string; spend: number; previousSpend: number }>;
        anomalies: unknown[];
        notes: string[];
      };
      const week = await totalsFromDb(bakery.allCampaignIds, REPORT_WEEK);
      const before = await totalsFromDb(bakery.allCampaignIds, PREVIOUS_WEEK);

      // Смысл проверки: модель объясняет словами то, что ей дали. Разъедься
      // факты с базой — разбор был бы уверенным рассказом про чужие цифры.
      expect(facts.period).toEqual({
        from: REPORT_WEEK.from,
        to: REPORT_WEEK.to,
        label: '14.08 — 20.08.2026',
      });
      expect(facts.previousPeriod).toMatchObject({
        from: PREVIOUS_WEEK.from,
        to: PREVIOUS_WEEK.to,
      });
      expect(facts.totals).toMatchObject({
        spend: week.spend,
        conversions: week.conversions,
        clicks: week.clicks,
        impressions: week.impressions,
      });
      expect(facts.previousTotals.spend).toBe(before.spend);
      expect(facts.changes.spendPct).toBe(
        Math.round(((week.spend - before.spend) / before.spend) * 100),
      );
      expect(facts.campaigns.map((c) => c.name)).toEqual([
        'Поиск — торты (Москва)',
        'РСЯ — доставка',
      ]);
      expect(facts.campaigns[0]?.spend).toBe(15_000);
      expect(facts.campaigns[0]?.previousSpend).toBe(14_000);
      expect(facts.anomalies).toEqual([]);
      // Оговорка про дозаезд конверсий обязана быть и в промпте: без неё модель
      // объяснит словами просадку, которой не было.
      expect(facts.notes).toContain(PROVISIONAL_NOTE);

      const call = review.calls[0];
      // Вызов идёт задачей `analytics.weekly` — только так стоимость попадает в
      // `AiRun` и в месячный бюджет клиента (ТЗ §13).
      expect(call).toMatchObject({
        agent: 'analytics-weekly',
        task: 'analytics.weekly',
        clientId: bakery.clientId,
        system: WEEKLY_SYSTEM_PROMPT,
        schemaName: `weekly-review@${WEEKLY_PROMPT_VERSION}`,
      });
    });

    it('отличается от дневного периодом, разделом планов и графиком', async () => {
      const daily = await prisma.report.findFirstOrThrow({
        where: { clientId: bakery.clientId, kind: ReportKind.DAILY },
      });
      const weekly = await prisma.report.findFirstOrThrow({
        where: { clientId: bakery.clientId, kind: ReportKind.WEEKLY },
      });

      // Один клиент, две строки: вид отчёта входит в уникальный ключ, иначе
      // понедельничный разбор затирал бы утренний отчёт.
      expect(weekly.periodFrom.toISOString()).toBe(dateColumn(REPORT_WEEK.from).toISOString());
      expect(weekly.periodTo.toISOString()).toBe(dateColumn(REPORT_WEEK.to).toISOString());
      expect(daily.periodFrom.toISOString()).toBe(dateColumn(REPORT_DAY).toISOString());

      const dailyText = plain(daily.body);
      const weeklyText = plain(weekly.body);

      expect(dailyText).toContain('📊 *Отчёт за 20.08.2026*');
      expect(dailyText).toContain('*Топ проблем*');
      expect(dailyText).toContain('График за 14 дней');
      expect(dailyText).not.toContain('Планы на след. неделю');

      expect(weeklyText).toContain('📈 *Недельный разбор');
      expect(weeklyText).toContain('*Планы на след. неделю*');
      expect(weeklyText).toContain('График по дням');
      expect(weeklyText).not.toContain('Топ проблем');

      // График недели — по дням недели, а не по двум неделям дневного отчёта.
      const weeklyConfig = JSON.parse(
        new URL(chartUrlOf(weekly.body)).searchParams.get('c') ?? '{}',
      ) as { data: { labels: string[] } };
      expect(weeklyConfig.data.labels).toHaveLength(7);
      expect(weeklyConfig.data.labels[0]).toBe('14 авг');

      const metrics = weekly.metrics as { kind: string; degraded: boolean; promptVersion: string };
      expect(metrics.kind).toBe('weekly');
      expect(metrics.degraded).toBe(false);
      expect(metrics.promptVersion).toBe(WEEKLY_PROMPT_VERSION);
    });

    it('повторный прогон не шлёт второй разбор и не платит за модель заново', async () => {
      const summary = await runWeeklyReports({
        clientId: bakery.clientId,
        run: review.run,
        ...deps(),
      });

      expect(summary).toMatchObject({ clients: 1, sent: 0, skipped: 1, failures: [] });
      expect(review.calls).toHaveLength(1);
    });

    it('упавшая модель не отменяет понедельник: уходят цифры без разбора', async () => {
      const sentBefore = tg.sent.length;
      review.failNext(1);

      const summary = await runWeeklyReports({
        clientId: bakery.clientId,
        period: { from: PREVIOUS_WEEK.from, to: PREVIOUS_WEEK.to },
        run: review.run,
        ...deps(),
      });

      expect(summary).toMatchObject({ clients: 1, sent: 1, degraded: 1, failures: [] });
      expect(tg.sent).toHaveLength(sentBefore + 1);

      const week = await totalsFromDb(bakery.allCampaignIds, PREVIOUS_WEEK);
      const text = lastPlain();
      expect(text).toContain('📈 *Недельный разбор (07.08 — 13.08.2026)*');
      expect(text).toContain(`Расход: *${rub(week.spend)}*`);
      expect(text).toContain('AI-разбор недоступен — ниже только цифры и аномалии.');
      expect(text).not.toContain(REVIEW.summary);

      // Базы у этого периода нет вовсе — процент к ней был бы выдумкой.
      expect(text).toContain('(за прошлую неделю данных нет)');
      expect(text).not.toContain('к прошлой');

      const stored = await prisma.report.findFirstOrThrow({
        where: {
          clientId: bakery.clientId,
          kind: ReportKind.WEEKLY,
          periodFrom: dateColumn(PREVIOUS_WEEK.from),
        },
      });
      // Признак деградации лежит в строке: переотправка обязана знать, что она
      // шлёт разбор без модели, а не полноценный.
      expect((stored.metrics as { degraded: boolean }).degraded).toBe(true);
    });
  });

  describe('клиент без данных', () => {
    it('отчёт не падает и прямым текстом говорит, что это не нулевой расход', async () => {
      const sentBefore = tg.sent.length;

      const summary = await runDailyReports({ clientId: silent.clientId, ...deps() });
      expect(summary).toMatchObject({ clients: 1, sent: 1, failures: [] });
      expect(tg.sent).toHaveLength(sentBefore + 1);

      const text = lastPlain();
      // Отчёт с нулями здесь читался бы как обвал расхода, а рациональная
      // реакция на обвал — остановить рекламу и звонить площадке.
      expect(text).toContain(NO_DATA_NOTE);
      expect(text).toContain(PROVISIONAL_NOTE);
      expect(text).not.toContain('Расход:');
      expect(text).not.toContain('0 ₽');
      expect(text).not.toContain('quickchart.io');

      // Сообщение всё-таки уходит — и это осознанный выбор кода, а не недосмотр:
      // молчание неотличимо от «всё хорошо». Цена решения в том, что клиент, у
      // которого кампании ещё не запущены, получает такое письмо каждое утро.
      expect(tg.last().chatId).toBe(silent.chatId);
    });

    it('клиент вовсе без кампаний обрабатывается так же и не роняет прогон', async () => {
      const summary = await runDailyReports({ clientId: bare.clientId, ...deps() });

      expect(summary).toMatchObject({ clients: 1, sent: 1, failures: [] });
      expect(lastPlain()).toContain(NO_DATA_NOTE);
    });

    it('недельный разбор без данных не идёт в модель', async () => {
      const callsBefore = review.calls.length;

      const summary = await runWeeklyReports({
        clientId: silent.clientId,
        run: review.run,
        ...deps(),
      });

      expect(summary).toMatchObject({ clients: 1, sent: 1, failures: [] });
      // Разбирать нечего, а вызов стоит денег клиента: модель не должна звучать вовсе.
      expect(review.calls).toHaveLength(callsBefore);
      expect(lastPlain()).toContain(NO_DATA_NOTE);

      // ДЕФЕКТ (описан в отчёте, здесь не чинится): в сводке такой прогон
      // помечен как деградировавший, хотя модель не падала — её осознанно не
      // звали. Поле `degraded` объявлено как «модель упала, а отчёт всё равно
      // ушёл», а считается по «разбора нет», и эти два условия совпадают не
      // всегда. Цена: партия новых клиентов без данных читается по сводке как
      // отказ провайдера LLM, а настоящий отказ среди них — как норма.
      expect(summary.degraded).toBe(1);
      const stored = await prisma.report.findFirstOrThrow({
        where: { clientId: silent.clientId, kind: ReportKind.WEEKLY },
      });
      expect((stored.metrics as { degraded: boolean; aiRunId: string | null }).degraded).toBe(true);
    });
  });

  describe('прогон по всем клиентам', () => {
    it('обходит только активных и не роняет остальных из-за одного', async () => {
      tg.reset();

      const summary = await runDailyReports({
        period: { from: '2026-08-18', to: '2026-08-18' },
        ...deps(),
      });

      const recipients = new Set(tg.sent.map((message) => message.chatId));
      expect(recipients).toEqual(
        new Set([bakery.chatId, silent.chatId, bare.chatId, flaky.chatId, tz.chatId]),
      );
      // Остановленный клиент платит за паузу и отчётов не ждёт.
      expect(recipients.has(paused.chatId)).toBe(false);
      expect(summary).toMatchObject({ clients: 5, sent: 5, failures: [] });
    });
  });
});
