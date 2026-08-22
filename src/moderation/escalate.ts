import type { Provider } from '@prisma/client';

import { getMessenger } from '@/approval/index.js';
import { env } from '@/env.js';
import { AppError } from '@/lib/errors.js';
import { RULES_COUNT } from '@/moderation/rules.js';
import { CATEGORY_TITLE, type AdText, type ClassifiedRejection } from '@/moderation/types.js';

/**
 * Шаг 6 из TZ §13.4: после трёх неудач объявление отдаётся человеку.
 *
 * Почему не через `createApproval`: апрув — это «разреши применить вот это действие»,
 * с кнопками и TTL. Здесь применять нечего — автоматика как раз и не смогла собрать
 * вариант. Человеку нужен разбор: что сказала площадка, что мы пробовали и почему
 * это не сработало. Поэтому эскалация — отдельный тип сообщения, но транспорт общий
 * с апрувами (`approval/telegram.ts`), чтобы в проекте не завелось третьего клиента
 * Telegram и чтобы тесты подменяли одну и ту же заглушку.
 */

/** Почему автоматика прекратила попытки. */
export type EscalationCause =
  | 'retries_exhausted'
  | 'rewrite_failed'
  | 'channel_unsupported'
  | 'apply_failed'
  | 'external_id_taken'
  | 'ad_missing';

const CAUSE_TITLE: Readonly<Record<EscalationCause, string>> = {
  retries_exhausted: 'три переписанных варианта подряд получили отказ',
  rewrite_failed: 'не удалось собрать вариант, проходящий проверки',
  channel_unsupported: 'канал не умеет обновлять текст объявления',
  apply_failed: 'отправка переписанного текста в кабинет не удалась',
  external_id_taken: 'внешний id нового объявления занят другой строкой в нашей БД',
  ad_missing: 'объявления с таким id в кабинете больше нет',
};

export interface ModerationEscalation {
  clientId: string;
  clientName: string;
  /** Личный чат клиента. Пустая строка — уйдёт в админский чат. */
  chatId: string;
  channel: Provider;
  campaignName: string;
  adId: string;
  adExternalId: string;
  retries: number;
  /** Причина отказа дословно от площадки. */
  reason: string;
  classification: ClassifiedRejection | null;
  ad: AdText;
  /** Что именно не сошлось в последней попытке. */
  problems: readonly string[];
  cause: EscalationCause;
}

export type EscalationSink = (escalation: ModerationEscalation) => Promise<void>;

/** Запас до лимита Telegram в 4096 символов: разбор бывает длинным. */
const MESSAGE_LIMIT = 3_900;

export function renderEscalation(e: ModerationEscalation): string {
  const lines: string[] = [
    '🚫 Модерация: нужен человек',
    '',
    `Клиент: ${e.clientName}`,
    `Канал: ${e.channel}`,
    `Кампания: ${e.campaignName}`,
    `Объявление: ${e.adExternalId} (внутренний id ${e.adId})`,
    `Попыток переписать: ${e.retries}`,
    `Почему остановились: ${CAUSE_TITLE[e.cause]}`,
    '',
    'Причина отказа площадки:',
    e.reason.trim() === '' ? '— площадка причину не прислала' : e.reason.trim(),
  ];

  if (e.classification) {
    lines.push(
      '',
      `Категория: ${e.classification.category} — ${CATEGORY_TITLE[e.classification.category]}`,
      `Разбор: ${e.classification.explanation}`,
    );
    if (e.classification.rules.length > 0) {
      lines.push('', 'Правила, по которым переписывали:');
      for (const rule of e.classification.rules) {
        lines.push(`• ${rule.id} — ${rule.source.authority}, ${rule.source.ref}`);
      }
    }
  }

  lines.push(
    '',
    'Последний вариант текста:',
    `1: ${e.ad.title}`,
    ...(e.ad.title2 ? [`2: ${e.ad.title2}`] : []),
    `Т: ${e.ad.text}`,
  );

  if (e.problems.length > 0) {
    lines.push('', 'Что не сошлось:');
    for (const problem of e.problems) lines.push(`• ${problem}`);
  }

  lines.push('', `База правил: ${RULES_COUNT} шт. Объявление остановлено до решения человека.`);

  const text = lines.join('\n');
  return text.length <= MESSAGE_LIMIT ? text : `${text.slice(0, MESSAGE_LIMIT - 1)}…`;
}

/**
 * Транспорт по умолчанию: то же место, куда уходят карточки апрувов.
 *
 * Если чата клиента нет, письмо уходит Роману: эскалация, которую никто не получил,
 * ничем не лучше строчки в логе, а её здесь как раз и нельзя допустить.
 */
export const sendEscalation: EscalationSink = async (escalation) => {
  const chatId = escalation.chatId || env.TELEGRAM_ADMIN_CHAT_ID;
  if (!chatId) {
    throw new AppError('Moderation escalation has nowhere to go: no client chat, no admin chat', {
      code: 'ESCALATION_NO_CHAT',
      context: { clientId: escalation.clientId, adId: escalation.adId },
    });
  }
  await getMessenger().sendMessage(chatId, renderEscalation(escalation));
};
