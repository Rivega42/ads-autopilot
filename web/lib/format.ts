/** Прочерк вместо числа: «данных нет», а не «ноль». */
export const NO_VALUE = '—';

const MONEY = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  maximumFractionDigits: 0,
});

const MONEY_PRECISE = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const INTEGER = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });

const PERCENT = new Intl.NumberFormat('ru-RU', {
  style: 'percent',
  maximumFractionDigits: 2,
});

const SIGNED_PERCENT = new Intl.NumberFormat('ru-RU', {
  style: 'percent',
  maximumFractionDigits: 1,
  signDisplay: 'exceptZero',
});

const COMPACT = new Intl.NumberFormat('ru-RU', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

export function formatMoney(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NO_VALUE;
  return MONEY.format(value);
}

/** Для CPA и ставок: копейки здесь несут смысл. */
export function formatMoneyPrecise(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NO_VALUE;
  return MONEY_PRECISE.format(value);
}

/**
 * Ставка группы объявлений.
 *
 * `null` — не ноль: колонка пуста, когда ручной ставки нет и цену назначает
 * площадка (см. комментарий к `AdGroup.bid` в схеме). Прочерк здесь читался бы
 * как «данных нет», а ноль — как «показы бесплатны»; оба ответа неверны.
 */
export function formatBid(value: number | null | undefined): string {
  if (value === null || value === undefined) return NOT_SET;
  return formatMoneyPrecise(value);
}

/** Подпись для «ставки нет»: у автостратегии цену назначает площадка. */
export const NOT_SET = 'не задана';

export interface BidRange {
  readonly groups: number;
  readonly withBid: number;
  readonly min: number | null;
  readonly max: number | null;
}

/**
 * Ставки групп одним числом для плитки.
 *
 * Три состояния, которые нельзя схлопывать: групп нет вовсе (прочерк), группы
 * есть, но ставку никто не задавал (её назначает площадка), и разброс между
 * минимумом и максимумом. Отдельная ветка на `min === max` нужна, чтобы
 * кампания с одной группой не показывала «12,34 ₽ — 12,34 ₽».
 *
 * `min`/`max` при непустом `withBid` не бывают `null`, но ветка на них есть:
 * плитка обязана выдавать строку, а не `NaN`, на любых данных.
 */
export function formatBidRange(range: BidRange): string {
  if (range.groups === 0) return NO_VALUE;
  if (range.withBid === 0) return NOT_SET;
  if (range.min === null || range.max === null) return NO_VALUE;
  if (range.min === range.max) return formatMoneyPrecise(range.min);
  return `${formatMoneyPrecise(range.min)} — ${formatMoneyPrecise(range.max)}`;
}

export function formatInteger(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NO_VALUE;
  return INTEGER.format(value);
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NO_VALUE;
  return PERCENT.format(value);
}

export function formatSignedPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NO_VALUE;
  return SIGNED_PERCENT.format(value);
}

/** Компактно — для подписей осей, где место дороже точности. */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return NO_VALUE;
  return COMPACT.format(value);
}

/** «через 42 мин» / «истёк 12 мин назад» — для срока жизни апрува. */
export function formatRelativeMinutes(target: Date, now: Date = new Date()): string {
  const minutes = Math.round((target.getTime() - now.getTime()) / 60_000);
  const absolute = Math.abs(minutes);
  const unit = absolute >= 120 ? 'ч' : 'мин';
  const amount = absolute >= 120 ? Math.round(absolute / 60) : absolute;
  return minutes >= 0 ? `через ${amount} ${unit}` : `${amount} ${unit} назад`;
}
