import { logger } from '@/lib/logger.js';
import { describeError } from '@/lib/errors.js';

type Hook = () => Promise<void> | void;

const hooks: Hook[] = [];
let installed = false;
let shuttingDown = false;

/** Регистрирует обработчик, который должен отработать до выхода процесса. */
export function onShutdown(hook: Hook): void {
  hooks.push(hook);
  install();
}

async function run(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');

  // Хуки закрываются в обратном порядке регистрации: сначала потребители, потом соединения.
  for (const hook of [...hooks].reverse()) {
    try {
      await hook();
    } catch (err) {
      logger.error({ err: describeError(err) }, 'shutdown hook failed');
    }
  }
  logger.info('shutdown complete');
  process.exit(0);
}

function install(): void {
  if (installed) return;
  installed = true;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => void run(sig));
  }
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: describeError(reason) }, 'unhandled rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err: describeError(err) }, 'uncaught exception');
    void run('uncaughtException');
  });
}
