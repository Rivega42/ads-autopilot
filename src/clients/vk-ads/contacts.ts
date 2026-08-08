import { createHash } from 'node:crypto';

import { VK_CHANNEL } from '@/clients/vk-ads/auth.js';
import { ChannelError } from '@/lib/errors.js';

/**
 * Хеширование контактов клиента перед загрузкой в аудитории VK.
 *
 * Это единственное место в системе, где через код проходят персональные данные
 * покупателей клиента. Инвариант всего модуля: сырой контакт не может попасть
 * ни в сеть, ни в лог, ни в контекст ошибки. Он держится не дисциплиной, а
 * типом: `uploadContacts` принимает только `VkHashedContact`, а получить
 * значение этого типа можно исключительно из функций ниже — а они хешируют.
 *
 * Поэтому же ни одна функция файла не логирует свой вход и не кладёт его в
 * `ChannelError.context`: там только вид контакта и причина отказа.
 */

export type VkContactKind = 'email' | 'phone';

declare const vkHashedContactBrand: unique symbol;

/** Готовый к отправке контакт: вид и SHA-256 в hex-нижнем регистре. */
export interface VkHashedContact {
  readonly kind: VkContactKind;
  readonly hash: string;
  /** Марка типа: существует только в системе типов, в рантайме поля нет. */
  readonly [vkHashedContactBrand]: true;
}

/** Длина SHA-256 в hex. Используется и как рантайм-проверка марки типа. */
const SHA256_HEX_LENGTH = 64;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Телефон нормализуем в «голые цифры с кодом страны», без `+`: `79011234567`.
 *
 * Источник: справка VK Рекламы по спискам пользователей — «номера телефонов в
 * формате [код страны][код региона][номер] без пробелов и других символов,
 * например 79011234567» (ads.vk.ru/en/help/features/audiences_lists/user_lists).
 * То есть не E.164: ведущий `+` в исходной строке площадка не ждёт, а хеш от
 * `+79011234567` не совпадёт с хешем от `79011234567` — это уже не «немного
 * другой формат», а полностью потерянный мэтч.
 */
export const VK_PHONE_MIN_DIGITS = 11;
export const VK_PHONE_MAX_DIGITS = 15;

/**
 * Национальный номер без кода страны считаем российским.
 *
 * Клиентская база сервиса — РФ (см. CLAUDE.md), а десятизначный номер в выгрузке
 * из CRM почти всегда записан как «9001234567». Альтернатива — отбрасывать такие
 * записи — стоила бы заметной части списка.
 */
const RU_COUNTRY_CODE = '7';
const RU_TRUNK_PREFIX = '8';
const RU_NATIONAL_DIGITS = 10;

/** Проверка формы, а не существования адреса: `@`, точка в домене, без пробелов. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function invalidContact(kind: VkContactKind, reason: string): ChannelError {
  // Ни `raw`, ни его фрагмента здесь быть не может: ошибка уезжает в ErrorLog.
  return new ChannelError(VK_CHANNEL, `VK ${kind} contact is not usable: ${reason}`, {
    code: 'VK_INVALID_CONTACT',
    retryable: false,
    context: { kind, reason },
  });
}

/**
 * Приводит email к виду, от которого VK считает хеш: без пробелов, в нижнем регистре.
 *
 * @throws {ChannelError} `VK_INVALID_CONTACT`, если строка не похожа на адрес
 */
export function normalizeEmail(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (value === '') throw invalidContact('email', 'empty');
  if (!EMAIL_SHAPE.test(value)) throw invalidContact('email', 'not an email address');
  return value;
}

/**
 * Приводит телефон к виду `79011234567`: только цифры, код страны обязателен.
 *
 * `8` в начале одиннадцатизначного номера — российский код выхода на межгород,
 * а не код страны; без замены на `7` половина выгрузок из CRM не сматчится.
 *
 * @throws {ChannelError} `VK_INVALID_CONTACT`, если цифр слишком мало или слишком много
 */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits === '') throw invalidContact('phone', 'no digits');

  let value = digits;
  if (value.length === VK_PHONE_MIN_DIGITS && value.startsWith(RU_TRUNK_PREFIX)) {
    value = RU_COUNTRY_CODE + value.slice(1);
  } else if (value.length === RU_NATIONAL_DIGITS) {
    value = RU_COUNTRY_CODE + value;
  }

  if (value.length < VK_PHONE_MIN_DIGITS) throw invalidContact('phone', 'too short');
  if (value.length > VK_PHONE_MAX_DIGITS) throw invalidContact('phone', 'too long');
  return value;
}

export function normalizeContact(kind: VkContactKind, raw: string): string {
  return kind === 'email' ? normalizeEmail(raw) : normalizePhone(raw);
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Единственный конструктор `VkHashedContact`.
 *
 * Приведение типа здесь неизбежно и намеренно: марка `vkHashedContactBrand`
 * объявлена через `declare`, в рантайме её нет. Зато во всём остальном коде
 * собрать это значение вручную не получится.
 */
function hashed(kind: VkContactKind, normalized: string): VkHashedContact {
  return { kind, hash: sha256Hex(normalized) } as VkHashedContact;
}

/**
 * Нормализует и хеширует контакт. Сырое значение дальше этой функции не уходит.
 *
 * @throws {ChannelError} `VK_INVALID_CONTACT` — контакт непригоден (без самого значения в ошибке)
 */
export function hashContact(kind: VkContactKind, raw: string): VkHashedContact {
  return hashed(kind, normalizeContact(kind, raw));
}

export function hashEmail(raw: string): VkHashedContact {
  return hashContact('email', raw);
}

export function hashPhone(raw: string): VkHashedContact {
  return hashContact('phone', raw);
}

/** Итог пакетного хеширования. Отброшенные значения нигде не сохраняются. */
export interface VkContactBatch {
  contacts: VkHashedContact[];
  /** Записи, не прошедшие нормализацию. */
  skipped: number;
  /** Повторы, схлопнутые по (вид, хеш): VK требует уникальные записи в списке. */
  duplicates: number;
}

/**
 * Пакетное хеширование списка контактов.
 *
 * В отличие от `hashContact`, кривая запись не роняет всю выгрузку, а лишь
 * увеличивает счётчик `skipped`: в списке на сотни тысяч строк мусор гарантирован,
 * и терять из-за него весь список нельзя.
 */
export function hashContacts(input: {
  emails?: readonly string[];
  phones?: readonly string[];
}): VkContactBatch {
  const contacts: VkHashedContact[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  let duplicates = 0;

  const add = (kind: VkContactKind, raw: string): void => {
    let contact: VkHashedContact;
    try {
      contact = hashContact(kind, raw);
    } catch {
      // Причина отказа уже описана в ChannelError, но наверх её не поднимаем:
      // счётчик — единственное, что можно показать, не раскрывая запись.
      skipped += 1;
      return;
    }
    const key = `${contact.kind}:${contact.hash}`;
    if (seen.has(key)) {
      duplicates += 1;
      return;
    }
    seen.add(key);
    contacts.push(contact);
  };

  for (const raw of input.emails ?? []) add('email', raw);
  for (const raw of input.phones ?? []) add('phone', raw);

  return { contacts, skipped, duplicates };
}

function isHashedContact(value: unknown): value is VkHashedContact {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  if (obj['kind'] !== 'email' && obj['kind'] !== 'phone') return false;
  const hash = obj['hash'];
  return typeof hash === 'string' && hash.length === SHA256_HEX_LENGTH && SHA256_HEX.test(hash);
}

/**
 * Последний рубеж перед сетью: проверяет, что в пачке действительно хеши.
 *
 * Тип уже не даёт передать сырую строку, но `as` и `JSON.parse` его обходят,
 * а ценой ошибки будет утечка персональных данных на сторону площадки. Поэтому
 * то же самое проверяется в рантайме — и в диагностику попадает только индекс
 * и тип значения, но не оно само.
 *
 * @throws {ChannelError} `VK_RAW_CONTACT`
 */
export function assertHashedContacts(contacts: readonly VkHashedContact[]): void {
  for (const [index, contact] of contacts.entries()) {
    if (isHashedContact(contact)) continue;
    throw new ChannelError(VK_CHANNEL, 'VK contact upload got a value that is not a SHA-256 hash', {
      code: 'VK_RAW_CONTACT',
      retryable: false,
      context: { index, valueType: typeof contact },
    });
  }
}

/** Сколько в пачке контактов каждого вида — для плана записи и логов. */
export function countByKind(contacts: readonly VkHashedContact[]): Record<VkContactKind, number> {
  const counts: Record<VkContactKind, number> = { email: 0, phone: 0 };
  for (const contact of contacts) counts[contact.kind] += 1;
  return counts;
}
