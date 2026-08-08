import { formatMoney, formatPctChange, formatPctMagnitude, truncate } from '@/reporter/format.js';
import { divideOrNull, meanOrNull, pctChangeOrNull, stdDevOrNull } from '@/reporter/math.js';
import { indexByCampaign, type DailyPoint, type PeriodMetrics } from '@/reporter/metrics.js';

/**
 * Поиск аномалий по цифрам — до обращения к модели.
 *
 * Это принципиально: LLM в сырой таблице «найдёт» тренд там, где его нет, и
 * опишет его уверенным тоном. Поэтому арифметику — что выросло, что просело,
 * насколько — делает код, а модель получает готовый список фактов и объясняет
 * их словами. См. `weekly.ts`.
 */

export type AnomalyKind =
  | 'spend_spike'
  | 'spend_collapse'
  | 'leads_spike'
  | 'leads_collapse'
  | 'cpa_spike'
  | 'no_leads'
  | 'ctr_collapse';

export type AnomalySeverity = 'warning' | 'critical';

export interface Anomaly {
  kind: AnomalyKind;
  severity: AnomalySeverity;
  /** `null` — аномалия по клиенту целиком. */
  campaignId: string | null;
  campaignName: string | null;
  /** Готовая формулировка на русском: и в отчёт, и в промпт уходит она же. */
  text: string;
  value: number;
  baseline: number;
  changePct: number | null;
}

export interface AnomalyThresholds {
  /** Рост, начиная с которого это всплеск. */
  spikePct: number;
  /** Падение, начиная с которого это провал. */
  collapsePct: number;
  /** Ниже этого расхода за период кампанию не разбираем: проценты на копейках врут. */
  minSpend: number;
  /** Столько показов нужно, чтобы говорить о падении CTR. */
  minImpressions: number;
  /** Во сколько раз CPA должен превысить целевой, чтобы это стало аномалией. */
  cpaOverTarget: number;
}

export const DEFAULT_THRESHOLDS: AnomalyThresholds = {
  spikePct: 50,
  collapsePct: 40,
  minSpend: 1_000,
  minImpressions: 500,
  cpaOverTarget: 1.5,
};

interface Scope {
  campaignId: string | null;
  campaignName: string | null;
}

const CLIENT_SCOPE: Scope = { campaignId: null, campaignName: null };

function label(scope: Scope): string {
  return scope.campaignName === null ? 'В целом' : `«${truncate(scope.campaignName, 40)}»`;
}

/**
 * Сравнение двух периодов: клиент целиком и каждая кампания в отдельности.
 *
 * Порог по расходу нужен, чтобы отчёт не состоял из «кампания потратила 12 ₽
 * вместо 4 ₽, рост 200%». Такие строки вытесняют настоящие проблемы.
 */
export function detectAnomalies(
  current: PeriodMetrics,
  previous: PeriodMetrics,
  thresholds: AnomalyThresholds = DEFAULT_THRESHOLDS,
): Anomaly[] {
  // Незагруженный период — не «нулевой»: любая аномалия по нему описывала бы
  // дырку в данных как поведение рекламы. Молчим и отдаём решение отчёту,
  // который скажет про отсутствие данных прямым текстом.
  if (!current.coverage.hasData) return [];
  // Сравнивать с неизмеренной базой тоже нельзя: «расход упал на 100%» здесь
  // значило бы «вчера мы ничего не загрузили», а прочитано будет как обвал.
  const comparable = previous.coverage.hasData;

  const found: Anomaly[] = [];
  const before = indexByCampaign(previous);

  collectScope(found, CLIENT_SCOPE, current.totals, previous.totals, thresholds, null, comparable);

  for (const campaign of current.campaigns) {
    const past = before.get(campaign.campaignId);
    if (!past) continue;
    collectScope(
      found,
      { campaignId: campaign.campaignId, campaignName: campaign.name },
      campaign,
      past,
      thresholds,
      campaign.targetCpa,
      comparable,
    );
  }

  return found.sort(bySeverityThenMoney);
}

interface ScopeMetrics {
  spend: number;
  conversions: number;
  impressions: number;
  clicks: number;
  cpa: number | null;
  ctr: number | null;
}

function collectScope(
  out: Anomaly[],
  scope: Scope,
  current: ScopeMetrics,
  previous: ScopeMetrics,
  thresholds: AnomalyThresholds,
  targetCpa: number | null,
  comparable: boolean,
): void {
  const material = current.spend >= thresholds.minSpend || previous.spend >= thresholds.minSpend;
  if (!material) return;

  const spendChange = comparable ? pctChangeOrNull(current.spend, previous.spend) : null;
  if (spendChange !== null && spendChange >= thresholds.spikePct) {
    out.push({
      kind: 'spend_spike',
      severity: spendChange >= thresholds.spikePct * 2 ? 'critical' : 'warning',
      ...scope,
      text: `${label(scope)}: расход вырос на ${formatPctMagnitude(spendChange)} — ${formatMoney(current.spend)} против ${formatMoney(previous.spend)}`,
      value: current.spend,
      baseline: previous.spend,
      changePct: spendChange,
    });
  }
  if (spendChange !== null && spendChange <= -thresholds.collapsePct) {
    out.push({
      kind: 'spend_collapse',
      severity: 'warning',
      ...scope,
      text: `${label(scope)}: расход упал на ${formatPctMagnitude(spendChange)} — ${formatMoney(current.spend)} против ${formatMoney(previous.spend)}`,
      value: current.spend,
      baseline: previous.spend,
      changePct: spendChange,
    });
  }

  const leadsChange = comparable
    ? pctChangeOrNull(current.conversions, previous.conversions)
    : null;
  if (leadsChange !== null && leadsChange >= thresholds.spikePct) {
    out.push({
      kind: 'leads_spike',
      severity: 'warning',
      ...scope,
      text: `${label(scope)}: лидов ${current.conversions} против ${previous.conversions} (${formatPctChange(leadsChange)})`,
      value: current.conversions,
      baseline: previous.conversions,
      changePct: leadsChange,
    });
  }
  if (leadsChange !== null && leadsChange <= -thresholds.collapsePct) {
    out.push({
      kind: 'leads_collapse',
      severity: 'critical',
      ...scope,
      text: `${label(scope)}: лидов ${current.conversions} против ${previous.conversions} (${formatPctChange(leadsChange)})`,
      value: current.conversions,
      baseline: previous.conversions,
      changePct: leadsChange,
    });
  }

  // Ноль конверсий при живом расходе процентом не описывается — это отдельный факт.
  if (current.conversions === 0 && current.spend >= thresholds.minSpend) {
    out.push({
      kind: 'no_leads',
      severity: 'critical',
      ...scope,
      text: `${label(scope)}: ${formatMoney(current.spend)} без единой конверсии`,
      value: 0,
      baseline: previous.conversions,
      changePct: null,
    });
  }

  if (current.cpa !== null && targetCpa !== null && targetCpa > 0) {
    const ratio = current.cpa / targetCpa;
    if (ratio >= thresholds.cpaOverTarget) {
      out.push({
        kind: 'cpa_spike',
        severity: ratio >= 3 ? 'critical' : 'warning',
        ...scope,
        text: `${label(scope)}: CPA ${formatMoney(current.cpa)} при целевом ${formatMoney(targetCpa)}`,
        value: current.cpa,
        baseline: targetCpa,
        changePct: pctChangeOrNull(current.cpa, targetCpa),
      });
    }
  }

  const ctrChange =
    comparable && current.ctr !== null && previous.ctr !== null
      ? pctChangeOrNull(current.ctr, previous.ctr)
      : null;
  if (
    ctrChange !== null &&
    ctrChange <= -thresholds.collapsePct &&
    current.impressions >= thresholds.minImpressions
  ) {
    out.push({
      kind: 'ctr_collapse',
      severity: 'warning',
      ...scope,
      text: `${label(scope)}: CTR просел на ${formatPctMagnitude(ctrChange)}`,
      value: current.ctr ?? 0,
      baseline: previous.ctr ?? 0,
      changePct: ctrChange,
    });
  }
}

const SEVERITY_ORDER: Record<AnomalySeverity, number> = { critical: 0, warning: 1 };

function bySeverityThenMoney(a: Anomaly, b: Anomaly): number {
  const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  if (bySeverity !== 0) return bySeverity;
  // Внутри одной серьёзности вперёд идёт то, где на кону больше денег.
  return Math.max(b.value, b.baseline) - Math.max(a.value, a.baseline);
}

export interface SpendOutlier {
  date: string;
  spend: number;
  baseline: number;
  /** Отклонение в сигмах. `null`, если истории мало или она идеально ровная. */
  zScore: number | null;
  changePct: number | null;
  direction: 'spike' | 'collapse';
}

export interface SpendOutlierOptions {
  /** Сколько сигм считать аномалией. */
  sigmas?: number;
  /** Во сколько раз расход должен отличаться от среднего, если история ровная. */
  ratio?: number;
  /** Ниже этой суммы день не разбираем. */
  minSpend?: number;
}

/**
 * Аномальный расход последнего дня против скользящей истории.
 *
 * Два критерия вместо одного: z-оценка ловит выброс на живом ряду, а кратность
 * среднему — случай, когда история идеально ровная (σ = 0) и любая z-оценка
 * обращается в бесконечность. Ряд короче трёх дней не разбираем вовсе: на двух
 * точках «среднее» — это вторая точка.
 *
 * Дни без строк в ряду не участвуют ни последним значением, ни базой: их ноль
 * означает «не загрузилось», и по нему поднялся бы алерт «расход почти
 * остановился» на кабинете, который на самом деле откручивался как обычно.
 */
export function detectSpendOutlier(
  series: readonly DailyPoint[],
  options: SpendOutlierOptions = {},
): SpendOutlier | null {
  const sigmas = options.sigmas ?? 2.5;
  const ratio = options.ratio ?? 2;
  const minSpend = options.minSpend ?? 1_000;

  const last = series[series.length - 1];
  if (!last || !last.hasRows) return null;

  const history = series
    .slice(0, -1)
    .filter((p) => p.hasRows)
    .map((p) => p.spend);
  if (history.length < 3) return null;

  const baseline = meanOrNull(history);
  if (baseline === null || baseline <= 0) return null;
  if (last.spend < minSpend && baseline < minSpend) return null;

  const deviation = stdDevOrNull(history);
  const zScore = deviation !== null && deviation > 0 ? (last.spend - baseline) / deviation : null;
  const times = divideOrNull(last.spend, baseline) ?? 1;

  const spike = (zScore !== null && zScore >= sigmas) || times >= ratio;
  const collapse = (zScore !== null && zScore <= -sigmas) || times <= 1 / ratio;
  if (!spike && !collapse) return null;

  return {
    date: last.date,
    spend: last.spend,
    baseline,
    zScore,
    changePct: pctChangeOrNull(last.spend, baseline),
    direction: spike ? 'spike' : 'collapse',
  };
}
