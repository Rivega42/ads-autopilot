import { Provider, type PrismaClient } from '@prisma/client';

import { parseCompleteBrief, type ClientBriefData } from '@/ai/onboarding/brief.schema.js';
import { loadPrompt } from '@/ai/prompt-loader.js';
import { splitBudget, totalDailyBudget, type BudgetPart } from '@/campaigns/budget.js';
import { resolveRegions } from '@/campaigns/geo.js';
import {
  DIRECT_MAX_ADS_PER_GROUP,
  DIRECT_MAX_KEYWORDS_PER_GROUP,
  DIRECT_MIN_BID_RUB,
  DIRECT_MIN_DAILY_BUDGET_RUB,
  DIRECT_TEXT_MAX,
  DIRECT_TITLE2_MAX,
  DIRECT_TITLE_MAX,
  fitAdText,
  isValidKeyword,
  normaliseKeyword,
} from '@/campaigns/limits.js';
import {
  adTextsDraftSchema,
  campaignPlanSchema,
  structureDraftSchema,
  type AdTextsDraft,
  type CampaignPlacement,
  type CampaignPlan,
  type PlannedAd,
  type PlannedAdGroup,
  type PlannedCampaign,
  type StructureDraft,
} from '@/campaigns/plan.schema.js';
import { savePlan, type PlanStore } from '@/campaigns/store.js';
import { runAgent, type AgentRun, type RunAgentOptions } from '@/clients/llm/index.js';
import { prisma } from '@/db/prisma.js';
import { AppError } from '@/lib/errors.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'campaigns:planner' });

/**
 * AI-Стратег (TZ §13.2): бриф → план кампании.
 *
 * Разделение труда жёсткое и намеренное:
 *  • модель отвечает за смысл — разбивку спроса, фразы, тексты;
 *  • код отвечает за деньги и лимиты — бюджеты, ставки, длины строк, регионы.
 *
 * Всё, что модель вернёт про цифры, игнорируется: «60% на поиск» — это текст,
 * а `splitBudget` — это рубли, которые спишутся завтра.
 */

export const STRUCTURE_AGENT = 'campaign-strategist';
export const TEXTS_AGENT = 'campaign-copywriter';

/** Доля канала в общем бюджете, когда каналов несколько. Нормируется по факту. */
const CHANNEL_WEIGHTS: Readonly<Partial<Record<Provider, number>>> = {
  [Provider.YANDEX_DIRECT]: 0.75,
  [Provider.VK_ADS]: 0.25,
};

/** Поиск против сетей внутри одного кабинета Директа. */
const PLACEMENT_WEIGHTS: Readonly<Record<CampaignPlacement, number>> = {
  search: 0.7,
  network: 0.3,
};

/**
 * Стартовая ставка = целевой CPA × ожидаемая конверсия клика в заявку.
 *
 * 5% — осознанно пессимистичная оценка для кампании без истории: занижённая ставка
 * стоит показов, завышенная — денег. Как только накопится статистика, ставку двигает
 * оптимизатор, а не эта константа.
 */
const EXPECTED_CLICK_TO_LEAD_RATE = 0.05;

/** В сетях клик дешевле и хуже конвертится — стартуем ниже, чем на поиске. */
const NETWORK_BID_RATIO = 0.5;

const ADS_PER_GROUP = 3;

/** Сколько раз просим модель переписать не влезшие тексты, прежде чем обрезать сами. */
const TEXT_REGENERATION_ATTEMPTS = 1;

export type PlannerStore = Pick<PrismaClient, 'clientBrief'> & PlanStore;

export type RunStructureAgent = (
  opts: RunAgentOptions<StructureDraft>,
) => Promise<AgentRun<StructureDraft>>;

export type RunTextsAgent = (
  opts: RunAgentOptions<AdTextsDraft>,
) => Promise<AgentRun<AdTextsDraft>>;

export interface PlanCampaignsOptions {
  /** Каналы плана. По умолчанию — только Директ: только для него есть создание. */
  channels?: Provider[];
  /** false — план не сохраняется и `id` остаётся null (CLI-просмотр). */
  persist?: boolean;
  db?: PlannerStore;
  runStructure?: RunStructureAgent;
  runTexts?: RunTextsAgent;
  now?: () => Date;
}

/**
 * Бриф не собран — планировать нечего.
 *
 * Отдельная ошибка, а не «подставим значения по умолчанию»: целевой CPA, которого
 * клиент не называл, завтра станет ставкой. Пустое поле стоит одного вопроса,
 * выдуманное — реальных денег.
 */
export class IncompleteBriefError extends AppError {
  constructor(clientId: string, issues: string[]) {
    super(`Brief for client ${clientId} is not complete`, {
      code: 'BRIEF_INCOMPLETE',
      context: { clientId, issues },
    });
  }
}

export class EmptyPlanError extends AppError {
  constructor(clientId: string, reason: string) {
    super(`Cannot build a campaign plan for client ${clientId}: ${reason}`, {
      code: 'CAMPAIGN_PLAN_EMPTY',
      context: { clientId, reason },
    });
  }
}

export async function planCampaigns(
  clientId: string,
  opts: PlanCampaignsOptions = {},
): Promise<CampaignPlan> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? ((): Date => new Date());
  const channels = opts.channels ?? [Provider.YANDEX_DIRECT];

  const brief = await loadBrief(db, clientId);
  const warnings: string[] = [];
  const prompts: string[] = [];

  const budgets = planBudgets(brief, channels, warnings);
  if (budgets.length === 0) {
    throw new EmptyPlanError(
      clientId,
      `дневного бюджета ${brief.dailyBudgetRub} ₽ не хватает даже на одну кампанию ` +
        `(минимум ${DIRECT_MIN_DAILY_BUDGET_RUB} ₽)`,
    );
  }

  const geo = resolveRegions(brief.geo, brief.negativeCities);
  if (geo.target.unresolved.length > 0) {
    warnings.push(
      `Не распознаны города показа: ${geo.target.unresolved.join(', ')}. ` +
        'Таргетинг выставлен по остальным — проверьте перед запуском.',
    );
  }
  if (geo.target.fallback) {
    warnings.push('Ни один город из брифа не распознан — таргетинг выставлен на всю Россию.');
  }
  if (geo.excluded.unresolved.length > 0) {
    warnings.push(`Не распознаны минус-города: ${geo.excluded.unresolved.join(', ')}.`);
  }

  const structure = await generateStructure(clientId, brief, opts, prompts);
  const groups = buildGroups(structure, geo, warnings);
  if (groups.length === 0) {
    throw new EmptyPlanError(clientId, 'после проверки лимитов не осталось ни одной группы');
  }

  const texts = await generateTexts(clientId, brief, structure, groups, opts, prompts, warnings);
  if (texts.size === 0) {
    throw new EmptyPlanError(clientId, 'модель не вернула ни одного текста объявления');
  }

  const campaigns: PlannedCampaign[] = budgets.map((budget) =>
    buildCampaign(brief, structure, groups, texts, budget),
  );

  const plan = campaignPlanSchema.parse({
    id: null,
    clientId,
    createdAt: now().toISOString(),
    totalDailyBudgetRub: budgets.reduce((acc, b) => acc + b.dailyBudgetRub, 0),
    summary: structure.summary,
    campaigns,
    warnings,
    prompts,
  });

  log.info(
    {
      clientId,
      campaigns: plan.campaigns.length,
      groups: groups.length,
      budget: plan.totalDailyBudgetRub,
      warnings: warnings.length,
    },
    'campaign plan built',
  );

  if (opts.persist === false) return plan;
  return savePlan(db, plan);
}

// ── Бриф ─────────────────────────────────────────────────────────────────────

async function loadBrief(
  db: Pick<PrismaClient, 'clientBrief'>,
  clientId: string,
): Promise<ClientBriefData> {
  const row = await db.clientBrief.findUnique({
    where: { clientId },
    select: { data: true, status: true },
  });
  if (!row) throw new IncompleteBriefError(clientId, ['бриф не начат']);

  const parsed = parseCompleteBrief(row.data);
  if (!parsed.ok) throw new IncompleteBriefError(clientId, parsed.issues);
  return parsed.brief;
}

// ── Деньги ───────────────────────────────────────────────────────────────────

export interface CampaignBudget {
  channel: Provider;
  placement: CampaignPlacement;
  dailyBudgetRub: number;
}

/**
 * Двухуровневая раскладка: сначала между каналами, потом внутри канала между
 * поиском и сетями. Оба уровня — `splitBudget`, поэтому сумма всех кампаний
 * до копейки равна общему дневному бюджету.
 */
export function planBudgets(
  brief: ClientBriefData,
  channels: readonly Provider[],
  warnings: string[],
): CampaignBudget[] {
  const total = totalDailyBudget(brief.dailyBudgetRub, brief.budgetScope, channels.length);
  const parts: BudgetPart[] = channels.map((channel) => ({
    key: channel,
    weight: CHANNEL_WEIGHTS[channel] ?? 1,
  }));

  const byChannel = splitBudget(total, parts, { minRub: DIRECT_MIN_DAILY_BUDGET_RUB });
  for (const drop of byChannel.dropped) {
    warnings.push(`Канал ${drop.key} исключён из плана: ${drop.reason}.`);
  }

  const budgets: CampaignBudget[] = [];
  for (const allocation of byChannel.allocations) {
    const channel = allocation.key as Provider;
    const placements: BudgetPart[] = (['search', 'network'] as const).map((placement) => ({
      key: placement,
      weight: PLACEMENT_WEIGHTS[placement],
    }));

    const split = splitBudget(allocation.amountRub, placements, {
      minRub: DIRECT_MIN_DAILY_BUDGET_RUB,
    });
    for (const drop of split.dropped) {
      warnings.push(
        `${channel}: кампания «${placementLabel(drop.key as CampaignPlacement)}» не создаётся — ` +
          `${drop.reason}.`,
      );
    }
    for (const part of split.allocations) {
      budgets.push({
        channel,
        placement: part.key as CampaignPlacement,
        dailyBudgetRub: part.amountRub,
      });
    }
  }

  return budgets;
}

function placementLabel(placement: CampaignPlacement): string {
  return placement === 'search' ? 'Поиск' : 'РСЯ';
}

/** Ставка считается из целевого CPA, а не берётся у модели: это деньги. */
export function startingBid(targetCpaRub: number, placement: CampaignPlacement): number {
  const base = targetCpaRub * EXPECTED_CLICK_TO_LEAD_RATE;
  const adjusted = placement === 'network' ? base * NETWORK_BID_RATIO : base;
  return Math.max(DIRECT_MIN_BID_RUB, Math.round(adjusted * 100) / 100);
}

// ── Структура ────────────────────────────────────────────────────────────────

async function generateStructure(
  clientId: string,
  brief: ClientBriefData,
  opts: PlanCampaignsOptions,
  prompts: string[],
): Promise<StructureDraft> {
  const prompt = loadPrompt('campaign-structure', {
    brief: JSON.stringify(brief, null, 2),
    maxGroups: 8,
    maxKeywordsPerGroup: DIRECT_MAX_KEYWORDS_PER_GROUP,
  });
  prompts.push(`campaign-structure@${prompt.version}`);

  const run = await (opts.runStructure ?? runAgent)({
    agent: STRUCTURE_AGENT,
    task: 'strategy.plan',
    clientId,
    system: prompt.text,
    messages: 'Собери структуру кампании по брифу.',
    schema: structureDraftSchema,
    schemaName: 'campaign.structure',
  });

  return run.data;
}

interface GroupSkeleton {
  name: string;
  intent: string;
  keywords: string[];
  negativeKeywords: string[];
  regionIds: number[];
}

/** Фильтрация и дедупликация фраз. Всё, что Директ не примет, отсеивается здесь. */
function buildGroups(
  structure: StructureDraft,
  geo: ReturnType<typeof resolveRegions>,
  warnings: string[],
): GroupSkeleton[] {
  // Минус-города в Директе задаются отрицательными номерами в том же RegionIds.
  const regionIds = [...geo.target.regionIds, ...geo.excluded.regionIds.map((id) => -id)];

  const seen = new Set<string>();
  const groups: GroupSkeleton[] = [];
  let dropped = 0;

  for (const group of structure.groups) {
    const keywords: string[] = [];
    for (const phrase of group.keywords) {
      const key = normaliseKeyword(phrase);
      if (key === '' || seen.has(key)) continue;
      if (!isValidKeyword(phrase)) {
        dropped += 1;
        continue;
      }
      seen.add(key);
      keywords.push(phrase.trim());
      if (keywords.length >= DIRECT_MAX_KEYWORDS_PER_GROUP) break;
    }

    if (keywords.length === 0) {
      warnings.push(`Группа «${group.name}» пропущена: не осталось ни одной валидной фразы.`);
      continue;
    }

    groups.push({
      name: group.name,
      intent: group.intent,
      keywords,
      negativeKeywords: dedupe(group.negativeKeywords ?? []),
      regionIds,
    });
  }

  if (dropped > 0) {
    warnings.push(`Отброшено фраз, не проходящих лимиты Директа: ${dropped}.`);
  }
  return groups;
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = normaliseKeyword(value);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(value.trim());
  }
  return out;
}

// ── Тексты ───────────────────────────────────────────────────────────────────

type TextsByGroup = Map<string, PlannedAd[]>;

interface PendingGroup {
  group: GroupSkeleton;
  note: string;
  /** Сколько полей обрезано в уже сохранённом варианте. 0 — сохранённого нет. */
  truncated: number;
}

/**
 * Тексты объявлений с проверкой лимитов.
 *
 * Порядок именно такой: сначала просим модель переписать то, что не влезло
 * (она сохранит смысл), и только если и вторая попытка длиннее лимита — режем сами.
 * Отправить непроверенный текст нельзя ни при каком исходе: отказ операции стоит
 * 20 баллов квоты, а объявления в кампании при этом не будет.
 */
async function generateTexts(
  clientId: string,
  brief: ClientBriefData,
  structure: StructureDraft,
  groups: readonly GroupSkeleton[],
  opts: PlanCampaignsOptions,
  prompts: string[],
  warnings: string[],
): Promise<TextsByGroup> {
  const run = opts.runTexts ?? runAgent;
  const result: TextsByGroup = new Map();
  let pending: PendingGroup[] = groups.map((g) => ({ group: g, note: '', truncated: 0 }));
  let truncatedTotal = 0;

  for (let attempt = 0; attempt <= TEXT_REGENERATION_ATTEMPTS; attempt += 1) {
    if (pending.length === 0) break;

    const prompt = loadPrompt('campaign-texts', {
      brief: JSON.stringify(brief, null, 2),
      summary: structure.summary,
      groups: formatGroupsForPrompt(pending),
      titleMax: DIRECT_TITLE_MAX,
      title2Max: DIRECT_TITLE2_MAX,
      textMax: DIRECT_TEXT_MAX,
      adsPerGroup: ADS_PER_GROUP,
    });
    if (attempt === 0) prompts.push(`campaign-texts@${prompt.version}`);

    const draft = await run({
      agent: TEXTS_AGENT,
      task: 'creatives.texts',
      clientId,
      system: prompt.text,
      messages: 'Напиши тексты объявлений для перечисленных групп.',
      schema: adTextsDraftSchema,
      schemaName: 'campaign.texts',
      // Вторая попытка с тем же кешем вернула бы тот же слишком длинный текст.
      cache: attempt === 0,
    });

    const byName = new Map(draft.data.groups.map((g) => [g.name.trim(), g.ads]));
    const retry: PendingGroup[] = [];

    for (const item of pending) {
      const ads = byName.get(item.group.name.trim());
      if (!ads || ads.length === 0) {
        // Уже сохранённый (пусть и обрезанный) вариант несём с собой: если модель
        // так и не перепишет тексты, он останется в плане, а не будет выброшен.
        retry.push({
          group: item.group,
          note: 'в прошлом ответе для этой группы не было текстов',
          truncated: item.truncated,
        });
        continue;
      }

      const overflow: string[] = [];
      const fitted: PlannedAd[] = [];
      for (const ad of ads.slice(0, DIRECT_MAX_ADS_PER_GROUP)) {
        const result_ = fitAdText(ad);
        for (const violation of result_.truncated) {
          overflow.push(`${violation.field}: ${violation.actual} из ${violation.limit}`);
        }
        const planned: PlannedAd = { title: result_.ad.title, text: result_.ad.text };
        if (result_.ad.title2) planned.title2 = result_.ad.title2;
        if (brief.landingUrl) planned.href = brief.landingUrl;
        fitted.push(planned);
      }

      result.set(item.group.name, fitted);

      if (overflow.length > 0 && attempt < TEXT_REGENERATION_ATTEMPTS) {
        retry.push({
          group: item.group,
          note: `предыдущий вариант не уложился в лимиты (${overflow.join('; ')})`,
          truncated: overflow.length,
        });
      } else if (overflow.length > 0) {
        truncatedTotal += overflow.length;
      }
    }

    pending = retry;
  }

  for (const item of pending) {
    if (result.has(item.group.name)) {
      // Модель не переписала тексты, но обрезанный вариант прошлой попытки валиден
      // и уже уложен в лимиты. Выбрасывать его — терять оплаченную работу зря.
      truncatedTotal += item.truncated;
      continue;
    }
    // Текстов не было ни разу. Группа без объявлений нежизнеспособна.
    warnings.push(`Группа «${item.group.name}» пропущена: модель не вернула тексты объявлений.`);
  }

  if (truncatedTotal > 0) {
    warnings.push(
      `Обрезано полей объявлений под лимиты Директа: ${truncatedTotal}. ` +
        'Проверьте формулировки в карточке перед запуском.',
    );
  }

  return result;
}

function formatGroupsForPrompt(items: readonly { group: GroupSkeleton; note: string }[]): string {
  return items
    .map(({ group, note }) => {
      const lines = [
        `### ${group.name}`,
        `Смысл группы: ${group.intent}`,
        `Ключевые фразы: ${group.keywords.slice(0, 10).join(', ')}`,
      ];
      if (note) lines.push(`Важно: ${note}. Уложись в лимиты.`);
      return lines.join('\n');
    })
    .join('\n\n');
}

// ── Сборка кампании ──────────────────────────────────────────────────────────

/** Стратегии Директа. Пара «поиск + сети» задаётся всегда: API заменяет её целиком. */
export function biddingStrategyFor(placement: CampaignPlacement): PlannedCampaign['strategy'] {
  if (placement === 'search') {
    return {
      search: { type: 'HIGHEST_POSITION' },
      network: { type: 'SERVING_OFF' },
    };
  }
  return {
    search: { type: 'SERVING_OFF' },
    network: { type: 'MAXIMUM_COVERAGE' },
  };
}

function buildCampaign(
  brief: ClientBriefData,
  structure: StructureDraft,
  groups: readonly GroupSkeleton[],
  texts: TextsByGroup,
  budget: CampaignBudget,
): PlannedCampaign {
  const bid = startingBid(brief.targetCpaRub, budget.placement);

  const adGroups: PlannedAdGroup[] = [];
  for (const group of groups) {
    const ads = texts.get(group.name);
    if (!ads || ads.length === 0) continue;
    adGroups.push({
      name: group.name,
      regionIds: group.regionIds,
      keywords: group.keywords.map((phrase) => ({ phrase, bidRub: bid })),
      negativeKeywords: group.negativeKeywords,
      ads,
    });
  }

  return {
    channel: budget.channel,
    placement: budget.placement,
    name: campaignName(brief, budget.placement),
    dailyBudgetRub: budget.dailyBudgetRub,
    targetCpaRub: brief.targetCpaRub,
    strategy: biddingStrategyFor(budget.placement),
    negativeKeywords: dedupe(structure.campaignNegativeKeywords ?? []),
    adGroups,
  };
}

function campaignName(brief: ClientBriefData, placement: CampaignPlacement): string {
  const product = brief.product.trim().replace(/\s+/gu, ' ').slice(0, 80);
  return `${placementLabel(placement)} — ${product}`;
}
