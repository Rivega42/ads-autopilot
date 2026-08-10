/**
 * Статистика для A/B-теста креативов.
 *
 * Здесь только чистые функции и ни одного бизнес-правила: правила живут в
 * `select.ts`, а это — арифметика, которую можно проверить по учебнику.
 *
 * Зачем вообще: ТЗ §13.3 говорит «3 варианта → 500 показов → победитель по CTR».
 * Взять argmax от CTR на 500 показах нельзя. При CTR 2% это ~10 кликов на вариант,
 * а стандартное отклонение числа кликов при n=500, p=0.02 равно √(500·0.02·0.98) ≈ 3.1:
 * разница «8 кликов против 12» укладывается в один сигма-интервал и означает ровно
 * ничего. Победитель, выбранный на таком различии, — это подброшенная монетка,
 * которая потом месяц крутится в кабинете за деньги клиента.
 */

export interface Interval {
  low: number;
  high: number;
}

export interface ProportionCounts {
  /** Числитель: клики. */
  successes: number;
  /** Знаменатель: показы. */
  trials: number;
}

/**
 * Φ(z) — функция распределения стандартной нормали.
 *
 * Приближение Абрамовица–Стиган 7.1.26 для erf: абсолютная ошибка < 1.5e-7.
 * Для p-value, которое мы сравниваем с 0.05, этого с запасом; тянуть ради него
 * зависимость со статистикой в проект незачем.
 */
export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

/**
 * z-квантиль стандартной нормали (обратная к `normalCdf`).
 *
 * Рациональное приближение Acklam: относительная ошибка < 1.15e-9 на (0,1).
 * Нужен для доверительных интервалов и для расчёта необходимого объёма выборки.
 */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) {
    throw new RangeError(`normalQuantile expects p in (0,1), got ${p}`);
  }

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  if (p < pLow) return tail(Math.sqrt(-2 * Math.log(p)));
  if (p > pHigh) return -tail(Math.sqrt(-2 * Math.log(1 - p)));

  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((A0 * r + A1) * r + A2) * r + A3) * r + A4) * r + A5) * q) /
    (((((B0 * r + B1) * r + B2) * r + B3) * r + B4) * r + 1)
  );
}

// Коэффициенты Acklam. Именованными константами, а не массивами: с
// noUncheckedIndexedAccess каждое обращение по индексу пришлось бы разыменовывать,
// и формула перестала бы читаться как формула.
const A0 = -3.969683028665376e1;
const A1 = 2.209460984245205e2;
const A2 = -2.759285104469687e2;
const A3 = 1.38357751867269e2;
const A4 = -3.066479806614716e1;
const A5 = 2.506628277459239;
const B0 = -5.447609879822406e1;
const B1 = 1.615858368580409e2;
const B2 = -1.556989798598866e2;
const B3 = 6.680131188771972e1;
const B4 = -1.328068155288572e1;
const C0 = -7.784894002430293e-3;
const C1 = -3.223964580411365e-1;
const C2 = -2.400758277161838;
const C3 = -2.549732539343734;
const C4 = 4.374664141464968;
const C5 = 2.938163982698783;
const D0 = 7.784695709041462e-3;
const D1 = 3.224671290700398e-1;
const D2 = 2.445134137142996;
const D3 = 3.754408661907416;

/** Хвостовая ветвь приближения Acklam. */
function tail(q: number): number {
  return (
    (((((C0 * q + C1) * q + C2) * q + C3) * q + C4) * q + C5) /
    ((((D0 * q + D1) * q + D2) * q + D3) * q + 1)
  );
}

/** Двусторонний критический z для уровня значимости alpha. */
export function twoSidedZ(alpha: number): number {
  return normalQuantile(1 - alpha / 2);
}

export function ctr(counts: ProportionCounts): number {
  return counts.trials > 0 ? counts.successes / counts.trials : 0;
}

/**
 * Доверительный интервал Уилсона для доли.
 *
 * Не Вальд (p ± z·√(p(1−p)/n)): на CTR порядка 2% и n порядка сотен Вальд систематически
 * занижает ширину и умеет вылезать за [0,1] — при нуле кликов он выдаёт интервал
 * нулевой ширины, то есть «мы точно знаем, что CTR = 0». Уилсон в тех же условиях
 * ведёт себя корректно, поэтому в карточку идёт именно он.
 */
export function wilsonInterval(counts: ProportionCounts, alpha = 0.05): Interval {
  const n = counts.trials;
  if (n <= 0) return { low: 0, high: 1 };

  const z = twoSidedZ(alpha);
  const p = counts.successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));

  return {
    low: Math.max(0, (centre - spread) / denominator),
    high: Math.min(1, (centre + spread) / denominator),
  };
}

export interface ProportionTest {
  /** p_a − p_b. */
  diff: number;
  /** Объединённая доля, по ней считается стандартная ошибка нулевой гипотезы. */
  pooled: number;
  z: number;
  /** Двусторонний p-value. */
  pValue: number;
  /**
   * false — нормальное приближение неприменимо: ожидаемых кликов (или непокликов)
   * в группе меньше `minExpected`. Считать p-value в таком режиме — врать себе.
   */
  approximationValid: boolean;
}

/**
 * Двухвыборочный z-тест для долей (пулированная дисперсия).
 *
 * Возвращает null, когда сравнивать нечего: в какой-то группе ноль показов.
 */
export function twoProportionZTest(
  a: ProportionCounts,
  b: ProportionCounts,
  minExpected = 5,
): ProportionTest | null {
  if (a.trials <= 0 || b.trials <= 0) return null;

  const pa = a.successes / a.trials;
  const pb = b.successes / b.trials;
  const pooled = (a.successes + b.successes) / (a.trials + b.trials);
  const diff = pa - pb;

  // Правило np ≥ 5 и n(1−p) ≥ 5 в обеих группах — граница, за которой биномиальное
  // распределение перестаёт быть похоже на нормальное. Ниже неё p-value формально
  // считается, но означает не то, что написано.
  const approximationValid =
    Math.min(
      a.trials * pooled,
      a.trials * (1 - pooled),
      b.trials * pooled,
      b.trials * (1 - pooled),
    ) >= minExpected;

  const se = Math.sqrt(pooled * (1 - pooled) * (1 / a.trials + 1 / b.trials));
  if (se === 0) {
    // Обе группы либо без кликов, либо кликнули все: различия нет по построению.
    return { diff, pooled, z: 0, pValue: 1, approximationValid };
  }

  const z = diff / se;
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));
  return { diff, pooled, z, pValue: Math.min(1, Math.max(0, pValue)), approximationValid };
}

/**
 * Сколько показов на вариант нужно, чтобы заметить относительный прирост CTR.
 *
 * Обычная формула для сравнения двух долей:
 *   n = (z_{α/2} + z_β)² · (p₁(1−p₁) + p₂(1−p₂)) / (p₂ − p₁)²
 *
 * Нужна не ради красоты: она показывает, что при CTR 2% и желании поймать прирост
 * в 20% требуется порядка 30 000 показов на вариант, а не 500 из ТЗ. Число уезжает
 * в отчёт — иначе «победитель не определён» читается как поломка, а не как ответ.
 *
 * @param baselineCtr - базовый CTR (доля, не проценты)
 * @param relativeLift - искомый относительный прирост, 0.2 = +20%
 * @param alpha - уровень значимости (уже с поправкой на множественность, если нужна)
 * @param power - мощность, вероятность заметить существующий эффект
 */
export function requiredTrialsPerVariant(
  baselineCtr: number,
  relativeLift: number,
  alpha = 0.05,
  power = 0.8,
): number | null {
  if (baselineCtr <= 0 || baselineCtr >= 1) return null;
  if (relativeLift <= 0) return null;

  const p1 = baselineCtr;
  const p2 = Math.min(0.999999, baselineCtr * (1 + relativeLift));
  const delta = p2 - p1;
  if (delta <= 0) return null;

  const zAlpha = twoSidedZ(alpha);
  const zBeta = normalQuantile(power);
  const n = ((zAlpha + zBeta) ** 2 * (p1 * (1 - p1) + p2 * (1 - p2))) / (delta * delta);
  return Math.ceil(n);
}
