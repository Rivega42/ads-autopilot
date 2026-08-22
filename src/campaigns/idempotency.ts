import type { PrismaClient } from '@prisma/client';

/**
 * Защита от второй кампании на ретрае (TZ §7).
 *
 * Тонкость, из-за которой обычной проверки «а нет ли уже такой кампании в БД» мало:
 * внешний id присваивает площадка, и только после создания. Между «отправили
 * Campaigns.add» и «записали Campaign в свою БД» процесс может умереть — уникальный
 * индекс `@@unique([provider, externalId])` в этот момент пуст и от второго создания
 * не спасает. Поэтому идентичность операции резервируется ДО обращения к площадке
 * и детерминированно выводится из плана: повтор натыкается на занятый ключ.
 *
 * Три состояния строки:
 *  • нет строки — операция не начиналась;
 *  • строка с `entityId = PENDING_EXTERNAL_ID` — начиналась и не завершилась;
 *  • строка с внешним id — кампания создана, повторять нечего.
 */

export const CAMPAIGN_CREATE_SCOPE = 'campaigns.create';

/** Заглушка до присвоения внешнего id: колонка `entityId` обязательная. */
export const PENDING_EXTERNAL_ID = 'pending';

/**
 * Ключ создания не истекает.
 *
 * Строка отвечает на два разных вопроса, и сроки давности у них разные. «Можно ли
 * повторить отправку прямо сейчас» живёт минуты. «Создавалась ли эта кампания
 * вообще» не имеет срока давности: пока кампания есть в кабинете и тратит деньги,
 * ответ «да» остаётся верным. `checkCampaignEntry` спрашивает именно второе — и
 * отсутствие строки читает как «не создавали».
 *
 * Пока здесь стоял TTL в 90 дней, второй ответ портился в день чистки: крон
 * (src/scheduler/purge.ts, предикат `expiresAt <= now`) удалял строку, кампания
 * января в апреле выглядела нетронутой, план переиспользовался целиком, и нажатие
 * ✅ создавало вторую кампанию с тем же именем и тем же дневным бюджетом. Ни один
 * экран об этом не предупреждал: все они выводят «создано» из этих же строк.
 *
 * Цена решения — две:
 *  • строки этого scope копятся навсегда. Их считанные штуки на клиента (одна на
 *    кампанию плана), и таблицу растит не они, а превью креативов, ради которых
 *    крон и писался;
 *  • незавершённая попытка (`entityId = pending`) блокирует запуск клиента до
 *    разбора человеком, а не до истечения срока. Так и надо: раньше блокировка
 *    снималась молча, и первый же `/launch` после этого создавал вторую кампанию.
 */
export const CAMPAIGN_KEY_NEVER_EXPIRES_AT = '9999-12-31T00:00:00.000Z';

export type IdempotencyStore = Pick<PrismaClient, 'idempotencyKey'>;

export type Reservation =
  | { status: 'reserved' }
  /** Ключ занят. `externalId` — null, если предыдущая попытка не дошла до конца. */
  | { status: 'duplicate'; externalId: string | null };

export interface CampaignIdempotency {
  reserve(key: string): Promise<Reservation>;
  complete(key: string, externalId: string): Promise<void>;
  release(key: string): Promise<void>;
}

/**
 * Ключ операции создания. Детерминированный: те же план и позиция — тот же ключ,
 * поэтому повторный запуск того же плана схлопывается, а новый план — нет.
 */
export function campaignCreateKey(planId: string, campaignIndex: number): string {
  return `${CAMPAIGN_CREATE_SCOPE}:${planId}:${campaignIndex}`;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'P2002'
  );
}

export function createPrismaCampaignIdempotency(db: IdempotencyStore): CampaignIdempotency {
  return {
    async reserve(key: string): Promise<Reservation> {
      try {
        await db.idempotencyKey.create({
          data: {
            key,
            scope: CAMPAIGN_CREATE_SCOPE,
            entityType: 'campaign',
            entityId: PENDING_EXTERNAL_ID,
            expiresAt: new Date(CAMPAIGN_KEY_NEVER_EXPIRES_AT),
          },
        });
        return { status: 'reserved' };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        const row = await db.idempotencyKey.findUnique({
          where: { key },
          select: { entityId: true },
        });
        const externalId = row?.entityId;
        return {
          status: 'duplicate',
          externalId:
            externalId === undefined || externalId === PENDING_EXTERNAL_ID ? null : externalId,
        };
      }
    },

    async complete(key: string, externalId: string): Promise<void> {
      await db.idempotencyKey.update({ where: { key }, data: { entityId: externalId } });
    },

    async release(key: string): Promise<void> {
      // deleteMany, а не delete: освобождение зовут по пути ошибки, и «строки уже нет»
      // там не новость, а нормальный исход.
      await db.idempotencyKey.deleteMany({ where: { key } });
    },
  };
}

/** Реализация в памяти — для тестов и для прогонов без БД. */
export function createInMemoryCampaignIdempotency(): CampaignIdempotency {
  const keys = new Map<string, string | null>();
  return {
    reserve(key: string): Promise<Reservation> {
      if (keys.has(key)) {
        return Promise.resolve({ status: 'duplicate', externalId: keys.get(key) ?? null });
      }
      keys.set(key, null);
      return Promise.resolve({ status: 'reserved' });
    },
    complete(key: string, externalId: string): Promise<void> {
      keys.set(key, externalId);
      return Promise.resolve();
    },
    release(key: string): Promise<void> {
      keys.delete(key);
      return Promise.resolve();
    },
  };
}
