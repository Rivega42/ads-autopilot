import type { Prisma, Provider } from '@prisma/client';

import type {
  ApplyDb,
  IdempotencyStore,
  PlatformWriteRequest,
  PlatformWriteResult,
} from './apply.js';
import type { OptimizerEntityType } from './types.js';

import { buildContext, getAdapter } from '@/channels/registry.js';
import type { ChannelContext, StatLevel, WriteResult } from '@/channels/types.js';
import { prisma } from '@/db/prisma.js';
import { describeError } from '@/lib/errors.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'optimizer.runtime' });

/** Ключи живут дольше суточного цикла, но не вечно — иначе таблица растёт без предела. */
const KEY_TTL_DAYS = 30;

/**
 * Долговременное резервирование через IdempotencyKey.
 *
 * До появления модели в схеме существовала только in-memory версия, и она
 * теряла ключи при перезапуске воркера: тик, упавший после записи в кабинет,
 * применил бы изменение второй раз. Уникальность обеспечивает Postgres, а не
 * проверка «сначала прочитать» — параллельные воркеры иначе оба увидят пусто.
 *
 * `createMany({ skipDuplicates })` вместо `create` в try/catch: это тот же
 * единственный `INSERT`, только с `ON CONFLICT DO NOTHING`, и занятый ключ
 * возвращается счётчиком, а не исключением. Гарантия та же — решает Postgres,
 * — а вот цена разная: на каждый штатный дубль Prisma печатала многострочный
 * дамп `prisma:error` мимо `LOG_LEVEL`, и человек, запустивший `optimize
 * --apply` второй раз за сутки, читал работающую дедупликацию как поломку.
 * Ключ здесь единственный уникальный (он же первичный), поэтому `DO NOTHING`
 * не может проглотить конфликт по другому полю.
 */
export function createPrismaIdempotencyStore(
  db: Pick<typeof prisma, 'idempotencyKey'> = prisma,
): IdempotencyStore {
  return {
    async reserve(key: string): Promise<'reserved' | 'duplicate'> {
      const { count } = await db.idempotencyKey.createMany({
        data: [
          {
            key,
            scope: 'optimizer',
            entityType: '',
            entityId: '',
            expiresAt: new Date(Date.now() + KEY_TTL_DAYS * 24 * 60 * 60 * 1000),
          },
        ],
        skipDuplicates: true,
      });
      return count === 1 ? 'reserved' : 'duplicate';
    },
    async release(key: string): Promise<void> {
      await db.idempotencyKey.deleteMany({ where: { key } });
    },
  };
}

/**
 * Ответ адаптера в терминах apply.ts.
 *
 * `applied: false` вне dry-run — это не «пропущено», а «менять было нечего»:
 * так отвечает, например, добавление минус-слова, которое уже есть в кампании.
 * Считать это применением значило бы писать в ChangeLog изменение, которого не было.
 */
export function fromWriteResult(res: WriteResult, ctx: ChannelContext): PlatformWriteResult {
  if (res.applied) return { status: 'applied' };
  if (ctx.dryRun) return { status: 'skipped', reason: 'dry-run' };
  return { status: 'noop', reason: 'площадке нечего было менять' };
}

const LEVEL_BY_ENTITY: Record<OptimizerEntityType, StatLevel> = {
  CAMPAIGN: 'campaign',
  ADGROUP: 'adgroup',
  AD: 'ad',
  KEYWORD: 'keyword',
};

/**
 * Единственный мост от оптимизатора к рекламным площадкам.
 *
 * Работает по внутренним идентификаторам, поэтому сначала переводит их во
 * внешние: решения принимаются по строкам нашей БД, а площадка знает только
 * свои id. Сущность без внешнего id пропускается, а не отправляется с пустым
 * значением — так изменение теряется явно и попадает в отчёт.
 */
export function createPlatformWriter(): (
  req: PlatformWriteRequest,
) => Promise<PlatformWriteResult> {
  return async (req: PlatformWriteRequest): Promise<PlatformWriteResult> => {
    const target = await resolveTarget(req.entityType, req.entityId);
    if (!target) {
      return { status: 'skipped', reason: 'нет внешнего идентификатора' };
    }

    const adapter = getAdapter(target.provider);
    const ctx = await buildContext(target.clientId, target.provider, {
      access: { actor: 'optimizer' },
    });
    const level = LEVEL_BY_ENTITY[req.entityType];

    try {
      switch (req.action) {
        case 'PAUSE': {
          return fromWriteResult(await adapter.pauseEntities(ctx, level, [target.externalId]), ctx);
        }
        case 'BID_DECREASE':
        case 'BID_INCREASE': {
          if (req.nextValue.kind !== 'bid') {
            return { status: 'failed', reason: `ожидалась ставка, получено ${req.nextValue.kind}` };
          }
          const res = await adapter.setBids(ctx, [
            { keywordExternalId: target.externalId, bid: req.nextValue.amount },
          ]);
          return fromWriteResult(res, ctx);
        }
        case 'BUDGET_CHANGE': {
          if (req.nextValue.kind !== 'budget') {
            return { status: 'failed', reason: `ожидался бюджет, получено ${req.nextValue.kind}` };
          }
          const res = await adapter.setBudgets(ctx, [
            { campaignExternalId: target.externalId, dailyBudget: req.nextValue.amount },
          ]);
          return fromWriteResult(res, ctx);
        }
        case 'ADD_NEGATIVE_KEYWORD': {
          if (!adapter.addNegativeKeywords) {
            return { status: 'skipped', reason: 'канал не поддерживает минус-слова' };
          }
          if (req.nextValue.kind !== 'negativeKeyword') {
            return { status: 'failed', reason: `ожидалась фраза, получено ${req.nextValue.kind}` };
          }
          const campaign = await campaignExternalIdForAdGroup(req.entityId);
          if (!campaign) return { status: 'skipped', reason: 'кампания без внешнего id' };
          const res = await adapter.addNegativeKeywords(ctx, campaign, [req.nextValue.phrase]);
          return fromWriteResult(res, ctx);
        }
        default:
          return { status: 'skipped', reason: `действие ${req.action} не поддержано площадкой` };
      }
    } catch (err) {
      log.error(
        { action: req.action, entityId: req.entityId, err: describeError(err) },
        'platform write failed',
      );
      return { status: 'failed', reason: describeError(err) };
    }
  };
}

interface ResolvedTarget {
  clientId: string;
  provider: Provider;
  externalId: string;
}

async function resolveTarget(
  entityType: OptimizerEntityType,
  entityId: string,
): Promise<ResolvedTarget | null> {
  switch (entityType) {
    case 'CAMPAIGN': {
      const row = await prisma.campaign.findUnique({
        where: { id: entityId },
        select: { clientId: true, provider: true, externalId: true },
      });
      return row?.externalId
        ? { clientId: row.clientId, provider: row.provider, externalId: row.externalId }
        : null;
    }
    case 'ADGROUP': {
      const row = await prisma.adGroup.findUnique({
        where: { id: entityId },
        select: { externalId: true, campaign: { select: { clientId: true, provider: true } } },
      });
      return row?.externalId
        ? {
            clientId: row.campaign.clientId,
            provider: row.campaign.provider,
            externalId: row.externalId,
          }
        : null;
    }
    case 'AD': {
      const row = await prisma.ad.findUnique({
        where: { id: entityId },
        select: {
          externalId: true,
          adGroup: { select: { campaign: { select: { clientId: true, provider: true } } } },
        },
      });
      return row?.externalId
        ? {
            clientId: row.adGroup.campaign.clientId,
            provider: row.adGroup.campaign.provider,
            externalId: row.externalId,
          }
        : null;
    }
    case 'KEYWORD': {
      const row = await prisma.keyword.findUnique({
        where: { id: entityId },
        select: {
          externalId: true,
          adGroup: { select: { campaign: { select: { clientId: true, provider: true } } } },
        },
      });
      return row?.externalId
        ? {
            clientId: row.adGroup.campaign.clientId,
            provider: row.adGroup.campaign.provider,
            externalId: row.externalId,
          }
        : null;
    }
  }
}

async function campaignExternalIdForAdGroup(adGroupId: string): Promise<string | null> {
  const row = await prisma.adGroup.findUnique({
    where: { id: adGroupId },
    select: { campaign: { select: { externalId: true } } },
  });
  return row?.campaign.externalId ?? null;
}

/**
 * Адаптер узкого порта ApplyDb к Prisma.
 *
 * Комментарий в apply.ts утверждает, что PrismaClient удовлетворяет порту
 * структурно. Это неверно: у делегата Prisma перегрузки шире, а `prevValue`
 * в порту объявлен как `unknown` против `InputJsonValue`. Прямая передача
 * клиента не компилируется, поэтому переход сделан явным здесь, а не
 * приведением типа в месте вызова — так видно, где именно формы расходятся.
 */
export function createApplyDb(db: Pick<typeof prisma, 'changeLog'> = prisma): ApplyDb {
  return {
    changeLog: {
      async create({ data }) {
        return db.changeLog.create({
          data: {
            campaignId: data.campaignId,
            entityType: data.entityType,
            entityId: data.entityId,
            action: data.action,
            prevValue: data.prevValue as Prisma.InputJsonValue,
            newValue: data.newValue as Prisma.InputJsonValue,
            reason: data.reason,
            actor: data.actor,
          },
        });
      },
      async findUnique({ where }) {
        return db.changeLog.findUnique({ where });
      },
      async update({ where, data }) {
        return db.changeLog.update({ where, data });
      },
    },
  };
}
