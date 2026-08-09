import type { PrismaClient } from '@prisma/client';

import type { ClientBriefData, ClientBriefDraft } from './brief.schema.js';

import { prisma } from '@/db/prisma.js';
import { logger } from '@/logger.js';

/**
 * Настройка Метрики по итогам интервью.
 *
 * Счётчик и цель — это конфигурация, а не секрет, и живут они в колонках
 * `Client`. Заполнять их некому, кроме онбординга: клиент называет целевое
 * действие именно там. Пока эти колонки пусты, загрузка конверсий из Метрики
 * молча не работает — что и было до сих пор.
 */

const log = logger.child({ scope: 'ai:onboarding:metrika' });

/** Только карточка клиента: бриф правит интервью, конфигурацию — эта функция. */
export type ClientConfigStore = Pick<PrismaClient, 'client'>;

export interface MetrikaBriefConfig {
  /**
   * Номера счётчика бриф не содержит. Он всегда `null`, и это осознанно:
   * подставить сюда чужой счётчик — значит приписать клиенту чужие конверсии,
   * а по ним потом двигаются ставки и бюджеты.
   */
  metrikaCounterId: null;
  metrikaGoalId: number | null;
}

/**
 * Идентификатор цели из брифа.
 *
 * Целей в брифе может быть несколько, а колонка одна. Единственная названная
 * цель — ответ; две разные — вопрос к человеку, а не повод взять первую: выбор
 * цели определяет, что система будет считать заявкой.
 */
export function metrikaConfigFromBrief(brief: ClientBriefData | ClientBriefDraft): {
  config: MetrikaBriefConfig;
  ambiguousGoalIds: number[];
} {
  const ids = [
    ...new Set(
      (brief.conversionGoals ?? [])
        .map((goal) => goal.metrikaGoalId)
        .filter((id): id is number => typeof id === 'number'),
    ),
  ];

  const single = ids.length === 1 ? (ids[0] ?? null) : null;
  return {
    config: { metrikaCounterId: null, metrikaGoalId: single },
    ambiguousGoalIds: ids.length > 1 ? ids : [],
  };
}

/**
 * Переносит то, что бриф знает о цели, в карточку клиента.
 *
 * Возвращает записанную конфигурацию либо `null`, если записывать нечего:
 * пустой апдейт не должен трогать строку и затирать то, что там уже могли
 * проставить руками.
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

  if (config.metrikaGoalId === null) {
    log.info(
      { clientId },
      'brief carries no metrika goal id: metrika conversions stay off for this client',
    );
    return null;
  }

  await db.client.update({
    where: { id: clientId },
    data: { metrikaGoalId: config.metrikaGoalId },
    select: { id: true },
  });

  // Без счётчика цель бесполезна — загрузка требует обоих. Говорим об этом
  // прямо, иначе «цель записана» будет читаться как «конверсии поедут».
  log.info(
    { clientId, metrikaGoalId: config.metrikaGoalId },
    'metrika goal saved from brief; counter id is still missing, set Client.metrikaCounterId',
  );
  return config;
}
