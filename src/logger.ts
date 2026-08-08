import { pino } from 'pino';

import { env } from './env.js';

const isDev = env.NODE_ENV === 'development';

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'password',
      'token',
      'apiKey',
      'authorization',
      'req.headers.authorization',
      'req.headers.cookie',
      '*.token',
      '*.apiKey',
      '*.password',
    ],
    censor: '[Redacted]',
  },
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss.l',
            ignore: 'pid,hostname',
          },
        },
      }
    : {}),
});
