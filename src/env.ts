// Единственное место, читающее process.env, — значит и .env грузим здесь:
// иначе каждая точка входа обязана помнить про dotenv, и любая новая падает.
// dotenv не перезаписывает уже заданные переменные, поэтому в проде и в CI
// настоящее окружение остаётся главнее файла.
import 'dotenv/config';
import { z } from 'zod';

// Пустая строка в .env — это «не задано», а не значение: иначе провайдер
// с пустым ключом считался бы настроенным и падал бы только в проде.
const optionalStr = z
  .string()
  .trim()
  .transform((v) => (v === '' ? undefined : v))
  .optional();

const TRUTHY = new Set(['true', '1', 'yes', 'on']);
const FALSY = new Set(['false', '0', 'no', 'off']);

/**
 * Булев флаг из окружения. Непонятное значение — ошибка запуска, а не «false».
 *
 * Так делается ради DRY_RUN: молчаливое приведение к false означало бы, что
 * опечатка `DRY_RUN=True` снимает предохранитель и система начинает писать
 * в кабинеты клиентов. Предохранитель, который выключается опиской, не защищает.
 */
const boolish = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return def;
      const normalized = v.trim().toLowerCase();
      if (TRUTHY.has(normalized)) return true;
      if (FALSY.has(normalized)) return false;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `ожидалось true/false (допустимо ${[...TRUTHY, ...FALSY].join(', ')}), получено «${v}»`,
      });
      return z.NEVER;
    });

/**
 * Мастер-ключ шифрования кред: строго 32 байта в base64.
 *
 * Проверяем здесь, а не при первом обращении к кредам: ленивая проверка означает, что
 * процесс поднимается зелёным, проходит health-check и падает через час внутри
 * воркера. Плохой ключ обязан ронять старт.
 *
 * Round-trip нужен потому, что декодер Node молча выбрасывает недопустимые
 * символы: человеческая парольная фраза из 44 знаков превращается в 32 байта и
 * проходит проверку длины, хотя энтропии в ней далеко не 256 бит.
 */
function assertEncryptionKey(value: string, ctx: z.RefinementCtx): void {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'должен быть корректным base64 (сгенерировать: openssl rand -base64 32)',
    });
    return;
  }
  if (decoded.byteLength !== 32) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `ожидается 32 байта, получено ${decoded.byteLength}`,
    });
  }
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  APP_VERSION: z.string().default('0.0.1'),
  TZ: z.string().default('Europe/Moscow'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // Значения по умолчанию здесь нет и быть не может. Раньше стояло
  // `.default('AAAA…=')` — 32 нулевых байта, — и без переменной система молча
  // шифровала токены всех кабинетов ключом, лежащим в открытых исходниках:
  // дамп базы плюс публичный репозиторий давали доступ ко всем кабинетам всех
  // клиентов. Отсутствие ключа обязано ронять запуск, а не подставлять «какой-то».
  CREDENTIALS_ENCRYPTION_KEY: z.string().superRefine(assertEncryptionKey),

  // ── Предохранители. DRY_RUN по умолчанию true: выключать защиту нужно
  // осознанно, а не забыть включить.
  DRY_RUN: boolish(true),
  MAX_BID_CHANGE_PCT: z.coerce.number().positive().max(1).default(0.3),
  DAILY_BUDGET_HARD_LIMIT_MULT: z.coerce.number().min(1).default(1.2),
  APPROVAL_TIMEOUT_HOURS: z.coerce.number().positive().default(2),
  BUDGET_CHANGE_THRESHOLD_PCT: z.coerce.number().positive().max(100).default(20),

  TELEGRAM_BOT_TOKEN: optionalStr,
  TELEGRAM_ADMIN_IDS: z.string().default(''),
  TELEGRAM_ADMIN_CHAT_ID: optionalStr,

  YANDEX_OAUTH_CLIENT_ID: optionalStr,
  YANDEX_OAUTH_CLIENT_SECRET: optionalStr,
  YANDEX_DIRECT_USE_SANDBOX: boolish(true),
  YANDEX_UNITS_RESERVE: z.coerce.number().int().nonnegative().default(500),
  YANDEX_METRIKA_TOKEN: optionalStr,

  VK_ADS_CLIENT_ID: optionalStr,
  VK_ADS_CLIENT_SECRET: optionalStr,

  // Генерация изображений (TZ §13.3). FusionBrain/Kandinsky авторизуется парой
  // «ключ + секрет» (заголовки X-Key и X-Secret), одного ключа ему мало.
  KANDINSKY_API_KEY: optionalStr,
  KANDINSKY_SECRET_KEY: optionalStr,

  ANTHROPIC_API_KEY: optionalStr,
  OPENAI_API_KEY: optionalStr,
  DEEPSEEK_API_KEY: optionalStr,
  OPENROUTER_API_KEY: optionalStr,
  LLM_MONTHLY_BUDGET_USD: z.coerce.number().positive().default(50),
});

/** Экспортируется ради тестов: сам `env` читается один раз при импорте модуля. */
export { envSchema };

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  return parsed.data;
}

export const env: Env = loadEnv();

/** Производное от APPROVAL_TIMEOUT_HOURS — код апрувов считает в минутах. */
export const APPROVAL_TTL_MINUTES = Math.round(env.APPROVAL_TIMEOUT_HOURS * 60);
