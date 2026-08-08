import type { FastifyInstance } from 'fastify';

import { logger } from './logger.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

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
