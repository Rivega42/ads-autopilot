/** Типы описания рекламного аккаунта Яндекс Директа (ЕПК, режим эксперта). */

export type PlacementType = 'search' | 'network' | 'search_and_network' | 'retargeting';

export type StrategyType =
  | 'max_clicks_weekly_budget'
  | 'max_clicks_manual_bids'
  | 'max_conversions_cpa'
  | 'max_conversions_pay_per_conversion';

export interface Sitelink {
  readonly title: string;
  readonly description: string;
  readonly url: string;
}

export interface VCard {
  readonly company: string;
  readonly city: string;
  readonly street: string;
  readonly phone: string;
  readonly email: string;
  readonly workingHours: string;
  readonly mapsUrl: string;
}

export interface AdBlueprint {
  /** Комбинаторное объявление: до 5 заголовков, Директ сам подбирает связку. */
  readonly titles: readonly string[];
  readonly title2s: readonly string[];
  readonly texts: readonly string[];
  readonly displayLink: string;
  readonly landingPath: string;
}

export interface AdGroupBlueprint {
  readonly name: string;
  readonly keywords: readonly string[];
  /** Минус-фразы уровня группы: отсекают пересечения с соседними группами. */
  readonly negativeKeywords: readonly string[];
  readonly ad: AdBlueprint;
  readonly note?: string;
}

/**
 * Корректировка ставки. `percent` — множитель в процентах, как его понимает
 * Директ: 60 означает «платить 60% от ставки», то есть −40%; 0 — не показывать.
 */
export interface BidModifierBlueprint {
  readonly kind: 'region' | 'mobile' | 'age';
  readonly percent: number;
  /** Для kind: 'region' — имя региона из того же справочника, что и таргетинг. */
  readonly region?: string;
  /** Для kind: 'age' — возрастная группа Директа. */
  readonly age?: 'AGE_0_17' | 'AGE_18_24' | 'AGE_25_34' | 'AGE_35_44' | 'AGE_45_54' | 'AGE_55';
  readonly note: string;
}

export interface CampaignBlueprint {
  readonly name: string;
  readonly placement: PlacementType;
  readonly strategy: StrategyType;
  /** Недельный бюджет в рублях для стартового сценария 60 000 ₽/мес. */
  readonly weeklyBudgetRub: number;
  readonly regions: readonly string[];
  readonly negativeKeywords: readonly string[];
  readonly groups: readonly AdGroupBlueprint[];
  readonly bidModifiers?: readonly BidModifierBlueprint[];
  /** 1 — запускаем в первый день, 3 — когда появятся данные и свободный бюджет. */
  readonly priority: 1 | 2 | 3;
  readonly startPaused?: boolean;
  readonly note: string;
}

export interface AccountBlueprint {
  readonly site: string;
  readonly vcard: VCard;
  readonly sitelinks: readonly Sitelink[];
  readonly callouts: readonly string[];
  readonly globalNegativeKeywords: readonly string[];
  readonly campaigns: readonly CampaignBlueprint[];
}
