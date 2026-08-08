import { env } from './env.js';

export const config = {
  server: {
    port: env.PORT,
    host: '0.0.0.0',
  },
  app: {
    version: env.APP_VERSION,
    env: env.NODE_ENV,
  },
} as const;

export type Config = typeof config;
