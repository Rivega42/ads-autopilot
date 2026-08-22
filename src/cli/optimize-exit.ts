import type { ScheduledOptimizationSummary } from '@/optimizer/index.js';

/**
 * Нужно ли вмешательство человека после прогона с записью.
 *
 * Тот же смысл, что у `needsHumanFix` для `campaign`: не «результат
 * отрицательный», а «дальше само не поедет». `optimize --apply` печатал
 * «не записано в кабинет: 5» и выходил нулём — скрипт, обходящий клиентов,
 * не отличал это от успеха, и потери находились только в логе дежурного.
 *
 * Кампании без цели по CPA сюда не входят намеренно: это не поломка прогона, а
 * незаполненный бриф. Ненулевой код на них загорался бы каждый прогон подряд и
 * очень быстро перестал бы что-либо значить.
 */
export function optimizeNeedsHumanFix(summary: ScheduledOptimizationSummary): boolean {
  return (
    summary.applyFailed > 0 ||
    summary.approvalsFailed > 0 ||
    // Недоставленная карточка — тот же случай, что у `campaign`: заявка создана,
    // а нажать её некому, и через APPROVAL_TIMEOUT_HOURS она тихо истечёт.
    summary.approvalsUndelivered > 0 ||
    summary.localStateFailed > 0 ||
    summary.failed > 0
  );
}
