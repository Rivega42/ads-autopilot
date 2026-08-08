import fastifyRateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';

export async function rateLimitPlugin(app: FastifyInstance): Promise<void> {
  await app.register(fastifyRateLimit, {
    max: 100,
    timeWindow: '1 minute',
    errorResponseBuilder: (_req, context) => ({
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Try again in ${Math.ceil(context.ttl / 1000)}s`,
      retryAfter: Math.ceil(context.ttl / 1000),
    }),
  });
}
