import { formatDayLabel } from '@/reporter/format.js';
import type { DailyPoint } from '@/reporter/metrics.js';

/**
 * Ссылка на график quickchart.io (ТЗ §5, milestone 6).
 *
 * Картинку мы не скачиваем и нигде не храним: в сообщение уходит URL, а
 * рендерит и кеширует его сам Telegram, когда разворачивает превью. Поэтому
 * здесь нет ни одного сетевого вызова — только сборка строки, которую можно
 * проверить тестом.
 */

const QUICKCHART_URL = 'https://quickchart.io/chart';

/** Дальше начинаются проблемы у прокси и у самого Telegram при разворачивании превью. */
export const MAX_CHART_URL_LENGTH = 3_500;

/** Больше двух недель столбиков в превью Telegram всё равно не разглядеть. */
export const MAX_CHART_POINTS = 14;

export interface ChartOptions {
  width?: number;
  height?: number;
  spendLabel?: string;
  leadsLabel?: string;
}

/**
 * Столбики расхода и линия лидов на общей шкале дней.
 *
 * `null`, если рисовать нечего: пустой график в отчёте выглядит как поломка.
 * Отдельная ось для лидов обязательна — иначе линия в 5 лидов ложится на ноль
 * рядом со столбиками в десятки тысяч рублей.
 */
export function spendLeadsChartUrl(
  points: readonly DailyPoint[],
  options: ChartOptions = {},
): string | null {
  const tail = points.slice(-MAX_CHART_POINTS);
  if (tail.length === 0) return null;
  if (tail.every((p) => p.spend === 0 && p.conversions === 0)) return null;

  const config = {
    type: 'bar',
    data: {
      labels: tail.map((p) => formatDayLabel(p.date)),
      datasets: [
        {
          label: options.spendLabel ?? 'Расход, ₽',
          data: tail.map((p) => Math.round(p.spend)),
          backgroundColor: 'rgba(54,124,214,0.7)',
          yAxisID: 'spend',
          order: 2,
        },
        {
          label: options.leadsLabel ?? 'Лиды',
          data: tail.map((p) => p.conversions),
          type: 'line',
          borderColor: 'rgba(214,94,54,1)',
          backgroundColor: 'rgba(214,94,54,0.2)',
          yAxisID: 'leads',
          order: 1,
        },
      ],
    },
    options: {
      scales: {
        spend: { position: 'left', beginAtZero: true },
        leads: { position: 'right', beginAtZero: true, grid: { display: false } },
      },
    },
  };

  const url = new URL(QUICKCHART_URL);
  url.searchParams.set('w', String(options.width ?? 640));
  url.searchParams.set('h', String(options.height ?? 320));
  url.searchParams.set('bkg', 'white');
  url.searchParams.set('v', '4');
  url.searchParams.set('c', JSON.stringify(config));

  const href = url.toString();
  // Лучше отчёт без картинки, чем сообщение с битой ссылкой.
  return href.length > MAX_CHART_URL_LENGTH ? null : href;
}
