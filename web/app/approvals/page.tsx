import Link from 'next/link';

import { Badge } from '../../components/badge';
import { EmptyState } from '../../components/empty-state';
import { FilterBar } from '../../components/filter-bar';
import { formatMskDateTime, formatYmd } from '../../lib/dates';
import type { SearchParams } from '../../lib/filters';
import { parseFilters, rangeLength, withFilters } from '../../lib/filters';
import { formatInteger, formatRelativeMinutes } from '../../lib/format';
import { approvalDecisionLabel, approvalDecisionTone, approvalKindLabel } from '../../lib/labels';
import { listApprovalsView } from '../../lib/queries';
import { formatJsonInline } from '../../lib/serialize';

export const dynamic = 'force-dynamic';

export default async function ApprovalsPage({
  searchParams = {},
}: {
  readonly searchParams?: SearchParams;
}) {
  const filters = parseFilters(searchParams);
  const view = await listApprovalsView(filters);
  const approvals = view.rows;
  const now = new Date();

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Очередь апрувов</h1>
          <p className="page-sub">
            Решения принимаются в Telegram-боте — здесь только просмотр.{' '}
            {view.periodApplies
              ? `${rangeLength(filters)} дн.: ${formatYmd(filters.from)} — ${formatYmd(filters.to)} (МСК)`
              : `Ждут решения: ${formatInteger(view.total)} — очередь показана целиком, период (${formatYmd(filters.from)} — ${formatYmd(filters.to)}) фильтрует только принятые решения.`}
          </p>
        </div>
      </div>

      <FilterBar action="/approvals" filters={filters} fields={['decision', 'clientStatus']} />

      {view.truncated ? (
        <section className="notice notice-info" role="note">
          <strong>
            Показаны первые {formatInteger(approvals.length)} из {formatInteger(view.total)}
          </strong>
          <p className="notice-text">
            Список обрезан потолком витрины — остальные строки не пропали, их просто здесь нет.
            Счётчик в шапке считает очередь целиком.
          </p>
        </section>
      ) : null}

      <section className="card">
        {approvals.length === 0 ? (
          <EmptyState>
            {view.periodApplies
              ? 'Решений с таким статусом за выбранный период нет.'
              : 'Ничего не ждёт решения.'}
          </EmptyState>
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
