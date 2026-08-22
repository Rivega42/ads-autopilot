import type { InlineKeyboardMarkup } from 'grammy/types';

import { encodeCallbackData } from '@/approval/callback-data.js';
import { matchApprovalRule } from '@/approval/policy.js';
import type { ApprovalAction } from '@/approval/types.js';
import { formatMsk } from '@/lib/dates.js';

/**
 * Рендер карточки апрува (формат — TZ §3.5).
 *
 * Текст шлём без parse_mode: имена клиентов и кампаний приходят из кабинетов и
 * регулярно содержат `<`, `&`, `_` и звёздочки. Экранировать это надёжнее всего
 * тем, что не включать разметку вовсе — цена вопроса только в отсутствии жирного.
 */

const LEVEL_NAMES: Record<string, string> = {
  campaign: 'кампаний',
  adgroup: 'групп объявлений',
  ad: 'объявлений',
  keyword: 'ключевых фраз',
};

/** Разряды через обычный пробел: неразрывный из Intl ломает сравнение в тестах и поиск в чате. */
export function formatAmount(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  const [int = '0', frac] = Math.abs(rounded).toFixed(2).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const sign = rounded < 0 ? '-' : '';
  return frac && frac !== '00' ? `${sign}${grouped},${frac}` : `${sign}${grouped}`;
}

function levelName(level: string): string {
  return LEVEL_NAMES[level] ?? level;
}

/** Строка «Действие: …» — что именно произойдёт, если человек нажмёт ✅. */
export function describeAction(action: ApprovalAction): string {
  switch (action.kind) {
    case 'create_campaign':
      return `Создать кампанию «${action.campaignName}» с дневным бюджетом ${formatAmount(
        action.dailyBudget,
      )} ₽/сут`;

    case 'budget_change': {
      const verb = action.after < action.before ? 'Снизить' : 'Повысить';
      return `${verb} дневной бюджет кампании «${action.campaignName}» с ${formatAmount(
        action.before,
      )} до ${formatAmount(action.after)} ₽/сут`;
    }

    case 'pause_entities':
      return `Отключить ${action.externalIds.length} ${levelName(action.level)}`;

    case 'resume_entities':
      return `Включить ${action.externalIds.length} ${levelName(action.level)}`;

    case 'bid_change':
      return `Изменить ставки: ${action.changes.length} ключевых фраз`;

    case 'add_negatives':
      return `Добавить ${action.phrases.length} минус-слов в кампанию ${action.campaignExternalId}`;

    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

export interface RenderCardOptions {
  action: ApprovalAction;
  clientName: string;
  expiresAt: Date;
  /** Ничего не уйдёт в кабинет — человек должен это видеть до нажатия. */
  dryRun?: boolean;
}

export function renderApprovalCard(opts: RenderCardOptions): string {
  const rule = matchApprovalRule(opts.action);
  const lines = [
    `🔔 Апрув требуется: ${opts.clientName}`,
    `Действие: ${describeAction(opts.action)}`,
    `Причина: ${opts.action.reason}`,
  ];
  if (rule) lines.push(`Правило: ${rule.title}`);
  lines.push(`Ответить до: ${formatMsk(opts.expiresAt)} МСК`);
  if (opts.dryRun) lines.push('⚠️ Режим dry-run: изменение будет только записано в журнал');
  return lines.join('\n');
}

export function buildApprovalKeyboard(approvalId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '✅ Одобрить', callback_data: encodeCallbackData('approve', approvalId) },
        { text: '❌ Отклонить', callback_data: encodeCallbackData('reject', approvalId) },
        { text: 'ℹ️ Детали', callback_data: encodeCallbackData('details', approvalId) },
      ],
    ],
  };
}

export type CardOutcome =
  | {
      kind: 'applied';
      by: string;
      dryRun: boolean;
      /** Площадке нечего было менять: запись не выполнялась, но и dry-run тут ни при чём. */
      noop?: boolean;
      /**
       * Изменение выполнено, но что-то рядом пошло не так (журнал, статус, расхождение
       * режима). Человеку это показываем: «применено» без оговорки было бы неправдой.
       */
      warning?: string;
    }
  | { kind: 'failed'; by: string; error: string }
  | { kind: 'rejected'; by: string }
  | { kind: 'expired' };

/**
 * Итоговый текст вместо карточки. Клавиатура при редактировании снимается,
 * поэтому исход виден в истории чата и повторно нажать уже нечего.
 */
export function renderOutcome(card: string, outcome: CardOutcome): string {
  const footer = (() => {
    switch (outcome.kind) {
      case 'applied': {
        const head = outcome.dryRun
          ? `✅ Одобрено (${outcome.by}). Dry-run: в кабинет ничего не отправлено, изменение записано в журнал.`
          : outcome.noop
            ? `✅ Одобрено (${outcome.by}). Площадка сообщила, что менять нечего — в кабинете ничего не изменилось.`
            : `✅ Одобрено (${outcome.by}) и применено.`;
        return outcome.warning ? `${head}\n⚠️ ${outcome.warning}` : head;
      }
      case 'failed':
        return `⚠️ Одобрено (${outcome.by}), но применить не удалось: ${outcome.error}`;
      case 'rejected':
        return `❌ Отклонено (${outcome.by}). Изменение не применено.`;
      case 'expired':
        return '⏳ Срок ответа истёк. Изменение не применено.';
      default: {
        const exhaustive: never = outcome;
        return exhaustive;
      }
    }
  })();
  return `${card}\n\n${footer}`;
}

/** Текст для кнопки «ℹ️ Детали»: техническая начинка, которой нет в карточке. */
export function renderDetails(action: ApprovalAction): string {
  switch (action.kind) {
    case 'budget_change':
      return `Кампания ${action.campaignExternalId}: ${formatAmount(
        action.before,
      )} → ${formatAmount(action.after)} ₽/сут`;
    case 'pause_entities':
    case 'resume_entities':
      return `${levelName(action.level)}: ${action.externalIds.join(', ')}`;
    case 'bid_change':
      return action.changes
        .map((c) => `${c.keywordExternalId}: ${c.bidBefore ?? '?'} → ${c.bid}`)
        .join('\n');
    case 'add_negatives':
      return action.phrases.join(', ');
    case 'create_campaign':
      return `Стратегия: ${JSON.stringify(action.strategy)}`;
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}
