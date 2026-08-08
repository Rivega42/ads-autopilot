import type { FastifyInstance } from 'fastify';

import { logger } from './logger.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

type ShutdownHook = () => Promise<void> | void;

const hooks: ShutdownHook[] = [];
let signalsBound = false;
let hooksRunning = false;

/**
 * Для процессов без Fastify — воркера очередей и Telegram-бота.
 * Хуки закрываются в обратном порядке регистрации: сначала потребители,
 * потом соединения, на которых они держатся.
 */
export function onShutdown(hook: ShutdownHook): void {
  hooks.push(hook);
  if (signalsBound) return;
  signalsBound = true;

  for (const signal of ['SIGTERM', 'SIGINT'] as NodeJS.Signals[]) {
    process.on(signal, () => {
      if (hooksRunning) return;
      hooksRunning = true;
      logger.info({ signal }, 'shutdown: received signal');

      const forceExit = setTimeout(() => {
        logger.error('shutdown: timed out, forcing exit');
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS);
      forceExit.unref();

      void (async () => {
        for (const h of [...hooks].reverse()) {
          try {
            await h();
          } catch (err) {
            logger.error({ err }, 'shutdown: hook failed');
          }
        }
        logger.info('shutdown: complete');
        process.exit(0);
      })();
    });
  }
}

export function registerShutdown(app: FastifyInstance): void {
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
  let shuttingDown = false;

  for (const signal of signals) {
    process.on(signal, async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info({ signal }, 'shutdown: received signal');

      const forceExit = setTimeout(() => {
        logger.error('shutdown: timed out, forcing exit');
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS);
      forceExit.unref();

      try {
        await app.close();
        logger.info('shutdown: fastify closed');
        process.exit(0);
      } catch (err) {
        logger.error({ err }, 'shutdown: error while closing');
        process.exit(1);
      }
    });
  }
}
