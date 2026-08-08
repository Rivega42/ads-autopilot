import pino from 'pino';
import { env } from '@/config/index.js';

const isDev = env.NODE_ENV === 'development';

export const logger = pino({
  level: env.LOG_LEVEL,
  // Токены и секреты не должны попадать в логи ни при каких обстоятельствах.
  redact: {
    paths: [
      'token',
      'accessToken',
      'refreshToken',
      'client_secret',
      'clientSecret',
      'secretsEnc',
      'password',
      'apiKey',
      'headers.authorization',
      'headers.Authorization',
      '*.token',
      '*.accessToken',
      '*.refreshToken',
      '*.client_secret',
      '*.apiKey',
    ],
    censor: '[redacted]',
  },
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
        },
      }
    : {}),
});

/** Дочерний логгер для модуля: logger.child({ scope }) с единым именованием. */
export function scoped(scope: string, bindings: Record<string, unknown> = {}) {
  return logger.child({ scope, ...bindings });
}

export type Logger = typeof logger;
