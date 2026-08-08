/**
 * Числа и даты в том виде, в каком их читает клиент в Telegram.
 *
 * Форматирование ручное, без `toLocaleString`: разные сборки Node дают то
 * узкий неразрывный пробел, то обычный, и тест на «1 234 ₽» начинает падать
 * от смены образа. Отчёт — это текст, который сравнивается посимвольно.
 */

/** Значение отсутствует. Одно на весь отчёт: «—» честнее, чем 0 или ∞. */
export const DASH = '—';

const MONTHS_SHORT = [
  'янв',
  'фев',
  'мар',
  'апр',
  'мая',
  'июн',
  'июл',
  'авг',
  'сен',
  'окт',
  'ноя',
  'дек',
] as const;

function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export function formatInt(value: number): string {
  if (!Number.isFinite(value)) return DASH;
  const rounded = Math.round(value);
  return `${rounded < 0 ? '−' : ''}${group(String(Math.abs(rounded)))}`;
}

/** Рубли до целых: копейки в сводке за день не значат ничего, а строку удлиняют. */
export function formatMoney(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return DASH;
  return `${formatInt(value)} ₽`;
}

/** Доля (0.0512) → «5,12%». Именно доля: в `CampaignStat.ctr` лежит она, а не проценты. */
export function formatRatio(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return DASH;
  return `${(value * 100).toFixed(2).replace('.', ',')}%`;
}

/** Изменение к базе: «+12%», «−7%», «—», если базы не было. */
export function formatPctChange(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return DASH;
  const rounded = Math.round(value);
  if (rounded === 0) return '0%';
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded)}%`;
}

/** Модуль изменения: для фраз вида «расход упал на 45%», где знак несёт глагол. */
export function formatPctMagnitude(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return DASH;
  return `${Math.round(Math.abs(value))}%`;
}

/** Стрелка направления: в строке с суммой она читается быстрее, чем знак числа. */
export function trendArrow(value: number | null): string {
  if (value === null || Math.round(value) === 0) return '→';
  return value > 0 ? '↑' : '↓';
}

/** `2026-08-07` → `07.08`. */
export function formatDayShort(ymd: string): string {
  const [, month, day] = ymd.split('-');
  return `${day ?? '??'}.${month ?? '??'}`;
}

/** `2026-08-07` → `07.08.2026`. */
export function formatDayFull(ymd: string): string {
  const [year, month, day] = ymd.split('-');
  return `${day ?? '??'}.${month ?? '??'}.${year ?? '????'}`;
}

/** `2026-08-07` → `7 авг`. Для подписей осей графика, где место дорого. */
export function formatDayLabel(ymd: string): string {
  const [, month, day] = ymd.split('-');
  const index = Number(month) - 1;
  const name = MONTHS_SHORT[index] ?? '';
  return `${Number(day)} ${name}`.trim();
}

/** Обрезает длинное имя кампании: в строку отчёта оно не влезает, а перенос ломает вид. */
export function truncate(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}
