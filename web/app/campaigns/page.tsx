import Link from 'next/link';

import {
  AttributionNote,
  MixedAttributionNotice,
  MixedCpaNote,
} from '../../components/attribution';
import { Badge } from '../../components/badge';
import { EmptyState } from '../../components/empty-state';
import { FilterBar } from '../../components/filter-bar';
import { StatTile } from '../../components/stat-tile';
import type { ConversionSourceCounts } from '../../lib/attribution';
import { addCounts, comparableCpa, emptyCounts, summarizeAttribution } from '../../lib/attribution';
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

  const totals = campaigns.reduce<{
    spend: number;
    clicks: number;
    conversions: number;
    counts: ConversionSourceCounts;
  }>(
    (accumulator, campaign) => ({
      spend: accumulator.spend + campaign.totals.spend,
      clicks: accumulator.clicks + campaign.totals.clicks,
      conversions: accumulator.conversions + campaign.totals.conversions,
      counts: addCounts(accumulator.counts, campaign.totals.attribution.counts),
    }),
    { spend: 0, clicks: 0, conversions: 0, counts: emptyCounts() },
  );

  const attribution = summarizeAttribution(totals.counts);
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

      {attribution.mixed ? (
        <MixedAttributionNotice scope="В выборку попали кампании с разными источниками конверсий." />
      ) : null}

      <div className="tiles">
        <StatTile label="Расход за период" value={formatMoney(totals.spend)} />
        <StatTile label="Клики" value={formatInteger(totals.clicks)} />
        <StatTile
          label="Конверсии"
          value={formatInteger(totals.conversions)}
          hint={<AttributionNote summary={attribution} prefix="источник" />}
        />
        <StatTile
          label="CPA по всем кампаниям"
          value={formatMoneyPrecise(
            comparableCpa(cpa(totals.spend, totals.conversions), attribution),
          )}
          hint={attribution.mixed ? <MixedCpaNote /> : 'расход ÷ конверсии за период'}
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
                  // Отклонение от цели считается от того же числа, что показано:
                  // при смешанной атрибуции сравнивать с целью нечего.
                  const comparable = comparableCpa(
                    campaign.totals.cpa,
                    campaign.totals.attribution,
                  );
                  const deviation = cpaDeviation(comparable, campaign.targetCpa);
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
                      <td className="num">
                        {formatInteger(campaign.totals.conversions)}
                        <AttributionNote summary={campaign.totals.attribution} prefix="источник" />
                      </td>
                      <td className="num">
                        {formatMoneyPrecise(comparable)}
                        {campaign.totals.attribution.mixed ? <MixedCpaNote /> : null}
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
