/**
 * Публичный фасад approval-модуля (EPIC-06).
 *
 * Наружу торчат ровно три сценария:
 *  • `requestApprovalIfNeeded` / `createApproval` — оптимизатор просит человека;
 *  • `handleApprovalCallback` — бот отдаёт нажатие кнопки;
 *  • `expireApprovals` — крон `expire-approvals` гасит просроченное.
 */
export {
  createApproval,
  requestApprovalIfNeeded,
  type CreateApprovalOptions,
} from '@/approval/create.js';
export { applyApproval, type ApplyOutcome } from '@/approval/apply.js';
export {
  handleApprovalCallback,
  processApprovalCallback,
  type CallbackOutcome,
  type CallbackRequest,
} from '@/approval/callbacks.js';
export {
  expireApprovals,
  reconcileStuckApprovals,
  STUCK_APPROVAL_MINUTES,
  type ExpireResult,
} from '@/approval/expire.js';
export {
  matchApprovalRule,
  requiresApproval,
  budgetChangeRatio,
  BUDGET_CHANGE_APPROVAL_THRESHOLD,
  MASS_PAUSE_ENTITY_THRESHOLD,
  type ApprovalRule,
  type ApprovalRuleCode,
} from '@/approval/policy.js';
export {
  approvalActionSchema,
  approvalKindOf,
  parseAction,
  buildApprovalPayload,
  readApprovalMeta,
  type ApprovalAction,
  type ApprovalActionKind,
  type ApprovalActionInput,
  type ApprovalMeta,
} from '@/approval/types.js';
export { registerActionExecutor, type ActionExecutor } from '@/approval/execute.js';
// Пометка применённых минус-фраз нужна обоим путям применения — через апрув и
// напрямую из оптимизатора, — поэтому лежит здесь, а не внутри одного из них.
export { markNegatedQueries, type MarkNegatedInput } from '@/approval/mark-negated.js';
export {
  createApiMessenger,
  getMessenger,
  setMessenger,
  type ApprovalMessenger,
} from '@/approval/telegram.js';
export {
  encodeCallbackData,
  decodeCallbackData,
  TELEGRAM_CALLBACK_DATA_MAX_BYTES,
  type ApprovalVerdict,
} from '@/approval/callback-data.js';
export { renderApprovalCard, describeAction, buildApprovalKeyboard } from '@/approval/card.js';
