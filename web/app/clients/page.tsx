import Link from 'next/link';

import { AttributionNote, MixedCpaNote } from '../../components/attribution';
import { Badge, PlainBadge } from '../../components/badge';
import { EmptyState } from '../../components/empty-state';
import { FilterBar } from '../../components/filter-bar';
import { comparableCpa } from '../../lib/attribution';
import { formatYmd } from '../../lib/dates';
import type { SearchParams } from '../../lib/filters';
import { parseFilters, rangeLength, withFilters } from '../../lib/filters';
import { formatInteger, formatMoney, formatMoneyPrecise } from '../../lib/format';
import { clientStatusLabel, clientStatusTone, providerLabel } from '../../lib/labels';
import { listClients } from '../../lib/queries';

export const dynamic = 'force-dynamic';

export default async function ClientsPage({
  searchParams = {},
}: {
  readonly searchParams?: SearchParams;
}) {
  const filters = parseFilters(searchParams);
  const clients = await listClients(filters);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Клиенты</h1>
          <p className="page-sub">
            Расход и CPA за {rangeLength(filters)} дн.: {formatYmd(filters.from)} —{' '}
            {formatYmd(filters.to)} (МСК)
          </p>
        </div>
      </div>

      <FilterBar action="/clients" filters={filters} fields={['provider', 'clientStatus']} />

      <section className="card">
        {clients.length === 0 ? (
          <EmptyState>Клиентов под этот фильтр нет.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Клиент</th>
                  <th scope="col">Статус</th>
                  <th scope="col">Каналы</th>
                  <th scope="col" className="num">
                    Кампаний
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
                {clients.map((client) => (
                  <tr key={client.id}>
                    <td>
                      <Link
                        className="cell-strong"
                        href={withFilters('/campaigns', filters, { clientId: client.id })}
                      >
                        {client.name}
                      </Link>
                      {client.tgUsername ? (
                        <span className="cell-note">@{client.tgUsername}</span>
                      ) : null}
                    </td>
                    <td>
                      <Badge tone={clientStatusTone(client.status)}>
                        {clientStatusLabel(client.status)}
                      </Badge>
                    </td>
                    <td>
                      {client.channels.length === 0 ? (
                        <span className="muted">нет</span>
                      ) : (
                        <div className="badges">
                          {client.channels.map((channel) => (
                            <PlainBadge key={channel}>{providerLabel(channel)}</PlainBadge>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="num">
                      {formatInteger(client.campaignCount)}
                      <span className="cell-note">
                        активных {formatInteger(client.activeCampaignCount)}
                      </span>
                    </td>
                    <td className="num">{formatMoney(client.totals.spend)}</td>
                    <td className="num">
                      {formatInteger(client.totals.conversions)}
                      <AttributionNote summary={client.totals.attribution} prefix="источник" />
                    </td>
                    <td className="num">
                      {formatMoneyPrecise(
                        comparableCpa(client.totals.cpa, client.totals.attribution),
                      )}
                      {client.totals.attribution.mixed ? <MixedCpaNote /> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
