/**
 * Prisma отдаёт два типа, которые нельзя отдать браузеру как есть:
 *
 * - `Decimal` (деньги, ставки) — это объект decimal.js, и `JSON.stringify`
 *   молча превратил бы его в `{ s, e, d }`, а React — в «object Object».
 * - `BigInt` (`CampaignStat.id`, `Client.tgUserId`, `PendingApproval.tgMessageId`)
 *   — на нём `JSON.stringify` бросает `TypeError`.
 *
 * Поэтому наружу из слоя запросов уходят только простые значения: числа,
 * строки, ISO-даты. Преобразование делается здесь и явно.
 */

export type JsonSafe = string | number | boolean | null | JsonSafe[] | { [key: string]: JsonSafe };

interface DecimalLike {
  toNumber(): number;
  toFixed(digits?: number): string;
}

function isDecimalLike(value: object): value is DecimalLike {
  const candidate = value as Partial<DecimalLike>;
  return typeof candidate.toNumber === 'function' && typeof candidate.toFixed === 'function';
}

/**
 * `Decimal | number | bigint | string | null` → `number | null`.
 *
 * Через `toString()`, а не `toNumber()`: строковое представление Decimal точное,
 * и одна и та же ветка обрабатывает строки из сырых запросов.
 */
export function decimalToNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'object' && isDecimalLike(value)) {
    const parsed = Number(String(value));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** То же, но с подстановкой на месте `null` — для сумм, где «нет строки» значит 0. */
export function decimalToNumberOr(value: unknown, fallback: number): number {
  return decimalToNumber(value) ?? fallback;
}

/** BigInt остаётся строкой: в JS-числе он потерял бы точность выше 2^53. */
export function bigIntToString(value: bigint | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.toString();
}

export function dateToIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/**
 * Рекурсивно приводит значение к JSON-безопасному виду.
 *
 * Нужно для колонок `Json` (`ChangeLog.prevValue`, `PendingApproval.payload`):
 * их содержимое произвольно, и гарантий, что внутри нет `Date` или `BigInt`,
 * у нас нет.
 */
export function toJsonSafe(value: unknown): JsonSafe {
  if (value === null || value === undefined) return null;

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'bigint':
      return value.toString();
    case 'object':
      break;
    default:
      return null;
  }

  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value instanceof Date) return value.toISOString();
  if (isDecimalLike(value)) return decimalToNumber(value);

  const result: Record<string, JsonSafe> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    result[key] = toJsonSafe(nested);
  }
  return result;
}

/** Однострочное представление JSON-значения для ячейки таблицы. */
export function formatJsonInline(value: JsonSafe, maxLength = 120): string {
  const rendered = renderInline(value);
  return rendered.length > maxLength ? `${rendered.slice(0, maxLength - 1)}…` : rendered;
}

function renderInline(value: JsonSafe): string {
  if (value === null) return '—';
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return value.map(renderInline).join(', ');
  return Object.entries(value)
    .map(([key, nested]) => `${key}: ${renderInline(nested)}`)
    .join(', ');
}
