import { formatYmd } from './dates';
import { formatInteger } from './format';

export interface ApprovalsSubtitleInput {
  /** Режется ли набор периодом — история решений режется, очередь нет. */
  readonly periodApplies: boolean;
  /** Размер набора под фильтром — то, что показывает страница. */
  readonly total: number;
  /** Вся очередь без фильтров по клиенту — то же число, что в шапке. */
  readonly queueTotal: number | null;
  readonly from: string;
  readonly to: string;
  readonly rangeDays: number;
}

/**
 * Подзаголовок `/approvals`: какое множество показано и почему счётчик в шапке
 * может показывать другое число.
 *
 * Слово «целиком» здесь имеет цену: под фильтром по клиенту очередь показана не
 * целиком, и подпись обязана назвать оба числа вместо обещания совпадения.
 * Бейдж фильтров интерфейса не видит и увидеть не может — layout Next.js не
 * получает `searchParams`.
 */
export function approvalsSubtitle(input: ApprovalsSubtitleInput): string {
  const period = `${formatYmd(input.from)} — ${formatYmd(input.to)}`;
  if (input.periodApplies) return `${input.rangeDays} дн.: ${period} (МСК)`;

  const tail = `Период (${period}) фильтрует только принятые решения.`;
  if (input.queueTotal === null || input.queueTotal === input.total) {
    return `Ждут решения: ${formatInteger(input.total)} — очередь показана целиком. ${tail}`;
  }

  return (
    `Ждут решения под фильтром: ${formatInteger(input.total)} из ` +
    `${formatInteger(input.queueTotal)} в очереди — счётчик в шапке считает всю очередь, ` +
    `без фильтров по клиенту. ${tail}`
  );
}

/**
 * Пустая таблица `/approvals`: почему пусто именно здесь.
 *
 * «Ничего не ждёт решения» при фильтре по клиенту — то же обещание совпадения с
 * шапкой, только сказанное словами: очередь может быть непуста, а отсеян весь
 * её видимый кусок.
 */
export function approvalsEmptyText(
  input: Pick<ApprovalsSubtitleInput, 'periodApplies' | 'queueTotal'>,
): string {
  if (input.periodApplies) return 'Решений с таким статусом за выбранный период нет.';
  if (input.queueTotal !== null && input.queueTotal > 0) {
    return (
      `Под фильтром ничего не ждёт решения. Вся очередь — ` +
      `${formatInteger(input.queueTotal)}: снимите фильтр по клиенту, чтобы увидеть её.`
    );
  }
  return 'Ничего не ждёт решения.';
}
