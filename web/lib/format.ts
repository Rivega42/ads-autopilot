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
