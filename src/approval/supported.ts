import type { ApprovalAction } from '@/approval/types.js';
import { channelCapabilities } from '@/channels/capabilities.js';
import { AppError } from '@/lib/errors.js';

/**
 * Исполнима ли пара «вид действия × канал» — вопрос, который задают ДО человека.
 *
 * Объявление вида действия в `approvalActionSchema` говорит только про вид: канал в
 * действии живёт отдельным полем, и «система умеет минус-слова» не значит «умеет их
 * в VK». Карточка, падающая после нажатия ✅, — худший из исходов: человек уже решил
 * и уверен, что дело сделано, а в кабинете не изменилось ничего. Поэтому отказ
 * случается на выпуске карточки, а не на её применении.
 *
 * Текст отказа — для лога и для человека, поэтому по-русски и с обоими участниками
 * пары: «канал X не умеет Y» чинится, «действие не поддерживается» — нет.
 */
export function unsupportedActionReason(action: ApprovalAction): string | null {
  const caps = channelCapabilities(action.channel);

  switch (action.kind) {
    case 'create_campaign':
      return caps.createCampaign
        ? null
        : `Канал ${action.channel} не умеет создавать кампании: заливать план в кабинет нечем`;

    case 'budget_change':
      return caps.budgets ? null : `Канал ${action.channel} не умеет менять дневной бюджет`;

    case 'bid_change':
      return caps.bids ? null : `Канал ${action.channel} не умеет менять ставки`;

    case 'add_negatives':
      return caps.negativeKeywords ? null : `Канал ${action.channel} не умеет минус-слова`;

    case 'pause_entities':
    case 'resume_entities':
      return caps.suspendableLevels.includes(action.level)
        ? null
        : `Канал ${action.channel} не умеет останавливать и запускать сущности уровня «${action.level}»`;

    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

/** Короткая форма для тех, кому нужен только ответ «да/нет». */
export function isActionExecutable(action: ApprovalAction): boolean {
  return unsupportedActionReason(action) === null;
}

/**
 * Запрещает выпуск карточки на неисполнимую пару.
 *
 * Бросает, а не возвращает флаг: это последний рубеж перед строкой в БД и
 * сообщением в чат. Выпускающие карточку сами спрашивают `unsupportedActionReason`
 * заранее и такую заявку не строят — сюда доходит только то, что построили молча.
 *
 * @throws {AppError} код `ACTION_NOT_SUPPORTED`
 */
export function assertActionExecutable(action: ApprovalAction): void {
  const reason = unsupportedActionReason(action);
  if (reason === null) return;
  throw new AppError(reason, {
    code: 'ACTION_NOT_SUPPORTED',
    context: { kind: action.kind, channel: action.channel },
  });
}
