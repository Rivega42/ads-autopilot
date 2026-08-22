import Link from 'next/link';
import { notFound } from 'next/navigation';

import { AdGroupTable } from '../../../components/ad-group-table';
import {
  AttributionNote,
  MixedAttributionNotice,
  MixedCpaNote,
} from '../../../components/attribution';
import { Badge } from '../../../components/badge';
import { ChangeLogTable } from '../../../components/change-log-table';
import { DailyTable } from '../../../components/daily-table';
import { FilterBar } from '../../../components/filter-bar';
import type { ChartPoint } from '../../../components/metric-chart';
import { MetricChart } from '../../../components/metric-chart';
import { StatTile } from '../../../components/stat-tile';
import {
  attributionLabel,
  comparableCpa,
  countsOfSources,
  summarizeAttribution,
} from '../../../lib/attribution';
import { formatMskDateTime, formatYmd, formatYmdShort } from '../../../lib/dates';
import type { SearchParams } from '../../../lib/filters';
import { parseFilters, rangeLength, withFilters } from '../../../lib/filters';
import {
  formatBidRange,
  formatCompact,
  formatInteger,
  formatMoney,
  formatMoneyPrecise,
  formatPercent,
  formatSignedPercent,
} from '../../../lib/format';
import {
  campaignStatusLabel,
  campaignStatusTone,
  handoverModeLabel,
  providerLabel,
} from '../../../lib/labels';
import { cpa, cpaDeviation, ctr } from '../../../lib/metrics';
import type { AdGroupBidSummary, DailyMetrics } from '../../../lib/queries';
import {
  getCampaign,
  getCampaignDaily,
  listAdGroupsView,
  listChangesView,
} from '../../../lib/queries';

export const dynamic = 'force-dynamic';

function toPoints(
  rows: readonly DailyMetrics[],
  select: (row: DailyMetrics) => number | null,
): ChartPoint[] {
  return rows.map((row) => ({
    label: formatYmdShort(row.date),
    title: formatYmd(row.date),
    value: select(row),
  }));
}

/**
 * Подпись под плиткой ставки: сколько групп ею управляется.
 *
 * Число «у скольких задана» обязано стоять рядом с самой ставкой: диапазон
 * «0,00 ₽ — 99,99 ₽» без него не отличить от кампании, где ставку задали одной
 * группе из двухсот, а остальные отданы автостратегии.
 */
function bidHint(bids: AdGroupBidSummary): string {
  if (bids.groups === 0) return 'групп объявлений нет';
  if (bids.withBid === 0) return `цену назначает площадка · групп: ${formatInteger(bids.groups)}`;
  return `задана у ${formatInteger(bids.withBid)} из ${formatInteger(bids.groups)} групп`;
}

export default async function CampaignPage({
  params,
  searchParams = {},
}: {
  readonly params: { readonly id: string };
  readonly searchParams?: SearchParams;
}) {
  const filters = parseFilters(searchParams);
  const campaign = await getCampaign(params.id);
  if (!campaign) notFound();

  const [daily, changeView, groupView] = await Promise.all([
    getCampaignDaily(campaign.id, filters.from, filters.to),
    listChangesView(filters, { campaignId: campaign.id, limit: 50 }),
    listAdGroupsView(campaign.id),
  ]);
  const changes = changeView.rows;

  const totals = daily.reduce(
    (accumulator, row) => ({
      impressions: accumulator.impressions + row.impressions,
      clicks: accumulator.clicks + row.clicks,
      spend: accumulator.spend + row.spend,
      conversions: accumulator.conversions + row.conversions,
    }),
    { impressions: 0, clicks: 0, spend: 0, conversions: 0 },
  );

  // Дни без строк в статистике источника не имеют — они не «третья модель»,
  // а просто отсутствие данных, и смешением их считать нельзя.
  const attribution = summarizeAttribution(
    countsOfSources(daily.map((row) => row.conversionSource)),
  );
  const periodCpa = comparableCpa(cpa(totals.spend, totals.conversions), attribution);
  const deviation = cpaDeviation(periodCpa, campaign.targetCpa);
  const days = rangeLength(filters);

  return (
    <>
      <div className="breadcrumbs">
        <Link href="/clients">Клиенты</Link>
        <span>/</span>
        <Link href={withFilters('/campaigns', filters, { clientId: campaign.clientId })}>
          {campaign.clientName}
        </Link>
        <span>/</span>
        <span className="muted">{campaign.name}</span>
      </div>

      <div className="page-head">
        <div>
          <h1>{campaign.name}</h1>
          <p className="page-sub">
            {providerLabel(campaign.provider)} · ID площадки {campaign.externalId} · {days} дн.:{' '}
            {formatYmd(filters.from)} — {formatYmd(filters.to)} (МСК)
          </p>
        </div>
        <div className="badges">
          <Badge tone={campaignStatusTone(campaign.status)}>
            {campaignStatusLabel(campaign.status)}
          </Badge>
          <Badge>{handoverModeLabel(campaign.handoverMode)}</Badge>
        </div>
      </div>

      <FilterBar action={`/campaigns/${campaign.id}`} filters={filters} fields={[]} />

      {attribution.mixed ? (
        <MixedAttributionNotice scope="За выбранный период часть дней посчитала Метрика, часть — рекламный кабинет." />
      ) : null}

      <div className="tiles">
        <StatTile
          hero
          label={`CPA за ${days} дн.`}
          value={formatMoneyPrecise(periodCpa)}
          hint={
            attribution.mixed ? (
              <MixedCpaNote />
            ) : campaign.targetCpa === null ? (
              'цель не задана'
            ) : (
              `цель ${formatMoneyPrecise(campaign.targetCpa)}${
                deviation === null ? '' : ` · ${formatSignedPercent(deviation)}`
              }`
            )
          }
        />
        <StatTile label="Расход" value={formatMoney(totals.spend)} />
        <StatTile
          label="Конверсии"
          value={formatInteger(totals.conversions)}
          hint={<AttributionNote summary={attribution} prefix="источник" />}
        />
        <StatTile label="Клики" value={formatInteger(totals.clicks)} />
        <StatTile label="Показы" value={formatInteger(totals.impressions)} />
        <StatTile label="CTR" value={formatPercent(ctr(totals.clicks, totals.impressions))} />
        <StatTile
          label="Дневной бюджет"
          value={formatMoney(campaign.dailyBudget)}
          hint={campaign.strategy ?? 'стратегия не задана'}
        />
        <StatTile
          label="Ставка группы"
          value={formatBidRange(groupView.bids)}
          hint={bidHint(groupView.bids)}
        />
      </div>

      <section className="stack">
        <div className="charts">
          <MetricChart
            title="Показы"
            summary={formatInteger(totals.impressions)}
            points={toPoints(daily, (row) => row.impressions)}
            formatValue={formatCompact}
            integer
          />
          <MetricChart
            title="Клики"
            summary={formatInteger(totals.clicks)}
            points={toPoints(daily, (row) => row.clicks)}
            formatValue={formatCompact}
            integer
          />
          <MetricChart
            title="Расход, ₽"
            summary={formatMoney(totals.spend)}
            points={toPoints(daily, (row) => row.spend)}
            formatValue={formatMoney}
          />
          <MetricChart
            title={`Конверсии · ${attributionLabel(attribution)}`}
            summary={formatInteger(totals.conversions)}
            points={toPoints(daily, (row) => row.conversions)}
            kind="column"
            formatValue={formatInteger}
            integer
          />
          <MetricChart
            title="CPA, ₽"
            summary={formatMoneyPrecise(periodCpa)}
            points={toPoints(daily, (row) => row.cpa)}
            formatValue={formatMoneyPrecise}
            reference={
              campaign.targetCpa === null
                ? null
                : {
                    value: campaign.targetCpa,
                    label: `цель ${formatMoneyPrecise(campaign.targetCpa)}`,
                  }
            }
          />
        </div>

        <div className="card">
          <div className="card-head">
            <h2>Метрики по дням</h2>
            <span className="muted">
              дни без строк в статистике показаны нулями; CPA без конверсий — прочерком; источник
              конверсий — в последней колонке
            </span>
          </div>
          <DailyTable rows={daily} />
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>
            Группы объявлений
            {groupView.truncated ? (
              // Плитка со ставкой считается по всему набору, а список обрезан
              // потолком витрины: без этой строки «максимум 500 ₽» рядом со
              // списком, где пятисот нет, читается как ошибка витрины.
              <span className="muted">
                {' '}
                — первые {formatInteger(groupView.rows.length)} из {formatInteger(groupView.total)}
              </span>
            ) : null}
          </h2>
          <span className="muted">
            {campaign.provider === 'VK_ADS'
              ? 'у VK ключевых слов нет: ставка группы — единственный рычаг цены'
              : 'пустая ставка означает, что цену назначает площадка'}
          </span>
        </div>
        <AdGroupTable rows={groupView.rows} />
      </section>

      <section className="card">
        <div className="card-head">
          <h2>
            История изменений
            {changeView.truncated ? (
              // Панель карточки показывает последние 50 — здесь это не дефект, а
              // размер панели. Дефектом было бы промолчать про остальные.
              <span className="muted">
                {' '}
                — последние {formatInteger(changes.length)} из {formatInteger(changeView.total)}
              </span>
            ) : null}
          </h2>
          <Link className="link-reset" href={withFilters('/changes', filters)}>
            Все изменения
          </Link>
        </div>
        <ChangeLogTable rows={changes} showCampaign={false} />
      </section>

      {campaign.importedAt ? (
        <p className="muted">
          Кампания импортирована {formatMskDateTime(new Date(campaign.importedAt))} · групп:{' '}
          {formatInteger(campaign.adGroupCount)}
        </p>
      ) : null}
    </>
  );
}
