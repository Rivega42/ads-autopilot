/** Геометрия и шкалы графиков. Чистые функции — рисование отдельно, счёт отдельно. */

export interface ChartGeometry {
  readonly width: number;
  readonly height: number;
  readonly padLeft: number;
  readonly padRight: number;
  readonly padTop: number;
  readonly padBottom: number;
}

/**
 * `padRight` заметно больше левого: справа стоит прямая подпись последнего
 * значения, и без запаса она вылезла бы за viewBox.
 * `padBottom` включает полосу подписей оси X — иначе карточка получила бы
 * собственный вертикальный скролл.
 */
export const CHART_GEOMETRY: ChartGeometry = {
  width: 760,
  height: 210,
  padLeft: 56,
  padRight: 76,
  padTop: 14,
  padBottom: 28,
};

export function plotWidth(geometry: ChartGeometry = CHART_GEOMETRY): number {
  return geometry.width - geometry.padLeft - geometry.padRight;
}

export function plotHeight(geometry: ChartGeometry = CHART_GEOMETRY): number {
  return geometry.height - geometry.padTop - geometry.padBottom;
}

export interface Scale {
  readonly max: number;
  readonly step: number;
  readonly ticks: readonly number[];
}

/**
 * Шкала от нуля до «круглого» максимума.
 *
 * Шаг выбирается из 1/2/5×10^k, поэтому подписи оси всегда читаемые числа.
 * `integer` не даёт нарисовать 0,5 конверсии.
 */
export function niceScale(rawMax: number, integer = false): Scale {
  if (!Number.isFinite(rawMax) || rawMax <= 0) {
    return { max: 1, step: 1, ticks: [0, 1] };
  }

  const rough = rawMax / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  // 2,5 в лестнице держит четыре деления там, где 5 оставили бы два.
  // Для целых шкал он не годится: 2,5 конверсии на оси — бессмыслица.
  const ladder = integer ? [1, 2, 5, 10] : [1, 2, 2.5, 5, 10];
  const multiplier = ladder.find((candidate) => normalized <= candidate) ?? 10;
  const step = integer ? Math.max(1, Math.round(multiplier * magnitude)) : multiplier * magnitude;
  const max = Math.ceil(rawMax / step) * step;

  const ticks: number[] = [];
  const count = Math.round(max / step);
  for (let index = 0; index <= count; index += 1) {
    ticks.push(Number((step * index).toPrecision(12)));
  }
  return { max, step, ticks };
}

/** Индексы точек, у которых подписывается ось X: не больше `maxLabels`, последняя всегда. */
export function tickIndices(count: number, maxLabels = 7): number[] {
  if (count <= 0) return [];
  if (count === 1) return [0];

  const stride = Math.max(1, Math.ceil(count / maxLabels));
  const indices: number[] = [];
  for (let index = 0; index < count; index += stride) indices.push(index);

  const last = count - 1;
  const tail = indices[indices.length - 1] ?? 0;
  if (tail !== last) {
    // Подпись последнего дня обязательна, но вплотную к предыдущей она слипнется.
    if (last - tail < stride / 2) indices.pop();
    indices.push(last);
  }
  return indices;
}

/**
 * Индексы точек, сгруппированные в непрерывные отрезки.
 *
 * `null` рвёт линию, а не превращается в ноль: «конверсий не было» и «CPA равен
 * нулю» — разные утверждения.
 */
export function buildSegments(values: readonly (number | null)[]): number[][] {
  const segments: number[][] = [];
  let current: number[] = [];

  values.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) {
      if (current.length > 0) segments.push(current);
      current = [];
      return;
    }
    current.push(index);
  });

  if (current.length > 0) segments.push(current);
  return segments;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Столбик со скруглённым верхом и прямым основанием на базовой линии. */
export function barPath(x: number, y: number, width: number, height: number, radius = 4): string {
  const r = Math.max(0, Math.min(radius, width / 2, height));
  return [
    `M ${round(x)} ${round(y + height)}`,
    `V ${round(y + r)}`,
    `Q ${round(x)} ${round(y)} ${round(x + r)} ${round(y)}`,
    `H ${round(x + width - r)}`,
    `Q ${round(x + width)} ${round(y)} ${round(x + width)} ${round(y + r)}`,
    `V ${round(y + height)}`,
    'Z',
  ].join(' ');
}

export function linePath(points: readonly (readonly [number, number])[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) {
    const [x, y] = points[0] as readonly [number, number];
    // Одна точка не рисуется как линия — даём ей минимальный штрих в 0,01px,
    // иначе stroke-linecap не поставит кружок и день выпадет из графика.
    return `M ${round(x)} ${round(y)} L ${round(x + 0.01)} ${round(y)}`;
  }
  return points
    .map(([x, y], index) => `${index === 0 ? 'M' : 'L'} ${round(x)} ${round(y)}`)
    .join(' ');
}

export function areaPath(points: readonly (readonly [number, number])[], baseline: number): string {
  if (points.length === 0) return '';
  const first = points[0] as readonly [number, number];
  const last = points[points.length - 1] as readonly [number, number];
  return `${linePath(points)} L ${round(last[0])} ${round(baseline)} L ${round(first[0])} ${round(baseline)} Z`;
}
