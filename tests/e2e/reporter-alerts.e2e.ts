import { setupServer, type SetupServer } from 'msw/node';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { resetDatabase } from './support/database.js';
import {
  at,
  clearErrors,
  SCAN_AT,
  seedCabinet,
  seedErrors,
  seedSpendCollapse,
  seedSpendSpike,
  seedSpendSteady,
} from './support/reporter-alerts-seed.js';
import {
  createReportMessengerMock,
  type ReportMessengerMock,
} from './support/reporter-messenger.js';
import { plain, type SeededReportClient } from './support/reporter-seed.js';

import { prisma } from '@/db/prisma.js';
import { env } from '@/env.js';
import {
  ALERT_SCAN_INTERVAL_MINUTES,
  CooldownLimiter,
  ERROR_BURST_THRESHOLD,
  ERROR_LOOKBACK_MINUTES,
  ERROR_LOOKBACK_OVERLAP_MINUTES,
  ERROR_WINDOW_MINUTES,
  MAX_ALERTS_PER_RUN,
  PROVIDER_BURST_THRESHOLD,
  runAlertScan,
  setReportMessenger,
  SPEND_ALERT_COOLDOWN_MS,
  type AlertOptions,
  type AlertRunSummary,
} from '@/reporter/index.js';

/**
 * Сквозной прогон тревог на живом Postgres (ТЗ §3.6, CLAUDE.md §9).
 *
 * Тревоги — последний рубеж: когда отчёты уже не помогут, человек узнаёт о
 * поломке отсюда или ниоткуда. Поэтому здесь проверяются границы, а не
 * happy path: сколько ошибок ещё молчат и сколько уже кричат, что считается
 * одной поломкой, сколько длится тишина и что происходит, когда слать некуда.
 *
 * Наружу не уходит ничего: msw поднят без обработчиков и с
 * `onUnhandledRequest: 'error'`, транспорт Telegram подменён. Модель тревоги не
 * зовут вовсе — правила здесь арифметические. Живая только наша БД.
 *
 * Ограничитель повторов у каждого сценария свой: общий `alertLimiter` — глобал
 * процесса, и на нём сценарии тихо гасили бы тревоги друг другу.
 */

const ADMIN_CHAT = 'admin-chat-1';

let server: SetupServer;
let tg: ReportMessengerMock;
let limiter: CooldownLimiter;
let alpha: SeededReportClient;
let beta: SeededReportClient;
let spike: SeededReportClient;
let collapse: SeededReportClient;
let steady: SeededReportClient;

function scan(options: Partial<AlertOptions> = {}): Promise<AlertRunSummary> {
  return runAlertScan({
    chatId: ADMIN_CHAT,
    messenger: () => tg,
    now: () => SCAN_AT,
    limiter,
    // По умолчанию расход не трогаем: он читает восьмидневное окно по каждому
    // клиенту и зашумил бы сценарии про ошибки чужими тревогами.
    checkSpend: false,
    ...options,
  });
}

function kindsOf(summary: AlertRunSummary): string[] {
  return summary.alerts.map((alert) => alert.kind).sort();
}

describe('тревоги администратору', () => {
  beforeAll(async () => {
    await resetDatabase();

    server = setupServer();
    server.listen({ onUnhandledRequest: 'error' });

    tg = createReportMessengerMock();
    setReportMessenger(null);

    alpha = await seedCabinet(880000011n, 'Кабинет «Альфа»');
    beta = await seedCabinet(880000012n, 'Кабинет «Бета»');
    spike = await seedSpendSpike();
    collapse = await seedSpendCollapse();
    steady = await seedSpendSteady();
  });

  afterAll(async () => {
    server?.close();
    setReportMessenger(null);
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await clearErrors();
    tg.reset();
    limiter = new CooldownLimiter();
  });

  describe('всплеск ошибок', () => {
    it('десять ошибок за пять минут молчат, одиннадцатая поднимает тревогу', async () => {
      // ТЗ §3.6 говорит «больше 10 за 5 минут». Граница проверяется с обеих
      // сторон: порог, сдвинутый на единицу, — это либо молчащая тревога, либо
      // чат, который перестают читать.
      expect(ERROR_BURST_THRESHOLD).toBe(10);
      expect(ERROR_WINDOW_MINUTES).toBe(5);

      await seedErrors([
        {
          clientId: alpha.clientId,
          provider: 'YANDEX_DIRECT',
          code: 'HTTP_500',
          minutes: -4,
          count: 10,
        },
      ]);

      const quiet = await scan();
      expect(quiet).toMatchObject({ detected: 0, sent: 0, suppressed: 0 });
      expect(tg.sent).toHaveLength(0);

      await seedErrors([
        { clientId: alpha.clientId, provider: 'YANDEX_DIRECT', code: 'HTTP_500', minutes: -3 },
      ]);

      const loud = await scan();
      expect(loud).toMatchObject({ detected: 1, sent: 1, suppressed: 0, truncated: 0 });
      expect(loud.alerts[0]).toMatchObject({
        kind: 'error_burst',
        severity: 'critical',
        clientId: alpha.clientId,
        provider: 'YANDEX_DIRECT',
      });

      expect(tg.sent).toHaveLength(1);
      expect(tg.last().chatId).toBe(ADMIN_CHAT);
      const text = plain(tg.last().text);
      expect(text).toContain('🚨 *11 ошибок за 5 мин*');
      expect(text).toContain(`Кабинет: YANDEX_DIRECT / ${alpha.clientId} / clients:yandex-direct`);
      // Время первой ошибки — по МСК, а не по таймзоне машины: человек сверяет
      // его с графиками кабинета, и час разницы стоит дороже всего сообщения.
      expect(text).toContain('Первая: 08:26');
      expect(text).toContain('HTTP_500: 11');
    });

    it('окно всплеска — ровно пять минут, хотя из журнала выбирается больше', async () => {
      // Выборка заходит за окно на период крона: без этого разовые поводы (401,
      // units) терялись бы на пропущенном тике. Но всплеск обязан считаться
      // строго по окну — иначе порог из ТЗ на деле оказывается ниже заявленного.
      await seedErrors([
        {
          clientId: alpha.clientId,
          provider: 'VK_ADS',
          code: 'HTTP_500',
          minutes: -6,
          count: 5,
        },
        {
          clientId: alpha.clientId,
          provider: 'VK_ADS',
          code: 'HTTP_500',
          minutes: -2,
          count: 10,
        },
      ]);

      const summary = await scan();

      // Пятнадцать строк в выборке, десять в окне — тревоги нет.
      expect(await prisma.errorLog.count()).toBe(15);
      expect(summary).toMatchObject({ detected: 0, sent: 0 });
      expect(tg.sent).toHaveLength(0);
    });

    /**
     * Было сломано: порог всплеска считался только по бакету «клиент +
     * площадка», и общая поломка площадки, поделённая между кабинетами поровну,
     * не перебирала порог ни в одном бакете. Двенадцать ошибок за пять минут
     * давали тишину: отвалившаяся у всех сразу площадка выглядела как норма.
     * Теперь тот же счёт идёт и по площадке целиком.
     */
    it('поломка, размазанная по двум кабинетам, поднимает тревогу по площадке', async () => {
      await seedErrors([
        { clientId: alpha.clientId, provider: 'YANDEX_DIRECT', minutes: -3, count: 6 },
        { clientId: beta.clientId, provider: 'YANDEX_DIRECT', minutes: -3, count: 6 },
      ]);

      const summary = await scan();

      expect(kindsOf(summary)).toEqual(['provider_burst']);
      expect(summary).toMatchObject({ detected: 1, sent: 1, suppressed: 0, truncated: 0 });
      expect(summary.alerts[0]).toMatchObject({
        severity: 'critical',
        // Клиента нет намеренно: поломка не принадлежит ни одному кабинету.
        clientId: null,
        provider: 'YANDEX_DIRECT',
      });

      const text = plain(tg.last().text);
      expect(text).toContain('🚨 *12 ошибок YANDEX_DIRECT за 5 мин*');
      expect(text).toContain('Кабинетов задето: 2');

      // Порог по площадке — тот же, что по кабинету: ниже он превратил бы
      // тревогу в фоновый шум от площадки с сотней клиентов.
      expect(PROVIDER_BURST_THRESHOLD).toBe(ERROR_BURST_THRESHOLD);
    });

    it('поломка площадки отменяет кабинетные всплески, а не добавляется к ним', async () => {
      await seedErrors([
        { clientId: alpha.clientId, provider: 'VK_ADS', minutes: -3, count: 11 },
        { clientId: beta.clientId, provider: 'VK_ADS', minutes: -3, count: 4 },
      ]);

      const summary = await scan();

      // Громкий кабинет сам перебирает порог, но разговор идёт о площадке: два
      // сообщения об одной поломке — начало флуда, а не полнота картины. Именно
      // это удерживает от спама отвалившуюся площадку с полусотней клиентов.
      expect(kindsOf(summary)).toEqual(['provider_burst']);
      expect(tg.sent).toHaveLength(1);
      expect(plain(tg.last().text)).toContain(`${alpha.clientId}: 11`);
    });

    it('всплеск одного кабинета остаётся кабинетным и называет кабинет', async () => {
      await seedErrors([{ clientId: alpha.clientId, provider: 'VK_ADS', minutes: -3, count: 11 }]);

      const summary = await scan();

      expect(kindsOf(summary)).toEqual(['error_burst']);
      expect(summary.alerts[0]).toMatchObject({ clientId: alpha.clientId, provider: 'VK_ADS' });
    });

    it('одиночная запись в журнале без своего повода никого не будит', async () => {
      await seedErrors([
        {
          clientId: alpha.clientId,
          provider: 'YANDEX_DIRECT',
          scope: 'ingestion:stats',
          code: 'STATS_MISMATCH',
          message: 'Расход в кабинете и в базе разошёлся на 12%',
          minutes: -1,
        },
      ]);

      const summary = await scan();

      // Обратная сторона поштучных поводов: кричат ровно перечисленные коды —
      // 401, units, отказ отчётности. Всё остальное по-прежнему должно набрать
      // порог, иначе любая запись в журнале становилась бы сообщением в чат.
      expect(summary).toMatchObject({ detected: 0, sent: 0 });
      expect(tg.sent).toHaveLength(0);
    });
  });

  describe('разовые поводы по кодам', () => {
    it('протухший токен поднимает тревогу с первой ошибки — по коду, а не по числу', async () => {
      await seedErrors([
        {
          clientId: alpha.clientId,
          provider: 'YANDEX_DIRECT',
          code: 'AUTH_FAILED',
          message: 'Токен протух, нужна переавторизация кабинета',
          minutes: -1,
        },
        { clientId: beta.clientId, provider: 'VK_ADS', code: '401', minutes: -1 },
        { clientId: null, provider: 'TIKTOK_ADS', code: 'UNAUTHORIZED', minutes: -1 },
        // Похожие, но в набор авторизационных не входят.
        { clientId: alpha.clientId, provider: 'GOOGLE_ADS', code: '403', minutes: -1 },
        { clientId: alpha.clientId, provider: 'META_ADS', code: 'AUTH_EXPIRED', minutes: -1 },
      ]);

      const summary = await scan();

      expect(kindsOf(summary)).toEqual(['auth_error', 'auth_error', 'auth_error']);
      expect(summary.alerts.every((alert) => alert.severity === 'critical')).toBe(true);
      expect(summary).toMatchObject({ sent: 3, suppressed: 0, truncated: 0 });

      const texts = tg.plainTexts();
      expect(texts.every((text) => text.includes('🚨 *Токен не принят площадкой*'))).toBe(true);
      expect(
        texts.every((text) => text.includes('Ретрай бесполезен — нужна переавторизация.')),
      ).toBe(true);
      expect(texts.some((text) => text.includes('Токен протух'))).toBe(true);
      expect(texts.some((text) => text.includes('TIKTOK_ADS / без клиента'))).toBe(true);
      // Коды вне набора молчат: их площадки возвращают и в штатных ситуациях.
      expect(texts.every((text) => !text.includes('GOOGLE_ADS'))).toBe(true);
      expect(texts.every((text) => !text.includes('META_ADS'))).toBe(true);
    });

    it('за окно выборка заходит ровно на оверлап, и всё старше него невидимо', async () => {
      const visible = ERROR_WINDOW_MINUTES + ERROR_LOOKBACK_OVERLAP_MINUTES - 1;
      const invisible = ERROR_WINDOW_MINUTES + ERROR_LOOKBACK_OVERLAP_MINUTES + 1;

      await seedErrors([
        { clientId: beta.clientId, provider: 'YANDEX_DIRECT', code: '401', minutes: -invisible },
      ]);
      expect(await scan()).toMatchObject({ detected: 0, sent: 0 });

      await clearErrors();
      limiter = new CooldownLimiter();
      await seedErrors([
        { clientId: beta.clientId, provider: 'YANDEX_DIRECT', code: '401', minutes: -visible },
      ]);
      expect(await scan()).toMatchObject({ detected: 1, sent: 1 });
    });

    /**
     * Было сломано: заход за окно был отдельной константой в 2 минуты при кроне
     * «раз в 5 минут». Тик в T смотрел `[T−7, T]`, следующий после пропущенного
     * — `[T+3, T+10]`, и интервал `(T, T+3)` не просматривал никто. Разовый
     * повод — 401 или исчерпание units — из этой дырки не видел ни один прогон:
     * назад не смотрит никто, а второй раз такая ошибка может не повториться.
     * Теперь глубина выборки выводится из самого расписания крона и обязана
     * перекрывать два его периода.
     */
    it('401 из пропущенного тика доезжает до человека следующим прогоном', async () => {
      expect(ERROR_LOOKBACK_MINUTES).toBeGreaterThanOrEqual(2 * ALERT_SCAN_INTERVAL_MINUTES);
      expect(ERROR_LOOKBACK_OVERLAP_MINUTES).toBeGreaterThanOrEqual(ALERT_SCAN_INTERVAL_MINUTES);

      // Ошибка легла сразу после тика в T, а тик в T+период не состоялся:
      // рестарт воркера, залипшая очередь. Смотрит на неё только прогон в T+2·период.
      await seedErrors([
        {
          clientId: beta.clientId,
          provider: 'YANDEX_DIRECT',
          code: '401',
          message: 'Токен кабинета отозван',
          minutes: 0.5,
        },
      ]);

      const missedTick = await scan({ now: () => at(2 * ALERT_SCAN_INTERVAL_MINUTES) });

      expect(missedTick).toMatchObject({ detected: 1, sent: 1 });
      expect(plain(tg.last().text)).toContain('🚨 *Токен не принят площадкой*');
    });

    /**
     * Было сломано: недоставленный отчёт писал в `ErrorLog` строку с кодом
     * `REPORT_FAILED`, и на неё не поднималось ничего — кода нет ни в наборе
     * авторизационных, ни в наборе units, а до порога всплеска одной записи не
     * хватает. Человек узнавал о неушедшем отчёте, только если сам лез в
     * журнал. Теперь такой код кричит поштучно.
     */
    it('недоставленный отчёт поднимает тревогу с первой записи', async () => {
      await seedErrors([
        {
          clientId: alpha.clientId,
          provider: null,
          scope: 'reporter:daily',
          code: 'REPORT_FAILED',
          message: 'Failed to deliver report rep-1 for client alpha',
          minutes: -1,
        },
      ]);

      const summary = await scan();

      expect(kindsOf(summary)).toEqual(['report_failed']);
      expect(summary).toMatchObject({ detected: 1, sent: 1, suppressed: 0 });
      expect(summary.alerts[0]).toMatchObject({
        severity: 'critical',
        clientId: alpha.clientId,
      });

      const text = plain(tg.last().text);
      expect(text).toContain('🚨 *Отчёт не ушёл клиенту (daily)*');
      expect(text).toContain('Клиент за этот период отчёта не получил.');

      // И при этом не спамит: пока запись лежит в выборке, тревога одна.
      const nextTick = await scan({ now: () => at(1) });
      expect(nextTick).toMatchObject({ detected: 1, sent: 0, suppressed: 1 });
      expect(tg.sent).toHaveLength(1);
    });

    it('отказ дневного отчёта и отказ недельного — разные поводы', async () => {
      await seedErrors([
        {
          clientId: alpha.clientId,
          scope: 'reporter:daily',
          code: 'REPORT_FAILED',
          message: 'Failed to deliver report rep-1 for client alpha',
          minutes: -2,
        },
        {
          clientId: alpha.clientId,
          scope: 'reporter:weekly',
          code: 'REPORT_FAILED',
          message: 'Failed to deliver report rep-2 for client alpha',
          minutes: -1,
        },
      ]);

      const summary = await scan();

      // Один кабинет, но две разные поломки: недельный разбор не должен молчать
      // полчаса из-за того, что утром не ушёл дневной отчёт.
      expect(kindsOf(summary)).toEqual(['report_failed', 'report_failed']);
      expect(summary.sent).toBe(2);
      expect(tg.plainTexts().some((text) => text.includes('(weekly)'))).toBe(true);
    });

    it('прогон, упавший по всем клиентам, не заливает чат', async () => {
      const clients = [alpha.clientId, beta.clientId, spike.clientId, collapse.clientId];
      await seedErrors(
        clients.flatMap((clientId) => [
          {
            clientId,
            scope: 'reporter:daily',
            code: 'REPORT_FAILED',
            message: `Failed to deliver report for client ${clientId}`,
            minutes: -2,
          },
          // Вторая попытка того же отчёта — та же поломка, не новая.
          {
            clientId,
            scope: 'reporter:daily',
            code: 'REPORT_FAILED',
            message: `Failed to deliver report for client ${clientId}`,
            minutes: -1,
          },
        ]),
      );

      const summary = await scan();

      // Четыре клиента, восемь записей — четыре сообщения, а не восемь. Дальше
      // работает лимит прогона: чат, в который валится поток, перестают читать.
      expect(summary).toMatchObject({ detected: 4, sent: 4, truncated: 0 });
      expect(tg.sent).toHaveLength(4);
      expect(
        tg.plainTexts().every((text) => text.includes('🚨 *Отчёт не ушёл клиенту (daily)*')),
      ).toBe(true);
      expect(tg.plainTexts().some((text) => text.includes('Отказов за выборку: 2'))).toBe(true);
    });

    it('кончившиеся units — предупреждение, а не критическая тревога', async () => {
      await seedErrors([
        { clientId: alpha.clientId, provider: 'YANDEX_DIRECT', code: '52', minutes: -1 },
        { clientId: beta.clientId, provider: 'VK_ADS', code: 'OUT_OF_UNITS', minutes: -1 },
        { clientId: alpha.clientId, provider: 'META_ADS', code: '53', minutes: -1 },
      ]);

      const summary = await scan();

      expect(kindsOf(summary)).toEqual(['out_of_units', 'out_of_units']);
      expect(summary.alerts.every((alert) => alert.severity === 'warning')).toBe(true);
      expect(summary.sent).toBe(2);

      const texts = tg.plainTexts();
      expect(texts.every((text) => text.includes('⚠️ *Кончились units API*'))).toBe(true);
      expect(texts.every((text) => text.includes('Задачи по этому кабинету отложены.'))).toBe(true);
      expect(texts.every((text) => !text.includes('META_ADS'))).toBe(true);
    });
  });

  describe('подавление повторов', () => {
    it('та же поломка не шлёт письмо каждые пять минут, а после остывания приходит снова', async () => {
      await seedErrors([
        {
          clientId: alpha.clientId,
          provider: 'YANDEX_DIRECT',
          code: 'HTTP_500',
          minutes: -1,
          count: 11,
        },
      ]);

      expect(await scan()).toMatchObject({ detected: 1, sent: 1, suppressed: 0 });

      // Следующий тик крона: кабинет всё ещё сломан, ошибки те же.
      expect(await scan({ now: () => at(3) })).toMatchObject({
        detected: 1,
        sent: 0,
        suppressed: 1,
      });
      expect(tg.sent).toHaveLength(1);

      // Кабинет продолжает сыпаться: новая пачка ошибок в новом окне.
      await seedErrors([
        {
          clientId: alpha.clientId,
          provider: 'YANDEX_DIRECT',
          code: 'HTTP_500',
          minutes: 27,
          count: 11,
        },
      ]);

      // Тишина ещё не истекла — по-прежнему молчим.
      expect(await scan({ now: () => at(29) })).toMatchObject({ detected: 1, sent: 0 });
      expect(tg.sent).toHaveLength(1);

      // А вот теперь истекла. Без этого повторная поломка осталась бы известной
      // только логу: подавление, из которого нет выхода, — это не подавление,
      // а выключенная тревога.
      expect(await scan({ now: () => at(31) })).toMatchObject({ detected: 1, sent: 1 });
      expect(tg.sent).toHaveLength(2);
      expect(plain(tg.last().text)).toContain('🚨 *11 ошибок за 5 мин*');
    });

    it('упавшая отправка не засчитывается за доставку', async () => {
      await seedErrors([
        {
          clientId: alpha.clientId,
          provider: 'YANDEX_DIRECT',
          code: 'AUTH_FAILED',
          minutes: -1,
        },
      ]);
      tg.failNext(1);

      // Отправить некому — но и тишину жечь не за что: алерт, ни разу никому не
      // показавшийся, замолкал бы на полчаса.
      expect(await scan()).toMatchObject({ detected: 1, sent: 0, suppressed: 0 });
      expect(tg.sent).toHaveLength(0);

      expect(await scan({ now: () => at(1) })).toMatchObject({ detected: 1, sent: 1 });
      expect(tg.sent).toHaveLength(1);
    });
  });

  describe('некуда слать', () => {
    it('без адреса чата тревоги не уходят, но и не сгорают', async () => {
      await seedErrors([
        { clientId: alpha.clientId, provider: 'YANDEX_DIRECT', code: '401', minutes: -1 },
      ]);

      const summary = await scan({ chatId: '' });

      expect(summary).toMatchObject({ detected: 1, sent: 0, suppressed: 1 });
      expect(tg.sent).toHaveLength(0);
      // Найденное лежит в сводке целиком: по логам должно быть видно, что тревога
      // была. Но в самой сводке «некуда слать» неотличимо от «ограничитель
      // молчит» — оба приезжают полем `suppressed`, и при LOG_LEVEL выше warn
      // ненастроенный чат выглядит как спокойная система.
      expect(summary.alerts[0]).toMatchObject({ kind: 'auth_error' });

      // Тишину не сожгли: как только чат появится, тревога уйдёт следующим тиком.
      expect(await scan({ now: () => at(1) })).toMatchObject({ detected: 1, sent: 1 });
      expect(tg.sent).toHaveLength(1);
    });

    it.skipIf(Boolean(env.TELEGRAM_ADMIN_CHAT_ID))(
      'по умолчанию адрес берётся из окружения, и незаданный означает молчание',
      async () => {
        await seedErrors([
          { clientId: alpha.clientId, provider: 'YANDEX_DIRECT', code: '401', minutes: -1 },
        ]);

        const summary = await runAlertScan({
          messenger: () => tg,
          now: () => SCAN_AT,
          limiter,
          checkSpend: false,
        });

        expect(env.TELEGRAM_ADMIN_CHAT_ID).toBeUndefined();
        expect(summary).toMatchObject({ detected: 1, sent: 0, suppressed: 1 });
        expect(tg.sent).toHaveLength(0);
      },
    );
  });

  describe('лимит одного прогона', () => {
    it('больше пяти тревог за раз не уходит, остальные приходят следующим тиком', async () => {
      expect(MAX_ALERTS_PER_RUN).toBe(5);

      const providers = [
        'YANDEX_DIRECT',
        'VK_ADS',
        'TIKTOK_ADS',
        'LINKEDIN_ADS',
        'META_ADS',
        'GOOGLE_ADS',
      ] as const;
      await seedErrors(
        providers.map((provider, index) => ({
          clientId: alpha.clientId,
          provider,
          code: 'AUTH_FAILED',
          message: `Токен ${provider} не принят`,
          minutes: -4 + index * 0.5,
        })),
      );

      const first = await scan();
      expect(first).toMatchObject({ detected: 6, sent: 5, suppressed: 0, truncated: 1 });
      // Пять тревог плюс строка про остаток: молчаливое усечение означало бы,
      // что человек считает увиденное полным списком.
      expect(tg.sent).toHaveLength(6);
      expect(plain(tg.last().text)).toContain(
        '…и ещё 1 предупреждений — придут следующим прогоном.',
      );
      expect(
        tg
          .plainTexts()
          .slice(0, 5)
          .every((text) => !text.includes('GOOGLE_ADS')),
      ).toBe(true);

      // Не влезшее тишину не жжёт и доезжает следующим прогоном.
      const second = await scan({ now: () => at(1) });
      expect(second).toMatchObject({ detected: 6, sent: 1, suppressed: 5, truncated: 0 });
      expect(plain(tg.last().text)).toContain('GOOGLE_ADS');
    });
  });

  describe('аномальный расход', () => {
    it('всплеск и обвал находятся, ровный ряд молчит', async () => {
      const summary = await scan({ checkSpend: true });

      const anomalies = summary.alerts.filter((alert) => alert.kind === 'spend_anomaly');
      expect(anomalies).toHaveLength(2);
      expect(new Set(anomalies.map((alert) => alert.clientId))).toEqual(
        new Set([spike.clientId, collapse.clientId]),
      );
      expect(summary.sent).toBe(2);

      const texts = tg.plainTexts();
      const grew = texts.find((text) => text.includes('Кофейня «Зерно»'));
      expect(grew).toContain('🚨 *Аномальный расход*');
      expect(grew).toContain('2026-08-20: 9 000 ₽ при среднем 2 000 ₽');
      expect(grew).toContain('Отклонение: +350%');

      const fell = texts.find((text) => text.includes('Барбершоп «Бритва»'));
      expect(fell).toContain('⚠️ *Расход почти остановился*');
      expect(fell).toContain('2026-08-20: 200 ₽ при среднем 2 000 ₽');
      expect(fell).toContain('Отклонение: −90%');

      // Ровный ряд — не повод: тревога на нём приучила бы игнорировать все.
      expect(texts.every((text) => !text.includes(steady.name))).toBe(true);
    });

    it('проверяется раз в час, шлётся раз в сутки, назавтра приходит снова', async () => {
      // Без явного `checkSpend`: решать должен ограничитель прогона, и именно
      // это решение здесь проверяется.
      const first = await runAlertScan({
        chatId: ADMIN_CHAT,
        messenger: () => tg,
        now: () => SCAN_AT,
        limiter,
      });
      expect(first).toMatchObject({ detected: 2, sent: 2 });

      // Следующий пятиминутный тик: расход не проверялся вовсе. Разница с
      // подавлением принципиальная — «не смотрели», а не «посмотрели и промолчали».
      const soon = await runAlertScan({
        chatId: ADMIN_CHAT,
        messenger: () => tg,
        now: () => at(5),
        limiter,
      });
      expect(soon).toMatchObject({ detected: 0, sent: 0, suppressed: 0 });

      // Через час проверка идёт снова — и упирается уже в суточную тишину.
      const hourLater = await runAlertScan({
        chatId: ADMIN_CHAT,
        messenger: () => tg,
        now: () => at(61),
        limiter,
      });
      expect(hourLater).toMatchObject({ detected: 2, sent: 0, suppressed: 2 });
      expect(tg.sent).toHaveLength(2);
      expect(SPEND_ALERT_COOLDOWN_MS).toBe(20 * 60 * 60 * 1000);

      // Следующие сутки. В ключе подавления стоит дата аномального дня, поэтому
      // вчерашняя тишина не глушит сегодняшнюю поломку.
      const nextDay = await runAlertScan({
        chatId: ADMIN_CHAT,
        messenger: () => tg,
        now: () => at(21 * 60),
        limiter,
      });
      expect(nextDay).toMatchObject({ detected: 1, sent: 1 });
      expect(nextDay.alerts[0]).toMatchObject({
        kind: 'spend_anomaly',
        clientId: spike.clientId,
      });
      expect(plain(tg.last().text)).toContain('2026-08-21: 9 500 ₽ при среднем 3 000 ₽');

      // А кабинет, у которого загрузка встала совсем, назавтра тревоги не даёт:
      // последний день ряда без строк не разбирается вовсе. Это защита от
      // «расход упал на 100%» на недоехавшей загрузке, но и цена у неё есть —
      // полностью замолчавший кабинет тревоги не поднимает.
      expect(plain(tg.last().text)).not.toContain(collapse.name);
    });
  });
});
