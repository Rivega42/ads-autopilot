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
import { comparableCpa } from '../../lib/attribution';
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
import { cpaDeviation } from '../../lib/metrics';
import { listCampaignsView } from '../../lib/queries';

export const dynamic = 'force-dynamic';

export default async function CampaignsPage({
  searchParams = {},
}: {
  readonly searchParams?: SearchParams;
}) {
  const filters = parseFilters(searchParams);
  const view = await listCampaignsView(filters);
  const campaigns = view.rows;

  // Плитки — итог по всему набору под фильтром: `view.rows` обрезаны потолком
  // выборки, и их свёртка была бы подписана как итог за период, будучи суммой
  // первых двухсот строк.
  const totals = view.totals;
  const attribution = totals.attribution;
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

      {view.truncated ? (
        <section className="notice notice-info" role="note">
          <strong>
            Показаны первые {formatInteger(campaigns.length)} кампаний из{' '}
            {formatInteger(view.total)}
          </strong>
          <p className="notice-text">
            Список обрезан потолком витрины — остальные строки не пропали, их просто здесь нет.
            Итоги в плитках ниже посчитаны по всем {formatInteger(view.total)} кампаниям, а не по
            показанным. Сузьте фильтр или период, чтобы увидеть строки целиком.
          </p>
        </section>
      ) : null}

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
          value={formatMoneyPrecise(comparableCpa(totals.cpa, attribution))}
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
