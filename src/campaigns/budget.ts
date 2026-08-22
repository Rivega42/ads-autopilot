/**
 * Раскладка дневного бюджета.
 *
 * Арифметику здесь делает код, а не модель (CLAUDE.md §8 и требование ТЗ §13.2):
 * «60/25/15» от LLM — это текст, а не деньги. Модуль чистый: ни БД, ни сети, ни времени.
 *
 * Два инварианта, ради которых он вообще существует:
 *  1. Сумма долей равна исходной сумме до копейки. Округление каждой доли по
 *     отдельности теряет копейки, и «15 000 ₽/сут» в кабинете превращается в 14 999,98.
 *  2. Ни одна доля не меньше минимального дневного бюджета площадки. Кампания на
 *     200 ₽ в Директе не запустится, поэтому такую долю честнее не создавать вовсе,
 *     а её деньги отдать оставшимся.
 */

const KOPECKS = 100;

export interface BudgetPart {
  key: string;
  /** Вес доли. Ноль и отрицательные значения отбрасываются. */
  weight: number;
}

export interface BudgetAllocation {
  key: string;
  /** Рубли с двумя знаками. */
  amountRub: number;
}

export interface DroppedPart {
  key: string;
  reason: string;
}

export interface BudgetSplit {
  allocations: BudgetAllocation[];
  dropped: DroppedPart[];
  /** Сумма выданных долей. Совпадает с total, если хоть одна доля осталась. */
  totalRub: number;
}

export interface SplitBudgetOptions {
  /** Нижняя граница одной доли. Доли меньше неё не выдаются. */
  minRub: number;
}

function toKopecks(rub: number): number {
  return Math.round(rub * KOPECKS);
}

function toRubles(kop: number): number {
  return kop / KOPECKS;
}

/**
 * Метод наибольших остатков в копейках.
 *
 * Копейки, а не рубли с плавающей точкой: 10 000 / 3 в double даёт три доли,
 * сумма которых не равна 10 000 ни при каком порядке округления.
 */
function allocateByLargestRemainder(totalKop: number, parts: readonly BudgetPart[]): number[] {
  const weightSum = parts.reduce((acc, p) => acc + p.weight, 0);
  const exact = parts.map((p) => (totalKop * p.weight) / weightSum);
  const floors = exact.map((value) => Math.floor(value));

  let remainder = totalKop - floors.reduce((acc, value) => acc + value, 0);
  const order = exact
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    // Равные остатки разрешаем по исходному порядку: раскладка обязана быть
    // воспроизводимой, иначе один и тот же план даёт разные бюджеты на ретрае.
    .sort((a, b) => b.frac - a.frac || a.index - b.index);

  for (const { index } of order) {
    if (remainder <= 0) break;
    floors[index] = (floors[index] ?? 0) + 1;
    remainder -= 1;
  }

  return floors;
}

/**
 * Делит сумму на доли по весам.
 *
 * @param totalRub - общий дневной бюджет в рублях
 * @param parts - доли с весами; порядок влияет только на разрешение равных остатков
 * @param opts - минимальный размер доли (для Директа — DIRECT_MIN_DAILY_BUDGET_RUB)
 * @returns доли, сумма которых точно равна `totalRub`, и список отброшенных
 */
export function splitBudget(
  totalRub: number,
  parts: readonly BudgetPart[],
  opts: SplitBudgetOptions,
): BudgetSplit {
  const totalKop = toKopecks(totalRub);
  const minKop = toKopecks(opts.minRub);
  const dropped: DroppedPart[] = [];

  let active = parts.filter((p) => {
    if (p.weight > 0) return true;
    dropped.push({ key: p.key, reason: 'нулевой вес' });
    return false;
  });

  for (;;) {
    if (active.length === 0) {
      return { allocations: [], dropped, totalRub: 0 };
    }

    // Заведомо не хватает на всех — убираем самую лёгкую долю, не дожидаясь раскладки.
    if (totalKop < minKop * active.length) {
      active = dropLightest(active, dropped, opts.minRub);
      continue;
    }

    const amounts = allocateByLargestRemainder(totalKop, active);
    const shortIndex = amounts.findIndex((amount) => amount < minKop);
    if (shortIndex >= 0) {
      // Перекошенные веса: сумма на всех хватает, а конкретной доле — нет.
      const victim = active[shortIndex];
      if (victim) dropped.push({ key: victim.key, reason: belowMinimum(opts.minRub) });
      active = active.filter((_, index) => index !== shortIndex);
      continue;
    }

    return {
      allocations: active.map((part, index) => ({
        key: part.key,
        amountRub: toRubles(amounts[index] ?? 0),
      })),
      dropped,
      totalRub: toRubles(totalKop),
    };
  }
}

function dropLightest(
  active: readonly BudgetPart[],
  dropped: DroppedPart[],
  minRub: number,
): BudgetPart[] {
  let victimIndex = 0;
  for (let i = 1; i < active.length; i += 1) {
    const current = active[i];
    const best = active[victimIndex];
    // Строгое «меньше» оставляет при равных весах первую долю — порядок входа главнее.
    if (current && best && current.weight < best.weight) victimIndex = i;
  }
  const victim = active[victimIndex];
  if (victim) dropped.push({ key: victim.key, reason: belowMinimum(minRub) });
  return active.filter((_, index) => index !== victimIndex);
}

function belowMinimum(minRub: number): string {
  return `доля меньше минимального дневного бюджета ${minRub} ₽`;
}

/**
 * Общий дневной бюджет из брифа.
 *
 * `per_channel` в брифе означает «столько на каждый канал» (TZ §13.1), поэтому общая
 * сумма зависит от числа каналов, а не от одной цифры в ответе клиента.
 */
export function totalDailyBudget(
  dailyBudgetRub: number,
  scope: 'per_channel' | 'total',
  channelCount: number,
): number {
  if (scope === 'total') return dailyBudgetRub;
  return dailyBudgetRub * Math.max(1, channelCount);
}
