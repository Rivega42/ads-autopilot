import type { Bot, Context } from 'grammy';

import { findActiveClientId } from '@/bot/client-lookup.js';
import {
  checkCampaignEntry,
  launchCampaign,
  renderEntryBlock,
  renderPlanSummary,
  renderReadiness,
  type CampaignLaunchOptions,
} from '@/campaigns/index.js';
import { describeError } from '@/lib/errors.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'bot.campaign' });

/**
 * Команда «запусти» из TZ §13.1: клиент, закончивший интервью, просит запустить
 * рекламу прямо в чате.
 *
 * Обработчик доводит дело до карточек апрува и на этом останавливается. Нажатие
 * ✅ уже обслуживает approval-модуль (`handleApprovalCallback`), и второго пути
 * в кабинет здесь нет: создание кампании — самое дорогое решение системы, и по
 * TZ §3.5 оно принимается человеком, а не командой.
 *
 * Порядок сообщений неслучаен: сначала деньги и регионы (это известно бесплатно),
 * потом собранный план, и только потом карточки. Человек должен увидеть счёт до
 * того, как у него появится кнопка, которая его оплатит.
 */

/** Telegram режет сообщение на 4096 символах; режем сами, чтобы не терять хвост молча. */
const MESSAGE_MAX_CHARS = 3_800;

const FRESH_WORDS: ReadonlySet<string> = new Set(['new', 'заново', 'новый', 'ещё', 'еще']);

export interface CampaignHandlerDeps {
  /** Подмена планировщика и хранилища. Нужна сценарным тестам: живую модель они не зовут. */
  options?: CampaignLaunchOptions;
}

function truncate(text: string): string {
  return text.length <= MESSAGE_MAX_CHARS
    ? text
    : `${text.slice(0, MESSAGE_MAX_CHARS)}\n… (продолжение обрезано)`;
}

async function say(ctx: Context, text: string): Promise<void> {
  // Без разметки: имена кампаний и городов приходят из брифа и регулярно содержат
  // символы, которые Markdown ломают (та же причина, что в карточке апрува).
  await ctx.reply(truncate(text), { link_preview_options: { is_disabled: true } });
}

export function registerCampaignHandlers(bot: Bot, deps: CampaignHandlerDeps = {}): void {
  bot.command(['launch', 'campaign'], async (ctx) => {
    const clientId = await findActiveClientId(ctx);
    if (!clientId) {
      await say(ctx, 'Не нашёл тебя в базе (или доступ на паузе). Напиши Роману.');
      return;
    }

    const fresh = FRESH_WORDS.has((ctx.match ?? '').trim().toLowerCase());
    const opts: CampaignLaunchOptions = { ...(deps.options ?? {}), fresh };

    try {
      const check = await checkCampaignEntry(clientId, opts);
      if (check.kind !== 'ready' && !(fresh && check.kind === 'already_created')) {
        await say(ctx, renderEntryBlock(check));
        return;
      }

      if (check.kind === 'ready') {
        await say(
          ctx,
          `${renderReadiness(check)}\n\n${
            check.reusablePlan ? 'Отправляю карточки…' : 'Собираю план, это до минуты…'
          }`,
        );
      } else {
        // Сюда попадаем только по явному «заново» поверх созданных кампаний:
        // человек просит вторую кампанию, и он должен видеть, что это именно она.
        await say(
          ctx,
          `${renderEntryBlock(check)}\n\nСобираю новый план поверх них — это ещё одна кампания ` +
            'и ещё один дневной бюджет.',
        );
      }

      const outcome = await launchCampaign(clientId, opts);
      if (outcome.kind === 'submitted') {
        await say(ctx, renderPlanSummary(outcome.plan, { dryRun: outcome.dryRun }));
        await say(
          ctx,
          `Карточек на решение: ${outcome.approvals.length}. ` +
            'Каждая — отдельная кампания: можно одобрить одну и отказаться от другой. ' +
            'Пока не нажмёшь ✅, в кабинет не уходит ничего.',
        );
        return;
      }

      if (outcome.kind === 'not_plannable') {
        await say(ctx, `План собрать не получилось: ${outcome.reason}`);
        return;
      }

      await say(ctx, renderEntryBlock(outcome));
    } catch (err) {
      log.error({ clientId, err: describeError(err) }, 'campaign launch failed');
      await say(
        ctx,
        'Не смог собрать план — сломалось на моей стороне. Роман уже знает, попробуй позже.',
      );
    }
  });
}
