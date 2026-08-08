import 'dotenv/config';
import { z } from 'zod';

/** Пустая строка в .env — это «не задано», а не значение. */
const optionalStr = z
  .string()
  .trim()
  .transform((v) => (v === '' ? undefined : v))
  .optional();

const boolish = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // 'silent' поддерживается pino и нужен тестам, чтобы прогон не тонул в логах.
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  API_PORT: z.coerce.number().int().positive().default(3000),
  TZ: z.string().default('Europe/Moscow'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  // 32 байта в hex. Проверяем длину здесь, чтобы упасть на старте, а не при первом шифровании.
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 64 hex chars (32 bytes)'),

  DRY_RUN: boolish(true),
  MAX_BID_CHANGE_PCT: z.coerce.number().positive().max(1).default(0.3),
  DAILY_BUDGET_HARD_LIMIT_MULT: z.coerce.number().min(1).default(1.2),
  APPROVAL_TTL_MINUTES: z.coerce.number().int().positive().default(120),

  TELEGRAM_BOT_TOKEN: optionalStr,
  TELEGRAM_ADMIN_CHAT_ID: optionalStr,

  YANDEX_OAUTH_CLIENT_ID: optionalStr,
  YANDEX_OAUTH_CLIENT_SECRET: optionalStr,
  YANDEX_DIRECT_SANDBOX: boolish(true),
  YANDEX_UNITS_RESERVE: z.coerce.number().int().nonnegative().default(500),

  VK_ADS_CLIENT_ID: optionalStr,
  VK_ADS_CLIENT_SECRET: optionalStr,

  METRIKA_OAUTH_TOKEN: optionalStr,

  ANTHROPIC_API_KEY: optionalStr,
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-6'),
  OPENAI_API_KEY: optionalStr,
  DEEPSEEK_API_KEY: optionalStr,

  FUSIONBRAIN_API_KEY: optionalStr,
  FUSIONBRAIN_SECRET_KEY: optionalStr,
  YANDEX_ART_FOLDER_ID: optionalStr,
  YANDEX_ART_IAM_TOKEN: optionalStr,

  TIKTOK_APP_ID: optionalStr,
  TIKTOK_APP_SECRET: optionalStr,
  LINKEDIN_CLIENT_ID: optionalStr,
  LINKEDIN_CLIENT_SECRET: optionalStr,
  META_APP_ID: optionalStr,
  META_APP_SECRET: optionalStr,
  GOOGLE_ADS_DEVELOPER_TOKEN: optionalStr,
  GOOGLE_ADS_CLIENT_ID: optionalStr,
  GOOGLE_ADS_CLIENT_SECRET: optionalStr,
});

export type Env = z.infer<typeof envSchema>;

function load(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const env: Env = load();

/** Московское время — единая точка отсчёта для всех крон-задач и отчётов. */
export const MSK = 'Europe/Moscow';

export const YANDEX_DIRECT_BASE_URL = env.YANDEX_DIRECT_SANDBOX
  ? 'https://api-sandbox.direct.yandex.com/json/v5/'
  : 'https://api.direct.yandex.com/json/v5/';

export const VK_ADS_BASE_URL = 'https://ads.vk.ru/api/v2/';
export const METRIKA_BASE_URL = 'https://api-metrika.yandex.net/stat/v1/data';
