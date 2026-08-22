import { formatBid } from '../lib/format';
import { adGroupStatusLabel, adGroupStatusTone } from '../lib/labels';
import type { AdGroupRow } from '../lib/queries';

import { Badge } from './badge';
import { EmptyState } from './empty-state';

export interface AdGroupTableProps {
  readonly rows: readonly AdGroupRow[];
}

/**
 * Группы объявлений со ставками.
 *
 * Колонка ставки — не украшение: у VK ключевых слов нет вовсе, и цена задаётся
 * только здесь. Пустая ячейка означает «ставку назначает площадка», а не ноль,
 * поэтому вместо прочерка стоит слово (`formatBid`).
 */
export function AdGroupTable({ rows }: AdGroupTableProps) {
  if (rows.length === 0) {
    return <EmptyState>Групп объявлений у кампании нет.</EmptyState>;
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Группа</th>
            <th scope="col">Статус</th>
            <th scope="col" className="num">
              Ставка
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                {row.name}
                <span className="cell-note">ID площадки {row.externalId}</span>
              </td>
              <td>
                <Badge tone={adGroupStatusTone(row.status)}>{adGroupStatusLabel(row.status)}</Badge>
              </td>
              <td className="num">
                <span className={row.bid === null ? 'muted' : undefined}>{formatBid(row.bid)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
