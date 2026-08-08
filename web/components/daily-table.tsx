import { formatYmd } from '../lib/dates';
import { formatInteger, formatMoney, formatMoneyPrecise, formatPercent } from '../lib/format';
import { ctr } from '../lib/metrics';
import type { DailyMetrics } from '../lib/queries';

export interface DailyTableProps {
  readonly rows: readonly DailyMetrics[];
}

/**
 * Таблица-двойник графиков.
 *
 * Не «дополнительно, если захочется»: значение, доступное только по наведению,
 * недоступно с клавиатуры и в печати. Здесь лежит всё, что нарисовано выше.
 */
export function DailyTable({ rows }: DailyTableProps) {
  return (
    <details className="table-view">
      <summary>Таблица значений по дням</summary>
      <div className="table-wrap scroll-y">
        <table>
          <thead>
            <tr>
              <th scope="col">Дата</th>
              <th scope="col" className="num">
                Показы
              </th>
              <th scope="col" className="num">
                Клики
              </th>
              <th scope="col" className="num">
                CTR
              </th>
              <th scope="col" className="num">
                Расход
              </th>
              <th scope="col" className="num">
                Конверсии
              </th>
              <th scope="col" className="num">
                CPA
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.date}>
                <td className="num">{formatYmd(row.date)}</td>
                <td className="num">{formatInteger(row.impressions)}</td>
                <td className="num">{formatInteger(row.clicks)}</td>
                <td className="num">{formatPercent(ctr(row.clicks, row.impressions))}</td>
                <td className="num">{formatMoney(row.spend)}</td>
                <td className="num">{formatInteger(row.conversions)}</td>
                <td className="num">{formatMoneyPrecise(row.cpa)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
