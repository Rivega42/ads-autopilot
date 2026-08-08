import Link from 'next/link';

import { formatMskDateTime } from '../lib/dates';
import { changeActionLabel, changeActorLabel, providerLabel } from '../lib/labels';
import type { ChangeRow } from '../lib/queries';
import { formatJsonInline } from '../lib/serialize';

import { Badge, PlainBadge } from './badge';
import { EmptyState } from './empty-state';

export interface ChangeLogTableProps {
  readonly rows: readonly ChangeRow[];
  /** На карточке кампании колонка «Кампания» — это шум. */
  readonly showCampaign?: boolean;
}

export function ChangeLogTable({ rows, showCampaign = true }: ChangeLogTableProps) {
  if (rows.length === 0) {
    return <EmptyState>За выбранный период изменений не было.</EmptyState>;
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Когда</th>
            {showCampaign ? <th scope="col">Кампания</th> : null}
            <th scope="col">Объект</th>
            <th scope="col">Что изменилось</th>
            <th scope="col">Почему</th>
            <th scope="col">Кто</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                {formatMskDateTime(new Date(row.appliedAt))}
                {row.rolledBackAt ? (
                  <span className="cell-note">
                    откачено {formatMskDateTime(new Date(row.rolledBackAt))}
                  </span>
                ) : null}
              </td>

              {showCampaign ? (
                <td>
                  {row.campaignId ? (
                    <Link href={`/campaigns/${row.campaignId}`}>{row.campaignName ?? '—'}</Link>
                  ) : (
                    <span className="muted">—</span>
                  )}
                  {row.provider ? (
                    <span className="cell-note">{providerLabel(row.provider)}</span>
                  ) : null}
                </td>
              ) : null}

              <td>
                {row.entityType}
                <span className="cell-note">{row.entityId}</span>
              </td>

              <td className="cell-wide">
                <span className="cell-strong">{changeActionLabel(row.action)}</span>
                <span className="cell-note">
                  {formatJsonInline(row.prevValue)} → {formatJsonInline(row.newValue)}
                </span>
              </td>

              <td className="cell-wide">{row.reason ?? <span className="muted">—</span>}</td>

              <td>
                <div className="badges">
                  <Badge tone={row.actor === 'AI' ? 'serious' : 'neutral'}>
                    {changeActorLabel(row.actor)}
                  </Badge>
                  {row.approvedBy ? <PlainBadge>апрув: {row.approvedBy}</PlainBadge> : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
