import { setupServer, type SetupServer } from 'msw/node';

import {
  createMetrikaMock,
  type MetrikaMock,
  type MetrikaMockOptions,
} from './ingestion-metrika-mock.js';
import {
  createYandexDirectMock,
  type YandexDirectMock,
  type YandexDirectMockOptions,
} from './ingestion-yandex-mock.js';

/**
 * Оба мока в одном перехватчике.
 *
 * `setupServer` патчит сеть глобально, поэтому двух серверов одновременно быть
 * не может: обработчики Директа и Метрики обязаны жить в одном.
 * `onUnhandledRequest: 'error'` — не строгость ради строгости: без него
 * незамоканный вызов ушёл бы в настоящую Метрику с настоящим токеном.
 */
export interface IngestionMocks {
  server: SetupServer;
  yandex: YandexDirectMock;
  metrika: MetrikaMock;
  close(): void;
}

export function startIngestionMocks(options: {
  yandex: YandexDirectMockOptions;
  metrika: MetrikaMockOptions;
}): IngestionMocks {
  const yandex = createYandexDirectMock(options.yandex);
  const metrika = createMetrikaMock(options.metrika);
  const server = setupServer(...yandex.handlers, ...metrika.handlers);
  server.listen({ onUnhandledRequest: 'error' });

  return { server, yandex, metrika, close: () => server.close() };
}
