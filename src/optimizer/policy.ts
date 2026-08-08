import { formatMoney, formatPercent } from './money.js';
import type { ApprovalKindName, Decision, HandoverModeName } from './types.js';

/** TZ §3.5 / E11 T11.06: изменение бюджета или ставки > 20% уходит на апрув. */
export const APPROVAL_CHANGE_THRESHOLD_PCT = 0.2;

/** TZ §3.5 / E11 T11.07: массовое отключение (> 10 сущностей) — всегда на апрув. */
export const MASS_PAUSE_THRESHOLD = 10;

export interface PolicyContext {
  handoverMode: HandoverModeName;
}

export interface ApprovalRequest {
  kind: ApprovalKindName;
  decisions: Decision[];
  /** Preview text for the Telegram approval card (TZ §3.5 «Формат апрув-запроса в TG»). */
  summary: string;
}

export interface PolicyOutcome {
  autoApply: Decision[];
  approvals: ApprovalRequest[];
}

const APPROVAL_KIND_ORDER: readonly ApprovalKindName[] = [
  'IMPORT_HANDOVER',
  'MASS_PAUSE',
  'BUDGET_CHANGE',
  'STRATEGY_CHANGE',
  'NEW_CAMPAIGN',
];

/**
 * Decides which decisions a human must confirm. Returns copies with `requiresApproval` and
 * `approvalKind` filled in — the layers above deliberately leave those unset.
 */
export function classifyDecisions(
  decisions: readonly Decision[],
  context: PolicyContext,
): PolicyOutcome {
  const pauseCount = decisions.filter((decision) => decision.action === 'PAUSE').length;
  const massPause = pauseCount > MASS_PAUSE_THRESHOLD;

  const autoApply: Decision[] = [];
  const grouped = new Map<ApprovalKindName, Decision[]>();

  for (const decision of decisions) {
    const kind = approvalKindFor(decision, context, massPause);
    if (kind === null) {
      autoApply.push({ ...decision, requiresApproval: false, approvalKind: null });
      continue;
    }
    const bucket = grouped.get(kind) ?? [];
    bucket.push({ ...decision, requiresApproval: true, approvalKind: kind });
    grouped.set(kind, bucket);
  }

  const approvals: ApprovalRequest[] = [];
  for (const kind of APPROVAL_KIND_ORDER) {
    const bucket = grouped.get(kind);
    if (bucket === undefined || bucket.length === 0) continue;
    approvals.push({ kind, decisions: bucket, summary: summarize(kind, bucket) });
  }

  return { autoApply, approvals };
}

/**
 * @param massPause - whether the whole batch crossed {@link MASS_PAUSE_THRESHOLD}; a single pause
 *   is routine, the same pause inside a wave of them is not.
 * @returns the approval kind required, or null when the decision may be applied automatically.
 */
export function approvalKindFor(
  decision: Decision,
  context: PolicyContext,
  massPause: boolean,
): ApprovalKindName | null {
  // TZ §15.7: an imported account is handed over in stages. OBSERVER watches only, ASSIST may do
  // the reversible "surgery" (negative keywords, pausing losers) but not touch money.
  if (context.handoverMode === 'OBSERVER') return 'IMPORT_HANDOVER';
  if (context.handoverMode === 'ASSIST' && !isSurgery(decision)) return 'IMPORT_HANDOVER';

  switch (decision.action) {
    case 'NEW_CAMPAIGN':
      return 'NEW_CAMPAIGN';
    case 'STRATEGY_CHANGE':
      return 'STRATEGY_CHANGE';
    case 'PAUSE':
      return massPause ? 'MASS_PAUSE' : null;
    case 'BUDGET_CHANGE':
      return exceedsThreshold(decision) ? 'BUDGET_CHANGE' : null;
    case 'BID_DECREASE':
    case 'BID_INCREASE':
      // ApprovalKind has no BID_CHANGE member on main; a bid above the threshold is still a money
      // decision, so it rides the BUDGET_CHANGE gate until a dedicated kind exists.
      return exceedsThreshold(decision) ? 'BUDGET_CHANGE' : null;
    case 'ADD_NEGATIVE_KEYWORD':
      return null;
    default:
      return null;
  }
}

export function relativeChange(decision: Decision): number | null {
  const { prevValue, nextValue } = decision;
  if (prevValue.kind !== nextValue.kind) return null;
  if (prevValue.kind === 'bid' && nextValue.kind === 'bid') {
    return prevValue.amount > 0
      ? Math.abs(nextValue.amount - prevValue.amount) / prevValue.amount
      : null;
  }
  if (prevValue.kind === 'budget' && nextValue.kind === 'budget') {
    return prevValue.amount > 0
      ? Math.abs(nextValue.amount - prevValue.amount) / prevValue.amount
      : null;
  }
  return null;
}

function exceedsThreshold(decision: Decision): boolean {
  const change = relativeChange(decision);
  // An unknown baseline is treated as "large": we refuse to auto-apply money changes we cannot
  // size against anything.
  if (change === null) return true;
  return change > APPROVAL_CHANGE_THRESHOLD_PCT;
}

function isSurgery(decision: Decision): boolean {
  return decision.action === 'ADD_NEGATIVE_KEYWORD' || decision.action === 'PAUSE';
}

function summarize(kind: ApprovalKindName, decisions: readonly Decision[]): string {
  if (decisions.length === 0) return '';

  switch (kind) {
    case 'MASS_PAUSE':
      return (
        `Массовое отключение: ${decisions.length} сущностей\n` +
        decisions
          .slice(0, MASS_PAUSE_THRESHOLD)
          .map((decision) => `• ${decision.entityType} ${decision.entityId}: ${decision.reason}`)
          .join('\n') +
        (decisions.length > MASS_PAUSE_THRESHOLD
          ? `\n…и ещё ${decisions.length - MASS_PAUSE_THRESHOLD}`
          : '')
      );
    case 'IMPORT_HANDOVER':
      return (
        `Режим передачи управления: ${decisions.length} изменений ждут подтверждения\n` +
        decisions
          .slice(0, MASS_PAUSE_THRESHOLD)
          .map((decision) => `• ${decision.reason}`)
          .join('\n')
      );
    default:
      return decisions.map((decision) => `• ${describeChange(decision)}`).join('\n');
  }
}

function describeChange(decision: Decision): string {
  const change = relativeChange(decision);
  const delta = change === null ? '' : ` (${formatPercent(change)}%)`;
  const from = amountOf(decision.prevValue);
  const to = amountOf(decision.nextValue);
  const values =
    from === null || to === null ? '' : `: ${formatMoney(from)} → ${formatMoney(to)}${delta}`;
  return `${decision.entityType} ${decision.entityId}${values}. ${decision.reason}`;
}

function amountOf(value: Decision['prevValue']): number | null {
  return value.kind === 'bid' || value.kind === 'budget' ? value.amount : null;
}
