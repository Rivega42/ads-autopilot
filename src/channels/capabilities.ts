import { Provider } from '@prisma/client';

import type { StatLevel } from './types.js';

/**
 * Что канал доводит до кабинета — объявлением, а не догадкой.
 *
 * Зачем отдельная таблица, если есть сами адаптеры. Карточку апрува выпускает один
 * процесс (воркер оптимизатора), а нажатие ✅ применяет другой (бот), и между ними
 * проходит до APPROVAL_TTL_MINUTES. Реестр адаптеров (`registry.ts`) отвечает только
 * за свой процесс: «адаптер зарегистрирован здесь» ничего не обещает про того, кто
 * будет применять. Отказ же обязан случиться ДО человека — значит, спрашивать надо
 * то, что верно в любом процессе, то есть объявление в коде.
 *
 * Спросить сам адаптер тоже нельзя: наличие метода видно (`addNegativeKeywords`), а
 * поддержка уровня (`pause_entities` с level=keyword) — нет, её знает только тело
 * метода, и «спросить» его значит выполнить. Поэтому знание вынесено сюда, а
 * `src/approval/supported.test.ts` каждый прогон сверяет таблицу с настоящими
 * адаптерами по всем парам «вид действия × канал»: разъехаться молча она не может.
 *
 * Таблица покрывает все члены `Provider`, а не только те, у кого есть адаптер:
 * канал без адаптера не умеет ничего, и карточка для него — это заявка, которую
 * некому применить.
 */

export interface ChannelCapabilities {
  /** Уровни, на которых канал умеет pause/resume. Пустой список — не умеет вовсе. */
  readonly suspendableLevels: readonly StatLevel[];
  /** Ставка (`setBids`) — на том уровне, который для канала естественен. */
  readonly bids: boolean;
  /** Дневной бюджет кампании (`setBudgets`). */
  readonly budgets: boolean;
  /** Минус-слова на уровне кампании (`addNegativeKeywords`). */
  readonly negativeKeywords: boolean;
  /**
   * Создание кампании целиком. Не из `ChannelAdapter`: создание живёт в
   * `CampaignWriter` (src/campaigns/writer.ts), и умеет его пока только Директ.
   */
  readonly createCampaign: boolean;
}

/** Канал, до которого у системы нет пути: ни адаптера, ни writer'а. */
const NOTHING: ChannelCapabilities = {
  suspendableLevels: [],
  bids: false,
  budgets: false,
  negativeKeywords: false,
  createCampaign: false,
};

export const CHANNEL_CAPABILITIES: Readonly<Record<Provider, ChannelCapabilities>> = {
  [Provider.YANDEX_DIRECT]: {
    // Групп в этом списке нет: `AdGroups` в API v5 не имеет suspend/resume,
    // останавливают объявления или фразы (см. SUSPENDABLE в адаптере Директа).
    suspendableLevels: ['campaign', 'ad', 'keyword'],
    bids: true,
    budgets: true,
    negativeKeywords: true,
    createCampaign: true,
  },
  [Provider.VK_ADS]: {
    // Уровня фраз у VK нет вовсе: показы покупаются аудиториями.
    suspendableLevels: ['campaign', 'adgroup', 'ad'],
    // Ставка живёт на группе; карточка адресует её тем же полем, что и фразу Директа.
    bids: true,
    budgets: true,
    // По той же причине, по которой нет фраз, нет и минус-слов.
    negativeKeywords: false,
    // `CampaignWriter` для VK не написан — план в кабинет VK залить нечем.
    createCampaign: false,
  },
  [Provider.TIKTOK_ADS]: NOTHING,
  [Provider.LINKEDIN_ADS]: NOTHING,
  [Provider.META_ADS]: NOTHING,
  [Provider.GOOGLE_ADS]: NOTHING,
  [Provider.TELEGRAM_ADS]: NOTHING,
};

export function channelCapabilities(channel: Provider): ChannelCapabilities {
  return CHANNEL_CAPABILITIES[channel];
}
