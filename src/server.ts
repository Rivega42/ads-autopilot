import Fastify from 'fastify';

import { config } from './config.js';
import { errorHandler } from './errorHandler.js';
import { logger } from './logger.js';
import { registerShutdown } from './shutdown.js';

export async function buildApp(): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify({
    loggerInstance: logger,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && incoming.length > 0 ? incoming : crypto.randomUUID();
    },
    trustProxy: true,
  });

  app.addHook('onRequest', async (request, reply) => {
    void reply.header('x-request-id', request.id);
  });
  app.setErrorHandler(errorHandler);

  app.get('/health', async () => ({
    status: 'ok',
    ts: new Date().toISOString(),
    version: config.app.version,
  }));

  return app;
}

async function main(): Promise<void> {
  const app = await buildApp();
  registerShutdown(app);

  try {
    await app.listen({ port: config.server.port, host: config.server.host });
    logger.info({ port: config.server.port }, 'server listening');
  } catch (err) {
    logger.error({ err }, 'server failed to start');
    process.exit(1);
  }
}

const isEntry =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('server.ts') === true ||
  process.argv[1]?.endsWith('server.js') === true;

if (isEntry) {
  void main();
}
