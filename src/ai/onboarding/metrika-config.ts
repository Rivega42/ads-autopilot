import type { PrismaClient } from '@prisma/client';

import type { ClientBriefData, ClientBriefDraft, MetrikaAttribution } from './brief.schema.js';

import { prisma } from '@/db/prisma.js';
import { logger } from '@/logger.js';

/**
 * Настройка Метрики по итогам интервью.
 *
 * Счётчик, цель и модель атрибуции — это конфигурация, а не секрет, и живут они
 * в колонках `Client`. Заполнять их некому, кроме онбординга: клиент называет и
 * счётчик, и целевое действие именно там. Пока колонки пусты, загрузка конверсий
 * из Метрики молча не работает — что и было до сих пор.
 */

const log = logger.child({ scope: 'ai:onboarding:metrika' });

/** Только карточка клиента: бриф правит интервью, конфигурацию — эта функция. */
export type ClientConfigStore = Pick<PrismaClient, 'client'>;

export interface MetrikaBriefConfig {
  metrikaCounterId: number | null;
  metrikaGoalId: number | null;
  metrikaAttribution: MetrikaAttribution | null;
}

/** Колонки `Client` в том виде, в каком их принимает Prisma: без `null`-затирания. */
export type MetrikaConfigPatch = Partial<{
  metrikaCounterId: number;
  metrikaGoalId: number;
  metrikaAttribution: MetrikaAttribution;
}>;

/**
 * Конфигурация Метрики из брифа.
 *
 * Цель ищется в двух местах, и порядок здесь важен. Названная в блоке Метрики —
 * прямой ответ на вопрос «что считаем заявкой», она и побеждает. Иначе годится
 * единственный id из целевых действий; две разные цели — вопрос к человеку, а не
 * повод взять первую: выбор цели определяет, что система будет считать заявкой.
 *
 * `metrika: null` — клиент сказал, что Метрики нет. Тогда id из целевых действий
 * не спасение, а чужая цифра: конфигурация остаётся пустой.
 */
export function metrikaConfigFromBrief(brief: ClientBriefData | ClientBriefDraft): {
  config: MetrikaBriefConfig;
  ambiguousGoalIds: number[];
} {
  const empty: MetrikaBriefConfig = {
    metrikaCounterId: null,
    metrikaGoalId: null,
    metrikaAttribution: null,
  };

  if (brief.metrika === null) return { config: empty, ambiguousGoalIds: [] };

  const named = brief.metrika?.goalId ?? null;
  const fromGoals = [
    ...new Set(
      (brief.conversionGoals ?? [])
        .map((goal) => goal.metrikaGoalId)
        .filter((id): id is number => typeof id === 'number'),
    ),
  ];
  const ambiguous = named === null && fromGoals.length > 1;

  return {
    config: {
      metrikaCounterId: brief.metrika?.counterId ?? null,
      metrikaGoalId: named ?? (fromGoals.length === 1 ? (fromGoals[0] ?? null) : null),
      metrikaAttribution: brief.metrika?.attribution ?? null,
    },
    ambiguousGoalIds: ambiguous ? fromGoals : [],
  };
}

/** Апдейт из известного: колонка, про которую бриф молчит, не должна обнуляться. */
export function metrikaConfigPatch(config: MetrikaBriefConfig): MetrikaConfigPatch {
  const patch: MetrikaConfigPatch = {};
  if (config.metrikaCounterId !== null) patch.metrikaCounterId = config.metrikaCounterId;
  if (config.metrikaGoalId !== null) patch.metrikaGoalId = config.metrikaGoalId;
  if (config.metrikaAttribution !== null) patch.metrikaAttribution = config.metrikaAttribution;
  return patch;
}

/**
 * Переносит настройку Метрики из брифа в карточку клиента.
 *
 * Возвращает записанную конфигурацию либо `null`, если записывать нечего: пустой
 * апдейт не должен трогать строку и затирать то, что там уже могли проставить
 * руками. «Метрики нет» — тоже этот путь, и это штатный исход, а не отказ.
 */
export async function saveMetrikaConfig(
  clientId: string,
  brief: ClientBriefData | ClientBriefDraft,
  db: ClientConfigStore = prisma,
): Promise<MetrikaBriefConfig | null> {
  const { config, ambiguousGoalIds } = metrikaConfigFromBrief(brief);

  if (ambiguousGoalIds.length > 0) {
    log.warn(
      { clientId, goalIds: ambiguousGoalIds },
      'brief names several metrika goals: a human must pick the one that counts as a lead',
    );
  }

  const patch = metrikaConfigPatch(config);
  if (Object.keys(patch).length === 0) {
    log.info(
      { clientId },
      'brief carries no metrika config: metrika conversions stay off for this client',
    );
    return null;
  }

  await db.client.update({ where: { id: clientId }, data: patch, select: { id: true } });

  if (config.metrikaCounterId === null || config.metrikaGoalId === null) {
    // Загрузка требует и счётчика, и цели. Без этой строки «настройка записана»
    // читалось бы как «конверсии поедут».
    log.warn(
      { clientId, ...config },
      'metrika config from the brief is incomplete: conversions stay off until both ' +
        'Client.metrikaCounterId and Client.metrikaGoalId are set',
    );
  } else {
    log.info({ clientId, ...config }, 'metrika config saved from the brief');
  }

  return config;
}
