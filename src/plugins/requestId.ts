import type { FastifyInstance } from 'fastify';

export async function requestIdPlugin(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (request, reply) => {
    void reply.header('x-request-id', request.id);
  });
}
