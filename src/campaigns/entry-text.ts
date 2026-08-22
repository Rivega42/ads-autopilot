import { ApprovalDecision, Provider } from '@prisma/client';

import { BRIEF_FIELD_LABELS } from '@/ai/onboarding/index.js';
import { formatAmount } from '@/approval/card.js';
import type { CampaignEntryBlock, CampaignEntryReady } from '@/campaigns/entry.js';
import { regionName } from '@/campaigns/geo.js';
import type { CampaignPlan, PlannedCampaign } from '@/campaigns/plan.schema.js';

/**
 * Как вход говорит с человеком.
 *
 * Отделено от разбора случаев намеренно: решение «можно ли запускать» принимается
 * один раз (`entry.ts`), а показывается двумя способами — подробно в CLI
 * и коротко в чате. Здесь только формулировки, ни одного условия про деньги.
 *
 * Требование ко всем текстам одно: человек должен понять, что произойдёт после
 * нажатия и что сделать, если не произойдёт. Кода ошибки для этого недостаточно.
 */

const CHANNEL_LABELS: Readonly<Partial<Record<Provider, string>>> = {
  [Provider.YANDEX_DIRECT]: 'Яндекс Директ',
  [Provider.VK_ADS]: 'VK Реклама',
};

/** Канал без подписи показываем кодом: выдумывать название площадки хуже, чем не переводить. */
function channelLabel(channel: Provider): string {
  return CHANNEL_LABELS[channel] ?? channel;
}

function placementLabel(placement: PlannedCampaign['placement']): string {
  return placement === 'search' ? 'Поиск' : 'РСЯ';
}

export function describeRegions(regionIds: readonly number[]): string {
  const positive = regionIds.filter((id) => id > 0).map(regionName);
  const negative = regionIds.filter((id) => id < 0).map((id) => regionName(-id));
  const head = positive.join(', ') || 'не задано';
  return negative.length > 0 ? `${head} (кроме: ${negative.join(', ')})` : head;
}

/**
 * Объяснение отказа — одним текстом, одинаковым в CLI и в чате.
 *
 * Техническую ошибку человек прочитать не сможет и починить тем более: во всех
 * случаях ниже виновата не система, а недостающий факт о клиенте, — значит и
 * сказать надо, какой именно факт и кто его добудет.
 */
export function renderEntryBlock(block: CampaignEntryBlock): string {
  switch (block.kind) {
    case 'client_unknown':
      return 'Не нашёл такого клиента в базе.';

    case 'client_inactive':
      return (
        `Клиент в статусе ${block.status}: запуск кампаний доступен только активным. ` +
        'Снять паузу может Роман.'
      );

    case 'no_credentials':
      return (
        `Нет доступа к кабинету: ${block.channels.map((c) => channelLabel(c)).join(', ')}. ` +
        'Токен подключает Роман — без него плану некуда уезжать.'
      );

    case 'brief_missing':
      return 'Брифа нет — сначала онбординг: /onboarding.';

    case 'brief_incomplete':
      return [
        'Бриф не закончен, плана из него не выйдет. Не хватает:',
        ...block.missing.map((field) => `  • ${BRIEF_FIELD_LABELS[field]}`),
        'Продолжить интервью: /onboarding.',
      ].join('\n');

    case 'brief_invalid':
      return [
        'Бриф не проходит проверку — по такому плану считать деньги нельзя:',
        ...block.issues.slice(0, 5).map((issue) => `  • ${issue}`),
        'Поправить можно через интервью: /onboarding.',
      ].join('\n');

    case 'landing_missing':
      return (
        'В брифе нет ссылки на сайт, и без неё плана не будет.\n' +
        'Причина: Яндекс Директ не принимает объявление, которому некуда вести — ' +
        'нужна хотя бы одна цель показа (ссылка, турбо-страница или визитка), ' +
        'а из них система умеет только ссылку.\n' +
        'Что делать: пришли ссылку на сайт или страницу услуги — ответом в интервью ' +
        '(/onboarding) или Роману, он допишет её в бриф. После этого запуск пройдёт.'
      );

    case 'budget_too_small':
      return [
        `Дневного бюджета ${formatAmount(block.dailyBudgetRub)} ₽ не хватает даже на одну ` +
          `кампанию: минимум Директа — ${formatAmount(block.minRub)} ₽/сут.`,
        ...block.notes.map((note) => `  • ${note}`),
      ].join('\n');

    case 'geo_contradiction':
      return (
        'Города показа и минус-города из брифа исключают друг друга — показывать негде.\n' +
        `Показ: ${block.geo.join(', ') || '—'}\n` +
        `Минус-города: ${block.negativeCities.join(', ') || '—'}\n` +
        'Поправить бриф: /onboarding.'
      );

    case 'awaiting_decision':
      return [
        'План уже собран и ждёт твоего решения — второй раз модель не зову ' +
          '(это лишние деньги) и вторую кампанию не создаю.',
        ...block.approvals.map(
          (a) =>
            `  • «${a.campaignName}» — ${formatAmount(a.dailyBudgetRub)} ₽/сут, ` +
            `${decisionLabel(a.decision)}`,
        ),
        'Реши по карточкам в чате: ✅ запустит, ❌ отменит.',
      ].join('\n');

    case 'attempt_unresolved':
      return [
        'Прошлая попытка создания не завершилась, и неизвестно, появилась ли кампания ' +
          'в кабинете. Повтор заблокирован ключом идемпотентности — это защита от ' +
          'второй кампании на те же деньги.',
        ...block.campaigns.map((name) => `  • ${name}`),
        `Нужен разбор вручную: проверить кабинет и план ${block.planId}.`,
      ].join('\n');

    case 'already_created':
      return [
        'По последнему плану кампании уже созданы:',
        ...block.campaigns.map((c) => `  • «${c.name}» — id в кабинете ${c.externalId}`),
        'Повторный запуск ничего не продублирует, но и нового не создаст. ' +
          'Нужна ещё одна кампания — это отдельное решение и отдельные деньги.',
      ].join('\n');

    default: {
      const exhaustive: never = block;
      return exhaustive;
    }
  }
}

function decisionLabel(decision: ApprovalDecision): string {
  switch (decision) {
    case ApprovalDecision.PENDING:
      return 'ждёт нажатия';
    case ApprovalDecision.APPROVED:
      return 'одобрена, применяется';
    case ApprovalDecision.APPLYING:
      return 'применяется прямо сейчас';
    default:
      return decision;
  }
}

/**
 * Что известно про запуск до первого платного вызова модели: деньги и регионы.
 * Групп и фраз здесь нет — их придумывает модель, и раньше её ответа их не знает
 * никто.
 */
export function renderReadiness(ready: CampaignEntryReady): string {
  const lines = [
    `Клиент: ${ready.clientName}`,
    `Что продаём: ${ready.brief.product}`,
    `Дневной бюджет: ${formatAmount(ready.brief.dailyBudgetRub)} ₽ ` +
      `(${ready.brief.budgetScope === 'per_channel' ? 'на канал' : 'на всё'}), ` +
      `целевой CPA ${formatAmount(ready.brief.targetCpaRub)} ₽`,
    `Регионы показа: ${describeRegions(ready.regionIds)}`,
    'Раскладка бюджета:',
    ...ready.budgets.map(
      (b) =>
        `  • ${channelLabel(b.channel)}, ${placementLabel(b.placement)} — ` +
        `${formatAmount(b.dailyBudgetRub)} ₽/сут`,
    ),
  ];

  for (const note of ready.notes) lines.push(`  ⚠️ ${note}`);

  lines.push(reusePlanLine(ready.reusablePlan));
  lines.push(dryRunNotice(ready.dryRun));
  return lines.join('\n');
}

function reusePlanLine(reusable: CampaignEntryReady['reusablePlan']): string {
  if (!reusable) {
    return 'План собирают два платных вызова модели: стратег (структура) и копирайтер (тексты).';
  }
  const total = reusable.plan.campaigns.length;
  if (reusable.untouched.length === total) {
    return 'План с прошлого захода сохранён — карточки выпущу по нему, модель звать не буду.';
  }
  return (
    'План с прошлого захода сохранён, модель звать не буду. Карточки выпущу только ' +
    `по кампаниям, которых ещё нет в кабинете: ${reusable.untouched.length} из ${total}.`
  );
}

/** Одна и та же формулировка везде: человек должен знать, чем кончится нажатие. */
export function dryRunNotice(dryRun: boolean): string {
  return dryRun
    ? '⚠️ DRY_RUN включён: даже после одобрения в кабинет не уйдёт ничего — ' +
        'изменение только запишется в журнал.'
    : '❗ DRY_RUN снят: после одобрения кампания создаётся в кабинете и начинает ' +
        'тратить дневной бюджет.';
}

export interface PlanSummaryOptions {
  /** Сколько групп перечислять поимённо. Остальные — строкой «и ещё N». */
  maxGroups?: number;
  /**
   * Позиции кампаний плана, о которых идёт речь. По умолчанию — весь план.
   *
   * Нужно повторному входу по наполовину созданному плану: сводка описывает то,
   * что человек сейчас одобряет, а созданная кампания уже тратит бюджет и в счёт
   * этого решения не входит.
   */
  only?: readonly number[];
}

/**
 * План словами: то, что человек видит до нажатия ✅.
 *
 * Карточка апрува показывает имя и бюджет одной кампании — этого мало, чтобы
 * решать. Здесь всё, из чего складывается счёт: сколько кампаний, групп, фраз и
 * объявлений, куда они будут показываться и что планировщик считает сомнительным.
 */
export function renderPlanSummary(
  plan: CampaignPlan,
  opts: PlanSummaryOptions & { dryRun: boolean },
): string {
  const maxGroups = opts.maxGroups ?? 8;
  const only = opts.only === undefined ? null : new Set(opts.only);
  const shown = plan.campaigns.filter((_, index) => only === null || only.has(index));
  // Сумма считается по показанным кампаниям, а не берётся из `totalDailyBudgetRub`:
  // для части плана поле плана — это чужой счёт, куда посчитаны деньги, которые
  // уже тратятся. Для целого плана схема гарантирует равенство (plan.schema.ts).
  const total = shown.reduce((acc, c) => acc + c.dailyBudgetRub, 0);

  const lines = [
    `📊 План кампании: ${plan.summary}`,
    `Общий дневной бюджет: ${formatAmount(total)} ₽/сут`,
  ];
  if (shown.length < plan.campaigns.length) {
    lines.push(
      `Кампаний в плане: ${plan.campaigns.length}, из них уже создано: ` +
        `${plan.campaigns.length - shown.length}. Ниже — только то, что будет создано.`,
    );
  }
  lines.push('');

  for (const campaign of shown) {
    const keywords = campaign.adGroups.reduce((acc, g) => acc + g.keywords.length, 0);
    const ads = campaign.adGroups.reduce((acc, g) => acc + g.ads.length, 0);
    const regions = campaign.adGroups[0]?.regionIds ?? [];
    lines.push(
      `▸ ${campaign.name} (${channelLabel(campaign.channel)}, ` +
        `${placementLabel(campaign.placement)})`,
      `  Бюджет: ${formatAmount(campaign.dailyBudgetRub)} ₽/сут, ` +
        `цель ${formatAmount(campaign.targetCpaRub)} ₽ за заявку`,
      `  Групп: ${campaign.adGroups.length}, фраз: ${keywords}, объявлений: ${ads}`,
      `  Регионы: ${describeRegions(regions)}`,
      `  Минус-слов на кампанию: ${campaign.negativeKeywords.length}`,
    );
    for (const group of campaign.adGroups.slice(0, maxGroups)) {
      // Ставка группы — ставка её первой фразы. Если фраз нет, ставки нет, и
      // писать вместо неё ноль нельзя: в этом проекте ноль и «не задано» разведены
      // намеренно (обоснование — `toGroupBid`, src/clients/vk-ads/adapter.ts), а
      // «ставка 0.00 ₽» читается как решение системы торговаться за бесплатно.
      const bid = group.keywords[0]?.bidRub;
      lines.push(
        `    – ${group.name}: ${group.keywords.length} фраз, ` +
          (bid === undefined ? 'ставка не задана' : `ставка ${formatAmount(bid)} ₽`),
      );
    }
    if (campaign.adGroups.length > maxGroups) {
      lines.push(`    – и ещё групп: ${campaign.adGroups.length - maxGroups}`);
    }
    lines.push('');
  }

  for (const warning of plan.warnings) lines.push(`⚠️ ${warning}`);
  if (plan.warnings.length > 0) lines.push('');

  lines.push(dryRunNotice(opts.dryRun));
  return lines.join('\n');
}
