import { writeFileSync } from 'node:fs';

import { http, HttpResponse } from 'msw';

import { createTelegramApiMock, type SentMessage } from './campaign-entry-telegram.js';
import { createYandexApiMock, type CampaignState, type YandexCall } from './yandex-api-mock.js';

/**
 * Площадки для CLI, запущенного настоящим процессом.
 *
 * Зачем отдельный файл, если моки уже есть: msw живёт в том процессе, где его
 * подняли, а `pnpm cli optimize --apply` — это другой процесс. Пока перехвата в
 * нём не было, сценарии CLI могли проверять только пути, которые никуда не ходят,
 * — и путь записи из команды оставался непройденным (`tests/e2e/cli-optimize.e2e.ts`
 * честно оговаривал это: единственный прогон с `--apply` шёл по клиенту без
 * подходящих кампаний).
 *
 * Модуль подгружается в команду через `node --import`, поднимает те же моки, что
 * и внутрипроцессные сценарии, и на выходе кладёт состояние кабинета и список
 * запросов в файл `E2E_CLI_MOCK_DUMP`. Иначе тест не увидит ничего: у соседнего
 * процесса нельзя спросить, что он отправил в сеть.
 *
 * Работает только под e2e: без `E2E_CLI_MOCK_DUMP` модуль не делает ничего.
 */

/** Совпадает с `YANDEX_DIRECT_BASE_URL` при `YANDEX_DIRECT_USE_SANDBOX=true`. */
const YANDEX_BASE = 'https://api-sandbox.direct.yandex.com/json/v5';

/** Кабинет фикстуры `seedAccount()`: те же внешние id, что у её кампаний. */
const CABINET: readonly CampaignState[] = [
  { id: 111, name: 'Поиск — Слоны', dailyBudget: 8000, negativeKeywords: [] },
  { id: 112, name: 'РСЯ — импорт из кабинета', dailyBudget: 3000, negativeKeywords: [] },
];

export interface CliMockCard {
  chatId: string;
  text: string;
  /** Карточка апрува — сообщение с кнопками; остальное бот шлёт без клавиатуры. */
  card: boolean;
}

export interface CliMockDump {
  yandex: {
    calls: YandexCall[];
    bids: Array<{ keywordId: number; searchBid: number }>;
    suspended: { keywords: number[]; ads: number[] };
    /** Минус-фразы кабинета по внешнему id кампании — состояние на конец прогона. */
    negatives: Record<string, string[]>;
    /** Запросы, которым мок ответил отказом по требованию сценария. */
    refused: string[];
  };
  telegram: { sent: CliMockCard[] };
}

/**
 * Отказ площадки на выбранном сервисе (`E2E_CLI_MOCK_FAIL=keywordbids`).
 *
 * Директ отвечает на такие отказы кодом 200 с ошибкой в теле — форма ответа
 * повторяет настоящую, иначе сценарий проверял бы разбор, которого в проде нет.
 */
function refuseService(service: string, refused: string[]) {
  return http.post(`${YANDEX_BASE}/${service}`, async ({ request }) => {
    const body = (await request.json()) as { method?: string };
    refused.push(`${service}.${String(body.method)}`);
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

function start(dumpPath: string): void {
  const yandex = createYandexApiMock(CABINET);
  const telegram = createTelegramApiMock(process.env['TELEGRAM_BOT_TOKEN'] ?? '');
  const refused: string[] = [];

  yandex.server.use(...telegram.handlers);
  const fail = process.env['E2E_CLI_MOCK_FAIL'];
  // Последний `use` старше предыдущих — отказ перекрывает обычный обработчик.
  if (fail) yandex.server.use(refuseService(fail, refused));

  // Клиент заблокировал бота: карточка создаётся, а доставить её некуда.
  const blocked = process.env['E2E_CLI_MOCK_BLOCK_CHAT'];
  if (blocked) telegram.block(blocked);

  // 'error' обязателен: незамоканный запрос ушёл бы в настоящий кабинет.
  yandex.server.listen({ onUnhandledRequest: 'error' });

  const asCard = (m: SentMessage): CliMockCard => ({
    chatId: m.chatId,
    text: m.text,
    card: m.keyboard !== undefined,
  });

  // Пишем на выходе, а не по ходу: команда живёт секунды, и единственный момент,
  // когда состояние кабинета окончательно, — её завершение.
  process.on('exit', () => {
    const dump: CliMockDump = {
      yandex: {
        calls: yandex.calls,
        bids: yandex.bids,
        suspended: yandex.suspended,
        negatives: Object.fromEntries(CABINET.map((c) => [String(c.id), yandex.negativesOf(c.id)])),
        refused,
      },
      telegram: { sent: telegram.sent.map(asCard) },
    };
    writeFileSync(dumpPath, JSON.stringify(dump));
  });
}

const dumpPath = process.env['E2E_CLI_MOCK_DUMP'];
if (dumpPath) start(dumpPath);
