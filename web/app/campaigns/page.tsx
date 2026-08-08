import Link from 'next/link';

import { Badge } from '../../components/badge';
import { EmptyState } from '../../components/empty-state';
import { FilterBar } from '../../components/filter-bar';
import { StatTile } from '../../components/stat-tile';
import { formatYmd } from '../../lib/dates';
import type { SearchParams } from '../../lib/filters';
import { parseFilters, rangeLength, withFilters } from '../../lib/filters';
import {
  formatInteger,
  formatMoney,
  formatMoneyPrecise,
  formatSignedPercent,
} from '../../lib/format';
import { campaignStatusLabel, campaignStatusTone, providerLabel } from '../../lib/labels';
import { cpa, cpaDeviation } from '../../lib/metrics';
import { listCampaigns } from '../../lib/queries';

export const dynamic = 'force-dynamic';

export default async function CampaignsPage({
  searchParams = {},
}: {
  readonly searchParams?: SearchParams;
}) {
  const filters = parseFilters(searchParams);
  const campaigns = await listCampaigns(filters);

  const totals = campaigns.reduce(
    (accumulator, campaign) => ({
      spend: accumulator.spend + campaign.totals.spend,
      clicks: accumulator.clicks + campaign.totals.clicks,
      conversions: accumulator.conversions + campaign.totals.conversions,
    }),
    { spend: 0, clicks: 0, conversions: 0 },
  );

  const clientName = campaigns[0]?.clientName ?? null;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Кампании</h1>
          <p className="page-sub">
            {filters.clientId && clientName ? `${clientName} · ` : ''}
            {rangeLength(filters)} дн.: {formatYmd(filters.from)} — {formatYmd(filters.to)} (МСК)
          </p>
        </div>
        {filters.clientId ? (
          <Link
            className="link-reset"
            href={withFilters('/campaigns', filters, { clientId: null })}
          >
            Показать всех клиентов
          </Link>
        ) : null}
      </div>

      <FilterBar
        action="/campaigns"
        filters={filters}
        fields={['provider', 'status', 'clientStatus']}
      />

      <div className="tiles">
        <StatTile label="Расход за период" value={formatMoney(totals.spend)} />
        <StatTile label="Клики" value={formatInteger(totals.clicks)} />
        <StatTile label="Конверсии" value={formatInteger(totals.conversions)} />
        <StatTile
          label="CPA по всем кампаниям"
          value={formatMoneyPrecise(cpa(totals.spend, totals.conversions))}
          hint="расход ÷ конверсии за период"
        />
      </div>

      <section className="card">
        {campaigns.length === 0 ? (
          <EmptyState>Кампаний под этот фильтр нет.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Кампания</th>
                  <th scope="col">Канал</th>
                  <th scope="col">Статус</th>
                  <th scope="col" className="num">
                    Дневной бюджет
                  </th>
                  <th scope="col" className="num">
                    Расход
                  </th>
                  <th scope="col" className="num">
                    Клики
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
                {campaigns.map((campaign) => {
                  const deviation = cpaDeviation(campaign.totals.cpa, campaign.targetCpa);
                  return (
                    <tr key={campaign.id}>
                      <td className="cell-wide">
                        <Link className="cell-strong" href={`/campaigns/${campaign.id}`}>
                          {campaign.name}
                        </Link>
                        <span className="cell-note">{campaign.clientName}</span>
                      </td>
                      <td>{providerLabel(campaign.provider)}</td>
                      <td>
                        <Badge tone={campaignStatusTone(campaign.status)}>
                          {campaignStatusLabel(campaign.status)}
                        </Badge>
                      </td>
                      <td className="num">{formatMoney(campaign.dailyBudget)}</td>
                      <td className="num">{formatMoney(campaign.totals.spend)}</td>
                      <td className="num">{formatInteger(campaign.totals.clicks)}</td>
                      <td className="num">{formatInteger(campaign.totals.conversions)}</td>
                      <td className="num">
                        {formatMoneyPrecise(campaign.totals.cpa)}
                        {campaign.targetCpa !== null ? (
                          <span className="cell-note">
                            цель {formatMoneyPrecise(campaign.targetCpa)}
                            {deviation === null ? '' : ` · ${formatSignedPercent(deviation)}`}
                          </span>
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
