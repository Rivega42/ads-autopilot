import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import type { FastifyInstance } from 'fastify';

import { env } from '../env.js';

export async function securityPlugin(app: FastifyInstance): Promise<void> {
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameSrc: ["'none'"],
      },
    },
  });

  const allowedOrigin = env.NODE_ENV === 'production' ? /grandhub\.ru$/ : true;
  await app.register(fastifyCors, { origin: allowedOrigin, credentials: true });
}
