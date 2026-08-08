import Fastify from 'fastify';
import { env } from '@/config/index.js';
import { logger } from '@/lib/logger.js';
import { prisma, disconnectPrisma } from '@/db/prisma.js';
import { redis, disconnectRedis } from '@/db/redis.js';
import { onShutdown } from '@/lib/shutdown.js';
import { describeError } from '@/lib/errors.js';

export function buildServer() {
  const app = Fastify({ loggerInstance: logger });

  app.get('/healthz', async () => ({ ok: true, env: env.NODE_ENV, dryRun: env.DRY_RUN }));

  // readyz отличается от healthz: проверяет зависимости, а не только живость процесса.
  app.get('/readyz', async (_req, reply) => {
    const checks: Record<string, string> = {};
    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.postgres = 'ok';
    } catch (err) {
      checks.postgres = describeError(err);
    }
    try {
      await redis.ping();
      checks.redis = 'ok';
    } catch (err) {
      checks.redis = describeError(err);
    }
    const ok = Object.values(checks).every((v) => v === 'ok');
    return reply.code(ok ? 200 : 503).send({ ok, checks });
  });

  return app;
}

async function main(): Promise<void> {
  const app = buildServer();
  onShutdown(async () => {
    await app.close();
    await disconnectPrisma();
    await disconnectRedis();
  });
  await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
}

if (process.argv[1]?.endsWith('api.ts') || process.argv[1]?.endsWith('api.js')) {
  main().catch((err) => {
    logger.fatal({ err: describeError(err) }, 'api failed to start');
    process.exit(1);
  });
}
