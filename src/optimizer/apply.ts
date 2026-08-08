import type {
  ChangeActorName,
  Decision,
  DecisionAction,
  DecisionValue,
  OptimizerEntityType,
} from './types.js';

export interface ChangeLogRecord {
  id: string;
  campaignId: string | null;
  entityType: string;
  entityId: string;
  action: string;
  prevValue: unknown;
  newValue: unknown;
  reason: string | null;
  actor: string;
  appliedAt: Date;
  rolledBackAt: Date | null;
}

export interface ChangeLogCreateData {
  campaignId: string | null;
  entityType: string;
  entityId: string;
  action: string;
  prevValue: unknown;
  newValue: unknown;
  reason: string;
  actor: ChangeActorName;
}

/** The slice of Prisma apply.ts touches; `PrismaClient` satisfies it structurally. */
export interface ApplyDb {
  changeLog: {
    create(args: { data: ChangeLogCreateData }): Promise<ChangeLogRecord>;
    findUnique(args: { where: { id: string } }): Promise<ChangeLogRecord | null>;
    update(args: { where: { id: string }; data: { rolledBackAt: Date } }): Promise<ChangeLogRecord>;
  };
}

export interface PlatformWriteRequest {
  entityType: OptimizerEntityType;
  entityId: string;
  action: DecisionAction;
  prevValue: DecisionValue;
  nextValue: DecisionValue;
  /** Must be forwarded to the ad platform as its `Idempotency-Key` (CLAUDE.md §6). */
  idempotencyKey: string;
}

export type PlatformWriteResult =
  | { status: 'applied' }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string };

/**
 * The only way this module reaches an ad platform. A narrow function type rather than a client
 * import, so the adapter layer can change shape without touching the optimizer.
 */
export type PlatformWriter = (request: PlatformWriteRequest) => Promise<PlatformWriteResult>;

/**
 * Reservation of a change identity, so a retried run cannot apply the same change twice.
 *
 * There is no `IdempotencyKey` model on main yet; until there is, the durable implementation
 * cannot exist and only the in-memory one below is available.
 */
export interface IdempotencyStore {
  reserve(key: string): Promise<'reserved' | 'duplicate'>;
  release(key: string): Promise<void>;
}

export function createInMemoryIdempotencyStore(): IdempotencyStore {
  const keys = new Set<string>();
  return {
    reserve(key: string): Promise<'reserved' | 'duplicate'> {
      if (keys.has(key)) return Promise.resolve('duplicate');
      keys.add(key);
      return Promise.resolve('reserved');
    },
    release(key: string): Promise<void> {
      keys.delete(key);
      return Promise.resolve();
    },
  };
}

export interface ApplyDeps {
  db: ApplyDb;
  writeToPlatform: PlatformWriter;
  idempotency: IdempotencyStore;
  now?: () => Date;
}

export interface ApplyParams {
  campaignId: string;
  runId: string;
  decisions: readonly Decision[];
  dryRun: boolean;
}

export interface AppliedChange {
  decision: Decision;
  changeLogId: string;
  idempotencyKey: string;
}

export interface SkippedChange {
  decision: Decision;
  reason: string;
}

export interface FailedChange {
  decision: Decision;
  reason: string;
  /** True when the platform accepted the change but the ChangeLog row could not be written. */
  platformApplied: boolean;
}

export interface ApplyReport {
  runId: string;
  campaignId: string;
  dryRun: boolean;
  applied: AppliedChange[];
  skipped: SkippedChange[];
  failed: FailedChange[];
  /** Populated only in dry-run: what would have been applied. */
  planned: Decision[];
}

export function idempotencyKeyFor(runId: string, decision: Decision): string {
  const discriminator =
    decision.nextValue.kind === 'negativeKeyword' ? `:${decision.nextValue.phrase}` : '';
  return `${runId}:${decision.entityType}:${decision.entityId}:${decision.action}${discriminator}`;
}

/**
 * Applies decisions to the ad platform and records each one in `ChangeLog` with `actor: AI`.
 * Decisions still carrying `requiresApproval` are never applied here — the approval module
 * re-submits them once a human has confirmed.
 */
export async function applyDecisions(deps: ApplyDeps, params: ApplyParams): Promise<ApplyReport> {
  const report: ApplyReport = {
    runId: params.runId,
    campaignId: params.campaignId,
    dryRun: params.dryRun,
    applied: [],
    skipped: [],
    failed: [],
    planned: [],
  };

  for (const decision of params.decisions) {
    if (decision.requiresApproval) {
      report.skipped.push({ decision, reason: 'требуется апрув' });
      continue;
    }

    if (params.dryRun) {
      report.planned.push(decision);
      continue;
    }

    const key = idempotencyKeyFor(params.runId, decision);
    const reservation = await deps.idempotency.reserve(key);
    if (reservation === 'duplicate') {
      report.skipped.push({ decision, reason: `уже применено (${key})` });
      continue;
    }

    let result: PlatformWriteResult;
    try {
      result = await deps.writeToPlatform({
        entityType: decision.entityType,
        entityId: decision.entityId,
        action: decision.action,
        prevValue: decision.prevValue,
        nextValue: decision.nextValue,
        idempotencyKey: key,
      });
    } catch (error: unknown) {
      await deps.idempotency.release(key);
      report.failed.push({ decision, reason: errorMessage(error), platformApplied: false });
      continue;
    }

    if (result.status !== 'applied') {
      // Nothing changed on the platform, so the identity must become free again — otherwise a
      // transient failure would permanently block the change from ever being retried.
      await deps.idempotency.release(key);
      if (result.status === 'skipped') {
        report.skipped.push({ decision, reason: result.reason });
      } else {
        report.failed.push({ decision, reason: result.reason, platformApplied: false });
      }
      continue;
    }

    try {
      const row = await deps.db.changeLog.create({
        data: {
          campaignId: params.campaignId,
          entityType: decision.entityType,
          entityId: decision.entityId,
          action: decision.action,
          prevValue: decision.prevValue,
          newValue: decision.nextValue,
          reason: decision.reason,
          actor: 'AI',
        },
      });
      report.applied.push({ decision, changeLogId: row.id, idempotencyKey: key });
    } catch (error: unknown) {
      // The key is deliberately NOT released: the platform already changed, and re-applying is
      // worse than an unlogged change. Reported so the operator can reconcile by hand.
      report.failed.push({ decision, reason: errorMessage(error), platformApplied: true });
    }
  }

  return report;
}

export type RollbackStatus =
  'rolled_back' | 'already_rolled_back' | 'not_found' | 'unsupported' | 'failed';

export interface RollbackResult {
  status: RollbackStatus;
  changeLogId: string;
  reason?: string;
}

/**
 * Reverses one logged change (TZ §15.9, E11 T11.13): writes `prevValue` back to the platform and
 * stamps `rolledBackAt`. The stamp is written only after the platform confirms, so a row without
 * it always means the change is still live.
 */
export async function rollbackChange(
  deps: ApplyDeps,
  changeLogId: string,
): Promise<RollbackResult> {
  const now = deps.now ?? ((): Date => new Date());
  const row = await deps.db.changeLog.findUnique({ where: { id: changeLogId } });
  if (row === null) return { status: 'not_found', changeLogId };
  if (row.rolledBackAt !== null) return { status: 'already_rolled_back', changeLogId };

  const entityType = parseEntityType(row.entityType);
  const action = parseAction(row.action);
  const prevValue = parseDecisionValue(row.prevValue);
  const nextValue = parseDecisionValue(row.newValue);
  if (entityType === null || action === null || prevValue === null || nextValue === null) {
    return {
      status: 'unsupported',
      changeLogId,
      reason: 'запись ChangeLog не содержит распознаваемых значений для отката',
    };
  }

  let result: PlatformWriteResult;
  try {
    result = await deps.writeToPlatform({
      entityType,
      entityId: row.entityId,
      action,
      prevValue: nextValue,
      nextValue: prevValue,
      idempotencyKey: `rollback:${changeLogId}`,
    });
  } catch (error: unknown) {
    return { status: 'failed', changeLogId, reason: errorMessage(error) };
  }

  if (result.status !== 'applied') {
    return { status: 'failed', changeLogId, reason: result.reason };
  }

  await deps.db.changeLog.update({
    where: { id: changeLogId },
    data: { rolledBackAt: now() },
  });

  return { status: 'rolled_back', changeLogId };
}

export function parseDecisionValue(value: unknown): DecisionValue | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const kind = record['kind'];

  if (kind === 'bid' || kind === 'budget') {
    const amount = record['amount'];
    return typeof amount === 'number' && Number.isFinite(amount) ? { kind, amount } : null;
  }
  if (kind === 'status') {
    const status = record['status'];
    return status === 'ACTIVE' || status === 'PAUSED' || status === 'ARCHIVED'
      ? { kind: 'status', status }
      : null;
  }
  if (kind === 'negativeKeyword') {
    const phrase = record['phrase'];
    return typeof phrase === 'string' ? { kind: 'negativeKeyword', phrase } : null;
  }
  if (kind === 'strategy') {
    const strategy = record['strategy'];
    return typeof strategy === 'string' ? { kind: 'strategy', strategy } : null;
  }
  if (kind === 'absent') return { kind: 'absent' };

  return null;
}

const ENTITY_TYPES: readonly OptimizerEntityType[] = ['CAMPAIGN', 'ADGROUP', 'AD', 'KEYWORD'];

const ACTIONS: readonly DecisionAction[] = [
  'PAUSE',
  'BID_DECREASE',
  'BID_INCREASE',
  'BUDGET_CHANGE',
  'ADD_NEGATIVE_KEYWORD',
  'NEW_CAMPAIGN',
  'STRATEGY_CHANGE',
];

function parseEntityType(value: string): OptimizerEntityType | null {
  return ENTITY_TYPES.find((candidate) => candidate === value) ?? null;
}

function parseAction(value: string): DecisionAction | null {
  return ACTIONS.find((candidate) => candidate === value) ?? null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
