import { ChangeActor } from '@prisma/client';

import type { ApprovalAction } from '@/approval/types.js';
import { keepsBidOnAdGroup } from '@/clients/vk-ads/local-state.js';
import { prisma } from '@/db/prisma.js';
import { describeError } from '@/lib/errors.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'approval:bid-journal' });

/**
 * След изменения ставки в той форме, в какой его читает предохранитель.
 *
 * Оконный лимит (`MAX_BID_CHANGE_WINDOW`) считает суммарное движение ставки за окно
 * от якоря — самой ранней записи журнала за это окно. Якорь ищется по четырём полям
 * (`optimizer/bid-history.ts`): тип сущности в верхнем регистре, **наш** id,
 * `action` из BID_DECREASE/BID_INCREASE и `prevValue` вида `{kind:'bid'}`.
 *
 * Аудиторская строка апрува (`apply.ts`) устроена иначе и не может быть устроена
 * так же: она про решение человека — одно действие, сколько бы фраз в него ни
 * входило, — и адресует их внешними id площадки, потому что именно ими оперирует
 * карточка. Ни одно из четырёх полей не совпадает, и якорь по ней не находился: на
 * всём human-in-the-loop пути оконный коридор схлопывался в шаговый, а тот −15%
 * в сутки пропускает сколько угодно раз подряд.
 *
 * Поэтому апрув пишет две вещи, а не одну: «что решил человек» (строка апрува) и
 * «что стало с каждой ставкой» (строки отсюда). Вторые — это те же записи, что
 * оставил бы прямой путь оптимизатора, и появляются они по тем же правилам:
 * только когда изменение действительно дошло до кабинета. В dry-run их нет —
 * иначе якорь считал бы движение, которого на площадке не было.
 *
 * Побочная польза: `rollbackChange` понимает только эту форму, поэтому одобренное
 * человеком изменение ставки теперь можно откатить, а не только прочитать.
 */

type BidChangeAction = Extract<ApprovalAction, { kind: 'bid_change' }>;

/** Тип сущности в терминах решений оптимизатора (`OptimizerEntityType`). */
type BidEntityType = 'KEYWORD' | 'ADGROUP';

interface BidTarget {
  entityType: BidEntityType;
  entityId: string;
  campaignId: string;
}

export interface BidJournalContext {
  approvedBy: string;
  dryRun: boolean;
  /** Ответ адаптера: false означает «менять было нечего», и движения ставки не было. */
  applied: boolean;
}

/**
 * Пишет канонические строки решения для одобренного изменения ставки.
 *
 * Никогда не бросает: ставка в кабинете уже изменена, и провал записи обязан
 * остаться примечанием, а не превратить исход применения в FAILED.
 *
 * @returns текст примечания для человека либо null.
 */
export async function writeBidDecisions(
  action: ApprovalAction,
  ctx: BidJournalContext,
): Promise<string | null> {
  if (action.kind !== 'bid_change' || ctx.dryRun || !ctx.applied) return null;

  try {
    const targets = await resolveTargets(action);
    const rows = action.changes.flatMap((change) => {
      const target = targets.get(change.keywordExternalId);
      // Сущности нет в нашей базе — значит и решения по ней оптимизатор не примет,
      // якорь ей не понадобится. Про сам разъезд человеку говорит `syncLocalEntities`.
      if (!target) return [];
      // Ставка «до» приходит из решения оптимизатора и в карточке есть всегда.
      // Без неё строка не может быть якорем: точки отсчёта в ней нет.
      if (change.bidBefore === undefined || change.bidBefore === change.bid) return [];
      return [
        {
          campaignId: target.campaignId,
          entityType: target.entityType,
          entityId: target.entityId,
          action: change.bid < change.bidBefore ? 'BID_DECREASE' : 'BID_INCREASE',
          prevValue: { kind: 'bid', amount: change.bidBefore },
          newValue: { kind: 'bid', amount: change.bid },
          reason: action.reason,
          // Изменение выпустил человек кнопкой в карточке, а не ночной прогон.
          actor: ChangeActor.USER,
          approvedBy: ctx.approvedBy,
          provider: action.channel,
        },
      ];
    });

    if (rows.length === 0) {
      log.warn(
        { channel: action.channel, changes: action.changes.length },
        'bid change left no decision rows: guardrail anchor will fall back to current bid',
      );
      return null;
    }

    await prisma.changeLog.createMany({ data: rows });
    return null;
  } catch (err) {
    const message = describeError(err);
    log.error({ channel: action.channel, err: message }, 'bid decision journal write failed');
    return (
      `история изменений ставки не записана (${message}): ставка изменена, ` +
      'но суммарный лимит за окно её не увидит'
    );
  }
}

/**
 * Внешние id карточки — в наши строки.
 *
 * Ставка живёт не на одном уровне у всех каналов: у Директа это фраза, у VK —
 * группа объявлений, и `keywordExternalId` там на самом деле id группы. Та же
 * развилка, что в `syncLocalEntities`, и по той же причине.
 *
 * Запрос ограничен парой (клиент, площадка): внешний id уникален в кабинете, но
 * не в нашей таблице, и без ограничения в журнал уехала бы чужая сущность.
 */
async function resolveTargets(action: BidChangeAction): Promise<Map<string, BidTarget>> {
  const externalIds = [...new Set(action.changes.map((c) => c.keywordExternalId))];
  const owner = { clientId: action.clientId, provider: action.channel };
  const out = new Map<string, BidTarget>();

  if (keepsBidOnAdGroup(action.channel)) {
    const groups = await prisma.adGroup.findMany({
      where: { externalId: { in: externalIds }, campaign: owner },
      select: { id: true, externalId: true, campaignId: true },
    });
    for (const group of groups) {
      if (group.externalId === null) continue;
      out.set(group.externalId, {
        entityType: 'ADGROUP',
        entityId: group.id,
        campaignId: group.campaignId,
      });
    }
    return out;
  }

  const keywords = await prisma.keyword.findMany({
    where: { externalId: { in: externalIds }, adGroup: { campaign: owner } },
    select: { id: true, externalId: true, adGroup: { select: { campaignId: true } } },
  });
  for (const keyword of keywords) {
    if (keyword.externalId === null) continue;
    out.set(keyword.externalId, {
      entityType: 'KEYWORD',
      entityId: keyword.id,
      campaignId: keyword.adGroup.campaignId,
    });
  }
  return out;
}
