import {
  CHART_GEOMETRY,
  areaPath,
  barPath,
  buildSegments,
  linePath,
  niceScale,
  plotHeight,
  plotWidth,
  tickIndices,
} from '../lib/chart';
import { formatCompact } from '../lib/format';

export interface ChartPoint {
  /** Подпись оси X. */
  readonly label: string;
  /** Полная подпись для всплывающей подсказки. */
  readonly title: string;
  /** `null` — значения нет; линия рвётся, столбик не рисуется. */
  readonly value: number | null;
}

export interface ChartReference {
  readonly value: number;
  readonly label: string;
}

export interface MetricChartProps {
  readonly title: string;
  /** Одно число рядом с заголовком: итог или последнее значение. */
  readonly summary?: string;
  readonly points: readonly ChartPoint[];
  readonly kind?: 'line' | 'column';
  readonly formatValue: (value: number) => string;
  /** Шкала без дробных делений — для показов, кликов, конверсий. */
  readonly integer?: boolean;
  readonly reference?: ChartReference | null;
}

const BAR_MAX_WIDTH = 24;
/** Зазор между соседними столбиками — «воздухом», а не обводкой. */
const BAR_GAP = 2;

export function MetricChart({
  title,
  summary,
  points,
  kind = 'line',
  formatValue,
  integer = false,
  reference = null,
}: MetricChartProps) {
  const geometry = CHART_GEOMETRY;
  const width = plotWidth(geometry);
  const height = plotHeight(geometry);
  const baseline = geometry.padTop + height;

  const values = points.map((point) => point.value);
  const known = values.filter((value): value is number => value !== null && Number.isFinite(value));
  const rawMax = Math.max(...known, reference?.value ?? 0, 0);
  const hasData = known.some((value) => value > 0);
  const scale = niceScale(rawMax, integer);

  const band = points.length > 0 ? width / points.length : width;
  const centerX = (index: number): number => geometry.padLeft + band * (index + 0.5);
  const y = (value: number): number => geometry.padTop + height * (1 - value / scale.max);

  const segments = buildSegments(values);
  const labelled = new Set(tickIndices(points.length));

  const lastKnownIndex = values.reduce<number>(
    (found, value, index) => (value === null ? found : index),
    -1,
  );
  const lastKnown = lastKnownIndex >= 0 ? (values[lastKnownIndex] as number) : null;

  const barWidth = Math.max(2, Math.min(BAR_MAX_WIDTH, band - BAR_GAP));

  return (
    <figure className="card chart">
      <figcaption className="chart-title">
        <h3>{title}</h3>
        {summary ? <span className="chart-value">{summary}</span> : null}
      </figcaption>

      <svg
        viewBox={`0 0 ${geometry.width} ${geometry.height}`}
        role="img"
        aria-label={`${title}. Значения по дням доступны в таблице под графиками.`}
      >
        {scale.ticks.map((tick) => (
          <g key={`tick-${tick}`}>
            <line
              className="ch-grid"
              x1={geometry.padLeft}
              x2={geometry.padLeft + width}
              y1={y(tick)}
              y2={y(tick)}
            />
            <text className="ch-tick" x={geometry.padLeft - 8} y={y(tick) + 3} textAnchor="end">
              {formatCompact(tick)}
            </text>
          </g>
        ))}

        <line
          className="ch-axis"
          x1={geometry.padLeft}
          x2={geometry.padLeft + width}
          y1={baseline}
          y2={baseline}
        />

        {reference && reference.value > 0 ? (
          <g>
            <line
              className="ch-ref"
              x1={geometry.padLeft}
              x2={geometry.padLeft + width}
              y1={y(reference.value)}
              y2={y(reference.value)}
            />
            {/* Подпись порога прижата к правому краю поля, а не к гутеру:
                в гутере стоит прямая подпись последнего значения. */}
            <text
              className="ch-ref-label"
              x={geometry.padLeft + width - 4}
              y={Math.max(y(reference.value) - 5, geometry.padTop + 9)}
              textAnchor="end"
            >
              {reference.label}
            </text>
          </g>
        ) : null}

        {kind === 'line'
          ? segments.map((segment) => {
              const coordinates = segment.map(
                (index) => [centerX(index), y(values[index] as number)] as const,
              );
              const key = `seg-${segment[0]}`;
              return (
                <g key={key}>
                  <path className="ch-area" d={areaPath(coordinates, baseline)} />
                  <path className="ch-line" d={linePath(coordinates)} />
                </g>
              );
            })
          : points.map((point, index) =>
              point.value === null || point.value <= 0 ? null : (
                <path
                  key={`bar-${point.label}-${index}`}
                  className="ch-bar"
                  d={barPath(
                    centerX(index) - barWidth / 2,
                    y(point.value),
                    barWidth,
                    baseline - y(point.value),
                  )}
                />
              ),
            )}

        {lastKnown !== null ? (
          <g>
            <circle className="ch-end-dot" cx={centerX(lastKnownIndex)} cy={y(lastKnown)} r={4} />
            <text
              className="ch-end-label"
              x={centerX(lastKnownIndex) + 9}
              y={Math.min(Math.max(y(lastKnown) + 4, geometry.padTop + 10), baseline)}
            >
              {formatValue(lastKnown)}
            </text>
          </g>
        ) : null}

        {points.map((point, index) =>
          labelled.has(index) ? (
            <text
              key={`label-${point.label}-${index}`}
              className="ch-tick"
              x={centerX(index)}
              y={baseline + 16}
              textAnchor="middle"
            >
              {point.label}
            </text>
          ) : null,
        )}

        {/* Слой наведения поверх марок: цель — вся полоса дня, а не 2px линии. */}
        {points.map((point, index) => (
          <g className="ch-col" key={`hit-${point.label}-${index}`}>
            <line
              className="ch-cross"
              x1={centerX(index)}
              x2={centerX(index)}
              y1={geometry.padTop}
              y2={baseline}
            />
            {point.value !== null ? (
              <circle className="ch-dot" cx={centerX(index)} cy={y(point.value)} r={4} />
            ) : null}
            <rect
              x={geometry.padLeft + band * index}
              y={geometry.padTop}
              width={band}
              height={height}
              fill="transparent"
            >
              <title>{`${point.title}: ${point.value === null ? '—' : formatValue(point.value)}`}</title>
            </rect>
          </g>
        ))}

        {hasData ? null : (
          <text
            className="ch-empty"
            x={geometry.padLeft + width / 2}
            y={geometry.padTop + height / 2}
            textAnchor="middle"
          >
            Нет данных за период
          </text>
        )}
      </svg>
    </figure>
  );
}
