/**
 * Провайдеро-независимые типы LLM-ядра.
 *
 * Смысл абстракции ровно тот же, что у ChannelAdapter: восемь AI-агентов из TZ §13
 * (онбординг, стратег, креативы, модератор, оптимизатор, аналитик, разведка, wordstat)
 * не должны знать, что у Anthropic ответ лежит в content[].text, а у DeepSeek —
 * в choices[0].message.content, и тем более не должны хардкодить имя модели.
 */

export type LlmProviderName = 'anthropic' | 'openai' | 'deepseek';

/** Уровень усилий (Anthropic output_config.effort). Поддерживают не все модели — см. ModelRef. */
export type LlmEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Вид работы, а не модель. Вызывающий код говорит «это классификация» или
 * «это недельный разбор», а таблица TASK_MODELS решает, чем это считать.
 * Так цена задачи меняется в одном месте, а не в восьми агентах.
 */
export type LlmTask =
  | 'onboarding.interview'
  | 'strategy.plan'
  | 'strategy.recon'
  | 'creatives.texts'
  | 'moderation.classify'
  | 'moderation.rewrite'
  | 'optimizer.decide'
  | 'analytics.weekly'
  | 'analytics.daily'
  | 'keywords.expand'
  | 'keywords.classify'
  | 'leads.followup';

/**
 * Полный «адрес» модели. Возможности (effort, adaptive thinking) заданы явно,
 * а не выведены из имени: список поддерживающих их моделей меняется каждый релиз,
 * и угадывание по подстроке имени — источник 400-х.
 */
export interface ModelRef {
  provider: LlmProviderName;
  /** Строка ровно в том виде, в каком её ждёт API провайдера. */
  model: string;
  /** Потолок ответа по умолчанию для этой задачи. */
  maxTokens: number;
  /** Отправлять output_config.effort. Не поддерживается Haiku 4.5 — там будет 400. */
  effort?: LlmEffort;
  /** Отправлять thinking:{type:'adaptive'}. Только модели 4.6+; на Haiku 4.5 — 400. */
  adaptiveThinking?: boolean;
}

/**
 * Единственная таблица маршрутизации «задача → модель».
 *
 * Принцип: массовая дешёвая работа (классификация отказов модерации, генерация
 * 200 формулировок ключей) уходит на deepseek-v4-flash — она в ~35 раз дешевле
 * Opus по входу; диалог и копирайтинг — на Sonnet 5; решения, которые двигают
 * деньги клиента (ставки, бюджеты, стратегия, недельный разбор) — на Opus 5.
 * Дешевить на оптимизаторе бессмысленно: одна плохая рекомендация стоит дороже,
 * чем месяц разницы в цене токенов.
 */
export const TASK_MODELS: Readonly<Record<LlmTask, ModelRef>> = {
  // Живой диалог в TG: много коротких ходов, нужна лёгкость и скорость, не глубина.
  'onboarding.interview': {
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    maxTokens: 4_000,
    effort: 'medium',
    adaptiveThinking: true,
  },
  // Разбор ниши и раскладка бюджета по каналам — самый тяжёлый reasoning в проекте.
  'strategy.plan': {
    provider: 'anthropic',
    model: 'claude-opus-5',
    maxTokens: 8_000,
    effort: 'high',
    adaptiveThinking: true,
  },
  // Еженедельный срез конкурентов: много текста лендингов на вход, нужен разбор.
  'strategy.recon': {
    provider: 'anthropic',
    model: 'claude-opus-5',
    maxTokens: 8_000,
    effort: 'medium',
    adaptiveThinking: true,
  },
  // Копирайтинг под жёсткие лимиты Директа (33/81) — Sonnet справляется.
  'creatives.texts': {
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    maxTokens: 4_000,
    effort: 'medium',
    adaptiveThinking: true,
  },
  // Классификация причины отклонения в одну из ~10 категорий: массово и дёшево.
  'moderation.classify': {
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    maxTokens: 1_000,
  },
  // Переписывание объявления под правила площадки — тут нужна аккуратность.
  'moderation.rewrite': {
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    maxTokens: 2_000,
    effort: 'medium',
    adaptiveThinking: true,
  },
  // Ставки и бюджеты. Самая дорогая ошибка в системе — берём сильнейшую модель.
  'optimizer.decide': {
    provider: 'anthropic',
    model: 'claude-opus-5',
    maxTokens: 8_000,
    effort: 'high',
    adaptiveThinking: true,
  },
  'analytics.weekly': {
    provider: 'anthropic',
    model: 'claude-opus-5',
    maxTokens: 8_000,
    effort: 'high',
    adaptiveThinking: true,
  },
  // Дневная сводка — шаблонный пересказ цифр, Haiku хватает.
  // effort/thinking не задаём: Haiku 4.5 их не принимает.
  'analytics.daily': {
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    maxTokens: 2_000,
  },
  // 200 формулировок из seed-фразы: объём большой, интеллекта нужно немного.
  'keywords.expand': {
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    maxTokens: 8_000,
  },
  'keywords.classify': {
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    maxTokens: 4_000,
  },
  // Ответ лиду за 5 минут: важна латентность, а не глубина.
  'leads.followup': {
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    maxTokens: 1_000,
  },
};

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  model: ModelRef;
  /** Системный промпт. У OpenAI-совместимых уедет первым сообщением с role:'system'. */
  system?: string;
  messages: LlmMessage[];
  /** Переопределяет ModelRef.maxTokens. */
  maxTokens?: number;
  /**
   * Anthropic-модели 4.7+ отвергают sampling-параметры, поэтому провайдер Anthropic
   * это поле игнорирует. Оставлено ради OpenAI-совместимых, где оно ещё работает.
   */
  temperature?: number;
  /** Просим у провайдера JSON-режим, если он умеет. Ставится structured.ts. */
  json?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface LlmUsage {
  tokensIn: number;
  tokensOut: number;
}

export interface LlmResponse {
  text: string;
  usage: LlmUsage;
  provider: LlmProviderName;
  /** Модель, которая реально ответила (может отличаться от запрошенной). */
  model: string;
  stopReason?: string;
}

export interface LlmProvider {
  readonly name: LlmProviderName;
  /** Есть ли ключ. Проверяется в момент вызова, не при импорте: .env может подгрузиться позже. */
  isConfigured(): boolean;
  /** Бросает LlmConfigError, если ключа нет. Никаких подмен провайдера. */
  complete(req: LlmRequest): Promise<LlmResponse>;
}

/** Сколько токенов приходится на «символ» в грубой оценке. Только для логов и предупреждений. */
export const ROUGH_CHARS_PER_TOKEN = 4;
