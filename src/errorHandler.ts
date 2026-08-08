import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

export function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const requestId = request.id;
  const statusCode = error.statusCode ?? 500;

  request.log.error(
    {
      err: {
        message: error.message,
        code: error.code,
        stack: error.stack,
      },
      requestId,
      statusCode,
    },
    'request failed',
  );

  const body: { error: string; code?: string; requestId: string } = {
    error: statusCode >= 500 ? 'Internal Server Error' : error.message,
    requestId,
  };
  if (error.code) body.code = error.code;

  void reply.status(statusCode).send(body);
}
