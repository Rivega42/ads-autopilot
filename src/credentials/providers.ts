import type { Provider } from '@prisma/client';
import { z } from 'zod';

import { readVkCredentials } from '@/clients/vk-ads/auth.js';
import { yandexCredentialsSchema } from '@/clients/yandex-direct/auth.js';
import { AppError } from '@/lib/errors.js';

/**
 * Каналы, для которых описана схема секретов. Остальные значения `Provider`
 * заведены на будущее: положить в базу секрет, который никакой адаптер не умеет
 * прочитать, — это не «задел», а строка, из-за которой крон загрузки будет
 * ежечасно падать на неизвестном формате.
 */
export type SupportedProvider = Extract<Provider, 'YANDEX_DIRECT' | 'VK_ADS'>;

export const SUPPORTED_PROVIDERS: SupportedProvider[] = ['YANDEX_DIRECT', 'VK_ADS'];

const ALIASES: Record<string, SupportedProvider> = {
  yandex: 'YANDEX_DIRECT',
  yandexdirect: 'YANDEX_DIRECT',
  direct: 'YANDEX_DIRECT',
  vk: 'VK_ADS',
  vkads: 'VK_ADS',
  vkreklama: 'VK_ADS',
};

/** Одно поле секрета в том виде, в каком его можно показать человеку и в логе. */
export interface CredentialField {
  name: string;
  /** Уже безопасное значение: для секретных полей — маска. */
  shown: string;
  secret: boolean;
}

export interface BuiltCredentialPayload {
  provider: SupportedProvider;
  payload: Record<string, unknown>;
  fields: CredentialField[];
}

/** Поля, которые сами по себе дают доступ к кабинету. Всё остальное — идентификаторы. */
const SECRET_FIELD_NAMES = new Set(['accessToken', 'refreshToken', 'clientSecret', 'code']);

/**
 * Маска для логов и вывода: последние 4 символа и ничего больше (CLAUDE.md §6).
 * Строку в 4 символа и короче не показываем вовсе — «последние четыре» от неё
 * были бы ею целиком.
 */
export function maskSecret(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 4 ? `…${trimmed.slice(-4)}` : '••••';
}

export function parseProvider(raw: string): SupportedProvider {
  const key = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  const provider = ALIASES[key];
  if (!provider) {
    throw new AppError(
      `Неизвестный канал «${raw}». Схема секретов описана для: ${SUPPORTED_PROVIDERS.join(', ')}.`,
      { code: 'CREDENTIAL_PROVIDER_UNSUPPORTED', context: { provider: raw } },
    );
  }
  return provider;
}

export function describeFields(payload: Record<string, unknown>): CredentialField[] {
  return Object.entries(payload).map(([name, value]) => {
    const secret = SECRET_FIELD_NAMES.has(name);
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return { name, shown: secret ? maskSecret(text ?? '') : (text ?? ''), secret };
  });
}

/**
 * Объяснение неудачного разбора JSON — без единого символа разобранного текста.
 *
 * Текст ошибки от `JSON.parse` подставлять сюда нельзя: V8 в Node 22 вставляет в
 * него окно вокруг места сбоя, и на самой обычной опечатке (забытые кавычки
 * вокруг токена) наружу уезжает начало секрета — `Unexpected token 'y',
 * ..."ssToken": y0_AgAAAAA"... is not valid JSON`. Дальше CLI кладёт это в лог
 * целиком, а логировать от токена разрешено только последние четыре символа
 * (CLAUDE.md §6).
 *
 * Позицию сбоя V8 сообщает в другой форме сообщений и содержимого в ней нет —
 * её забираем: без неё человеку негде искать опечатку.
 */
export function describeJsonFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : '';
  const at = /at position (\d+)/.exec(message)?.[1];
  return (
    'Ввод похож на JSON, но не разбирается' +
    (at === undefined ? '' : ` (позиция ${at})`) +
    '. Чаще всего это забытая кавычка вокруг значения или лишняя запятая. ' +
    'Сам ввод не показываем: в тексте ошибки разборщика видна часть секрета.'
  );
}

/**
 * Разбирает ввод: либо JSON-объект, либо голая строка.
 * JSON узнаём по первому символу, а не попыткой распарсить: токен Директа —
 * тоже валидный JSON-скаляр в кавычках, и «попробуем разобрать» превратило бы
 * опечатку в тихо принятое значение.
 */
function parseInput(raw: string): Record<string, unknown> | string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new AppError(describeJsonFailure(err), { code: 'CREDENTIAL_PAYLOAD_MALFORMED' });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AppError('Ожидался JSON-объект с полями секрета.', {
      code: 'CREDENTIAL_PAYLOAD_MALFORMED',
    });
  }
  return parsed as Record<string, unknown>;
}

/**
 * zod вырезает неизвестные ключи молча. Для секретов это худший из возможных
 * исходов: `{"access_token": "…"}` превратилось бы в пустой объект, а ошибка
 * всплыла бы через сутки первым запросом к кабинету. Поэтому лишние ключи —
 * отказ с их перечислением.
 */
function assertKnownKeys(raw: Record<string, unknown>, allowed: string[]): void {
  const unknown = Object.keys(raw).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    throw new AppError(
      `Неизвестные поля секрета: ${unknown.join(', ')}. Допустимы: ${allowed.join(', ')}.`,
      { code: 'CREDENTIAL_PAYLOAD_UNKNOWN_FIELDS', context: { unknown } },
    );
  }
}

function fail(provider: SupportedProvider, issues: string[]): never {
  throw new AppError(`Секрет ${provider} не проходит проверку: ${issues.join('; ')}`, {
    code: 'CREDENTIAL_PAYLOAD_INVALID',
    context: { provider },
  });
}

const vkPayloadSchema = z.object({
  clientId: z.string().min(1).optional(),
  clientSecret: z.string().min(1).optional(),
  agencyClientName: z.string().min(1).optional(),
  accessToken: z.string().min(1).optional(),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.string().optional(),
  scopes: z.array(z.string()).optional(),
});

function buildYandex(input: Record<string, unknown> | string): Record<string, unknown> {
  const raw = typeof input === 'string' ? { accessToken: input } : input;
  assertKnownKeys(raw, Object.keys(yandexCredentialsSchema.shape));
  const parsed = yandexCredentialsSchema.safeParse(raw);
  if (!parsed.success) {
    fail(
      'YANDEX_DIRECT',
      parsed.error.issues.map((i) => `${i.path.join('.') || 'payload'}: ${i.message}`),
    );
  }
  return parsed.data;
}

function buildVk(input: Record<string, unknown> | string): Record<string, unknown> {
  if (typeof input === 'string') {
    throw new AppError(
      'Для VK_ADS одного токена мало: нужен JSON с полями clientId, clientSecret ' +
        'и, для агентства, agencyClientName.',
      { code: 'CREDENTIAL_PAYLOAD_MALFORMED', context: { provider: 'VK_ADS' } },
    );
  }
  assertKnownKeys(input, Object.keys(vkPayloadSchema.shape));
  const parsed = vkPayloadSchema.safeParse(input);
  if (!parsed.success) {
    fail(
      'VK_ADS',
      parsed.error.issues.map((i) => `${i.path.join('.') || 'payload'}: ${i.message}`),
    );
  }
  // Годность проверяет сам канал: у VK пара приложения может лежать в окружении,
  // и повторять здесь эту развилку значило бы завести второе мнение о том,
  // какой секрет считается рабочим.
  readVkCredentials(parsed.data);
  return parsed.data;
}

/**
 * Приводит введённое человеком к тому, что ляжет в `Credential.encryptedPayload`.
 * Ошибка здесь дешевле любой другой: секрет, принятый в неверной форме,
 * обнаруживается уже отказом кабинета в проде.
 */
export function buildCredentialPayload(
  provider: SupportedProvider,
  raw: string,
): BuiltCredentialPayload {
  const input = parseInput(raw);
  const payload = provider === 'YANDEX_DIRECT' ? buildYandex(input) : buildVk(input);
  return { provider, payload, fields: describeFields(payload) };
}
