import { cliInvocation } from './invocation.js';

import { env } from '@/env.js';
import type {
  ClampedDecision,
  Decision,
  OptimizerRun,
  RejectedDecision,
  ScheduledOptimizationSummary,
} from '@/optimizer/index.js';

export interface OptimizeCampaign {
  id: string;
  name: string;
  clientId: string;
}

export interface OptimizeCommandOptions {
  clientId?: string;
  apply: boolean;
}

export interface OptimizeCommandDeps {
  out?: (line: string) => void;
  listCampaigns?: (clientId: string | undefined) => Promise<OptimizeCampaign[]>;
  /** Прогон без единой записи: только чтение и решения. */
  preview?: (campaign: OptimizeCampaign) => Promise<OptimizerRun>;
  /** Тот же прогон, что делает крон: с записью в кабинеты и карточками апрува. */
  applyAll?: (clientId: string | undefined) => Promise<ScheduledOptimizationSummary>;
  dryRunEnv?: boolean;
}

async function defaultListCampaigns(clientId: string | undefined): Promise<OptimizeCampaign[]> {
  const { prisma } = await import('@/db/prisma.js');
  return prisma.campaign.findMany({
    where: clientId ? { clientId } : {},
    select: { id: true, name: true, clientId: true },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Показ рекомендаций по одной кампании — без единой записи.
 *
 * Сюда нельзя позвать `runScheduledOptimization`, хотя решения он считает те же:
 * даже в dry-run он создаёт карточки апрува, то есть шлёт человеку сообщения.
 * Команда «покажи» этого делать не должна. Поэтому здесь `runOptimizer` напрямую —
 * но с тем же сырьём, что у крона: своего агрегирования запросов и своего способа
 * добыть цель по CPA у показа быть не может, иначе он показывает не то, что будет
 * сделано.
 */
async function defaultPreview(campaign: OptimizeCampaign): Promise<OptimizerRun> {
  // Импорт внутри команды: движок тянет Prisma и правила, а команде channels
  // это не нужно — CLI должен отвечать мгновенно.
  const { runOptimizer, loadSearchQueryMetrics, readTargetCpaRub } =
    await import('@/optimizer/index.js');
  const { prisma } = await import('@/db/prisma.js');

  const now = new Date();
  const brief = await prisma.clientBrief.findUnique({
    where: { clientId: campaign.clientId },
    select: { data: true },
  });

  return runOptimizer(prisma, {
    campaignId: campaign.id,
    dryRun: true,
    now,
    searchQueries: await loadSearchQueryMetrics(campaign.id, now),
    fallbackTargetCpa: readTargetCpaRub(brief?.data),
  });
}

async function defaultApplyAll(
  clientId: string | undefined,
): Promise<ScheduledOptimizationSummary> {
  const { runScheduledOptimization } = await import('@/optimizer/index.js');
  return runScheduledOptimization({
    ...(clientId === undefined ? {} : { clientId }),
    dryRun: false,
  });
}

function describeEntity(decision: Decision): string {
  const label = decision.label;
  if (!label) return decision.entityId;
  // Метка минус-слова приходит уже в кавычках; вторая пара делала бы «««фраза»»».
  return label.startsWith('«') ? label : `«${label}»`;
}

function renderDecision(prefix: string, decision: Decision): string {
  return `  ${prefix} ${decision.action} ${describeEntity(decision)} — ${decision.reason}`;
}

function renderRail(prefix: string, item: RejectedDecision | ClampedDecision): string {
  return (
    `  [${prefix} ${item.rail}] ${item.decision.action} ` +
    `${describeEntity(item.decision)} — ${item.note}`
  );
}

interface PreviewTotals {
  decisions: number;
  skipped: Record<string, number>;
  noTargetCpa: string[];
}

function renderRun(
  campaign: OptimizeCampaign,
  run: OptimizerRun,
  out: (line: string) => void,
  totals: PreviewTotals,
): void {
  if (run.skipped) {
    totals.skipped[run.skipped] = (totals.skipped[run.skipped] ?? 0) + 1;
    return;
  }
  if (run.targetCpaSource === null) totals.noTargetCpa.push(campaign.name);

  const shown =
    run.autoApply.length + run.approvals.length + run.rejected.length + run.clamped.length;
  if (shown === 0) return;

  out('');
  out(`▸ ${campaign.name} (${campaign.id})`);

  for (const decision of run.autoApply) {
    totals.decisions += 1;
    out(renderDecision('[авто]', decision));
  }
  for (const approval of run.approvals) {
    totals.decisions += approval.decisions.length;
    // Только первая строка карточки: дальше в ней идёт тот же список решений,
    // который печатается ниже подробнее — с причиной и числами.
    out(`  [апрув ${approval.kind}] ${approval.summary.split('\n')[0] ?? ''}`);
    for (const decision of approval.decisions) out(renderDecision('    ↳', decision));
  }
  // Отклонённые важнее показать, чем скрыть: чаще всего это «данных мало»,
  // и без этой строки непонятно, почему рекомендаций нет.
  for (const rejected of run.rejected) out(renderRail('отклонено', rejected));
  for (const clamped of run.clamped) out(renderRail('ужато', clamped));
}

async function preview(
  campaigns: readonly OptimizeCampaign[],
  deps: OptimizeCommandDeps,
  out: (line: string) => void,
): Promise<void> {
  const run = deps.preview ?? defaultPreview;
  const totals: PreviewTotals = { decisions: 0, skipped: {}, noTargetCpa: [] };

  for (const campaign of campaigns) renderRun(campaign, await run(campaign), out, totals);

  out('');
  for (const [reason, count] of Object.entries(totals.skipped)) {
    out(`Пропущено кампаний (${reason}): ${count}`);
  }
  if (totals.noTargetCpa.length > 0) {
    // Без цели три правила из четырёх молчат, и «рекомендаций нет» читается как
    // «всё в порядке», хотя оптимизатор для этих кампаний просто не работает.
    out(
      `⚠️  Без цели по CPA (ни своей, ни в брифе): ${totals.noTargetCpa.length} — ` +
        `${totals.noTargetCpa.join(', ')}. Правила по CPA для них не работают вовсе.`,
    );
  }
  out(
    totals.decisions === 0
      ? 'Рекомендаций нет — либо данных мало, либо всё в пределах целей.'
      : `Всего решений: ${totals.decisions} (ничего не применено).`,
  );
}

function renderSummary(summary: ScheduledOptimizationSummary, out: (line: string) => void): void {
  out(`Кампаний просмотрено: ${summary.campaigns}`);
  out(`Изменений записано в кабинеты: ${summary.autoApply}`);
  out(`Карточек апрува выпущено: ${summary.approvals}`);
  out(`Отклонено предохранителями: ${summary.rejected}, ужато: ${summary.clamped}`);

  const troubles = [
    summary.applyFailed > 0 ? `не записано в кабинет: ${summary.applyFailed}` : null,
    summary.approvalsFailed > 0 ? `карточек не выпущено: ${summary.approvalsFailed}` : null,
    summary.localStateFailed > 0
      ? `изменение доехало, а наши строки не обновились: ${summary.localStateFailed}`
      : null,
    summary.failed > 0 ? `кампаний упало целиком: ${summary.failed}` : null,
  ].filter((line): line is string => line !== null);

  if (troubles.length > 0) {
    // Молчать об этом нельзя: деньги в этих строках уже потрачены или, наоборот,
    // человек ждёт карточку, которой не будет. В логе это видит только дежурный.
    out(`⚠️  ${troubles.join('; ')}. Подробности — в ErrorLog.`);
  }
  if (summary.noTargetCpa > 0) {
    out(`⚠️  Кампаний без цели по CPA: ${summary.noTargetCpa} — правила по CPA для них молчат.`);
  }
}

/**
 * Оптимизатор в ручном режиме (пункт приёмки ТЗ §9.3).
 *
 * Без `--apply` — чтение и печать: ни ставки, ни карточки, ни строки в ChangeLog.
 * С `--apply` работа уходит в `runScheduledOptimization` — ту же точку, которую
 * дёргает крон. Раньше `--apply` здесь означал только флаг в отчёте движка:
 * решения считались и выбрасывались, а вывод при этом читался как «применено».
 */
export async function runOptimizeCommand(
  options: OptimizeCommandOptions,
  deps: OptimizeCommandDeps = {},
): Promise<void> {
  const out = deps.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const dryRunEnv = deps.dryRunEnv ?? env.DRY_RUN;

  // Предохранитель окружения старше флага: снять защиту можно только в двух
  // местах сразу.
  const apply = options.apply && !dryRunEnv;
  if (options.apply && dryRunEnv) {
    out('⚠️  --apply проигнорирован: DRY_RUN=true в окружении. Показываю, что было бы сделано.');
    out('');
  }

  if (apply) {
    renderSummary(await (deps.applyAll ?? defaultApplyAll)(options.clientId), out);
    return;
  }

  const campaigns = await (deps.listCampaigns ?? defaultListCampaigns)(options.clientId);
  if (campaigns.length === 0) {
    out(`Кампаний нет. Сначала выполните: ${cliInvocation()} ingest`);
    return;
  }
  await preview(campaigns, deps, out);
}
