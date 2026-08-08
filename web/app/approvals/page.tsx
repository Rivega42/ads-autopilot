import Link from 'next/link';

import { Badge } from '../../components/badge';
import { EmptyState } from '../../components/empty-state';
import { FilterBar } from '../../components/filter-bar';
import { formatMskDateTime, formatYmd } from '../../lib/dates';
import type { SearchParams } from '../../lib/filters';
import { parseFilters, rangeLength, withFilters } from '../../lib/filters';
import { formatRelativeMinutes } from '../../lib/format';
import { approvalDecisionLabel, approvalDecisionTone, approvalKindLabel } from '../../lib/labels';
import { listApprovals } from '../../lib/queries';
import { formatJsonInline } from '../../lib/serialize';

export const dynamic = 'force-dynamic';

export default async function ApprovalsPage({
  searchParams = {},
}: {
  readonly searchParams?: SearchParams;
}) {
  const filters = parseFilters(searchParams);
  const approvals = await listApprovals(filters);
  const now = new Date();

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Очередь апрувов</h1>
          <p className="page-sub">
            Решения принимаются в Telegram-боте — здесь только просмотр. {rangeLength(filters)} дн.:{' '}
            {formatYmd(filters.from)} — {formatYmd(filters.to)} (МСК)
          </p>
        </div>
      </div>

      <FilterBar action="/approvals" filters={filters} fields={['decision', 'clientStatus']} />

      <section className="card">
        {approvals.length === 0 ? (
          <EmptyState>Ничего не ждёт решения за выбранный период.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Создан</th>
                  <th scope="col">Клиент</th>
                  <th scope="col">Тип</th>
                  <th scope="col">Что предлагается</th>
                  <th scope="col">Срок</th>
                  <th scope="col">Решение</th>
                </tr>
              </thead>
              <tbody>
                {approvals.map((approval) => {
                  const expiresAt = new Date(approval.expiresAt);
                  const expired = expiresAt.getTime() < now.getTime();
                  return (
                    <tr key={approval.id}>
                      <td>{formatMskDateTime(new Date(approval.createdAt))}</td>
                      <td>
                        <Link
                          href={withFilters('/campaigns', filters, {
                            clientId: approval.clientId,
                            decision: null,
                          })}
                        >
                          {approval.clientName}
                        </Link>
                      </td>
                      <td>{approvalKindLabel(approval.kind)}</td>
                      <td className="cell-wide">
                        {approval.summary ?? <span className="muted">без карточки</span>}
                        <details>
                          <summary className="cell-note">payload</summary>
                          <p className="json">{formatJsonInline(approval.payload, 600)}</p>
                        </details>
                        {approval.error ? (
                          <span className="cell-note">ошибка: {approval.error}</span>
                        ) : null}
                      </td>
                      <td>
                        {formatMskDateTime(expiresAt)}
                        <span className="cell-note">
                          {expired ? 'истёк ' : ''}
                          {formatRelativeMinutes(expiresAt, now)}
                        </span>
                      </td>
                      <td>
                        <Badge tone={approvalDecisionTone(approval.decision)}>
                          {approvalDecisionLabel(approval.decision)}
                        </Badge>
                        {approval.respondedBy ? (
                          <span className="cell-note">{approval.respondedBy}</span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
