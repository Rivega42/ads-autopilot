import type { CreativeKind, PrismaClient } from '@prisma/client';

import { describeError } from '@/lib/errors.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'creatives:store' });

/**
 * Запись креативов в БД.
 *
 * Строка `Creative` — это не «архив картинок», а расходный документ: чем именно
 * сгенерировали, каким промптом и за сколько. TZ §13.3 закладывает ~$0.70 на полный
 * набор, и проверить это можно только если `costUsd` заполняется на каждой генерации,
 * включая бесплатные (0) и неизвестные по цене (null).
 */

export type CreativeStore = Pick<PrismaClient, 'creative'>;

/** Значение `Creative.provider` у планов кампаний — чужие строки, их сюда не мешаем. */
export const TEXT_CREATIVE_PROVIDER = 'creatives-texts';

export interface SaveCreativeInput {
  clientId: string;
  kind: CreativeKind;
  /** Кто сгенерировал: имя модели или имя провайдера изображений. */
  provider: string;
  prompt: string;
  payload: unknown;
  /** null — цена неизвестна. Ноль и null — разные вещи, не подменять. */
  costUsd: number | null;
}

/**
 * Сохраняет креатив и возвращает его id.
 *
 * Возвращает null, если запись не удалась: сгенерированный текст (а тем более
 * оплаченная картинка) не должен пропадать из-за недоступной БД. Потеря строки
 * учёта — это предупреждение в отчёте, а не причина выбросить работу.
 */
export async function saveCreative(
  db: CreativeStore,
  input: SaveCreativeInput,
): Promise<string | null> {
  try {
    const row = await db.creative.create({
      data: {
        clientId: input.clientId,
        kind: input.kind,
        provider: input.provider,
        prompt: input.prompt,
        payload: toJson(input.payload),
        costUsd: input.costUsd,
      },
      select: { id: true },
    });
    return row.id;
  } catch (err) {
    log.error(
      { clientId: input.clientId, kind: input.kind, err: describeError(err) },
      'failed to persist Creative',
    );
    return null;
  }
}

/**
 * Приводит payload к тому, что примет Prisma.Json.
 *
 * `JSON.parse(JSON.stringify(...))` не украшение: в payload заходят Map, Date и
 * undefined-поля, а драйвер на них падает уже внутри транзакции.
 */
function toJson(value: unknown): object {
  return JSON.parse(JSON.stringify(value ?? {})) as object;
}
