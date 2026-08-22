/**
 * Арифметика отчётов.
 *
 * Единственное правило модуля: там, где делить не на что, результат — `null`,
 * а не ноль и не `Infinity`. CPA при нуле конверсий — это «неизвестно», и
 * показать его нулём значит соврать в самую дорогую сторону: клиент увидит
 * идеальную стоимость лида там, где лидов не было вовсе.
 */

/** `Prisma.Decimal` приходит объектом, а не числом, — приводим через строку, не через `+`. */
export function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Number(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Производная метрика (CPA, CPC, CTR). `null` — знаменатель нулевой или бессмысленный. */
export function divideOrNull(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return numerator / denominator;
}

/**
 * Изменение в процентах относительно базы.
 *
 * База ≤ 0 даёт `null`, а не «+∞» и не «+100%»: рост с нуля до пяти лидов не
 * выражается процентом, и любое число здесь будет выдумкой. Такие случаи
 * отчёт проговаривает словами («было 0»).
 */
export function pctChangeOrNull(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}

/** Среднее по выборке. Пустая выборка — `null`. */
export function meanOrNull(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Стандартное отклонение по выборке (популяционное). Меньше двух точек — `null`. */
export function stdDevOrNull(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const mean = meanOrNull(values);
  if (mean === null) return null;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export function sum(values: readonly number[]): number {
  return values.reduce((acc, v) => acc + v, 0);
}
