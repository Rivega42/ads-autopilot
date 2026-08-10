import type { Provider } from '@prisma/client';

/**
 * Домен AI-Модератора (TZ §13.4).
 *
 * Разделение труда такое же жёсткое, как у планировщика кампаний:
 *  • модель отвечает за формулировки — к какой категории отнести отказ и как переписать;
 *  • код отвечает за факты — вердикт площадки, счётчик попыток, лимиты длины и то,
 *    уйдёт ли текст в живой кабинет.
 *
 * Вердикт площадки в этой связке всегда сильнее мнения модели: если Директ сказал
 * «отклонено», объявление переписывается, даже когда модель считает его безобидным.
 */

export const REJECTION_CATEGORIES = [
  'medicine',
  'finance',
  'superlative',
  'misleading_claims',
  'shocking',
  'adult',
  'alcohol_tobacco',
  'prohibited_goods',
  'trademark',
  'personal_data',
  'formatting',
  'contacts_in_text',
  'landing_mismatch',
  'age_labeling',
  'documents_required',
  'other',
] as const;

export type RejectionCategory = (typeof REJECTION_CATEGORIES)[number];

/** Человекочитаемые названия — уезжают в промпт классификатора и в письмо человеку. */
export const CATEGORY_TITLE: Readonly<Record<RejectionCategory, string>> = {
  medicine: 'медицина, БАДы и медицинские изделия',
  finance: 'финансовые услуги, кредиты и инвестиции',
  superlative: 'превосходная степень и некорректное сравнение',
  misleading_claims: 'недостоверные обещания, гарантии, цены и акции',
  shocking: 'шокирующий контент и давление на страх',
  adult: 'товары и услуги для взрослых',
  alcohol_tobacco: 'алкоголь, табак и никотинсодержащая продукция',
  prohibited_goods: 'товары, реклама которых не допускается',
  trademark: 'чужие товарные знаки и бренды',
  personal_data: 'обращение к личным характеристикам пользователя',
  formatting: 'оформление текста: регистр, знаки, опечатки, длина',
  contacts_in_text: 'контакты и адрес сайта в тексте объявления',
  landing_mismatch: 'несоответствие объявления посадочной странице',
  age_labeling: 'возрастная маркировка и пометка «Реклама»',
  documents_required: 'тематика требует лицензии или гарантийного письма',
  other: 'не удалось отнести к известной категории',
};

/** Откуда взято требование. Правило без источника в базу не попадает. */
export interface RuleSource {
  /** Кто установил требование: закон или площадка. */
  authority: string;
  /** Норма или раздел правил, по которому требование проверяемо. */
  ref: string;
}

export interface ModerationRule {
  id: string;
  category: RejectionCategory;
  channels: readonly Provider[];
  /** Что именно запрещено. Формулировка близко к первоисточнику. */
  requirement: string;
  /** Что сделать с текстом, чтобы претензия снялась. Это читает модель. */
  fix: string;
  source: RuleSource;
  /**
   * Слова из причины отказа, по которым правило подсказывается классификатору.
   * Подсказка, а не решение: категорию всё равно выбирает модель.
   */
  triggers?: readonly RegExp[];
  /**
   * Лексический детектор нарушения в уже готовом тексте. Заводится только там, где
   * нарушение видно по словам без разбора смысла, — иначе автопроверка начнёт
   * браковать нормальные объявления, и переписывание зациклится.
   */
  forbidden?: readonly RegExp[];
}

export interface ClassifiedRejection {
  category: RejectionCategory;
  /** Уверенность модели. В решениях не участвует — только в логе и в письме человеку. */
  confidence: number;
  explanation: string;
  /** Фрагменты объявления, к которым, по мнению модели, есть претензия. */
  fragments: readonly string[];
  /** Правила, отобранные под эту категорию и канал. Уезжают в промпт переписывания. */
  rules: readonly ModerationRule[];
  promptVersion: string;
}

/** Тексты объявления в том виде, в каком их принимает `ChannelAdapter.updateAdText`. */
export interface AdText {
  title: string;
  title2?: string;
  text: string;
}
