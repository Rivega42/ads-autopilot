import { ModerationStatus, type Provider } from '@prisma/client';

import type { ChannelAdapter, ChannelContext, RemoteAd } from '@/channels/types.js';
import { toModerationStatus } from '@/ingestion/mapping.js';
import type { ModerationDb } from '@/moderation/deps.js';
import type { AdText } from '@/moderation/types.js';

/**
 * Шаг 1 из TZ §13.4: опрос статусов модерации по кабинетам.
 *
 * Почему отдельно от почасовой загрузки сущностей: `check-moderation` ходит раз в
 * полчаса и читает ровно два поля, а `runIngestion` тянет кампании, группы, ставки
 * и статистику. Смысл мэппинга статусов при этом один и тот же, поэтому
 * `toModerationStatus` берётся оттуда, а не переписывается заново: разойдись эти две
 * таблицы, и «ACCEPTED» стал бы значить в модерации не то, что в отчётах.
 */

export interface ModerationTarget {
  clientId: string;
  provider: Provider;
}

/** Отклонённое объявление вместе со всем, что нужно для переписывания. */
export interface RejectedAd {
  id: string;
  externalId: string;
  campaignId: string;
  campaignName: string;
  /** Сколько раз это объявление уже переписывалось. */
  retries: number;
  /** Причина отказа дословно от площадки. */
  reason: string;
  /** Тексты с площадки, а не из нашей БД: там актуальная версия, которую и отклонили. */
  ad: AdText;
}

export interface PollResult {
  polled: number;
  /** Строк, у которых статус или причина реально изменились. */
  updated: number;
  /** Объявления кабинета, которых нет в нашей БД: их заведёт ingestion. */
  orphaned: number;
  rejected: RejectedAd[];
}

interface LocalAd {
  id: string;
  adGroupId: string;
  externalId: string;
  moderationStatus: ModerationStatus;
  moderationReason: string | null;
  moderationRetries: number;
}

interface LocalGroup {
  id: string;
  externalId: string;
  campaignId: string;
  campaign: { name: string };
}

function key(adGroupId: string, externalId: string): string {
  // Разделитель — NUL: он не может встретиться ни в cuid, ни во внешнем id площадки.
  return `${adGroupId}\u0000${externalId}`;
}

function remoteText(ad: RemoteAd): AdText {
  const text: AdText = { title: ad.title, text: ad.text };
  if (ad.title2) text.title2 = ad.title2;
  return text;
}

/**
 * Обходит объявления одного кабинета и приводит `Ad.moderationStatus` к тому,
 * что говорит площадка.
 *
 * Прогон идемпотентен и безопасен при наложении на самого себя: все записи —
 * `updateMany` с условием на текущее состояние, а строки в статусе `REWRITING`
 * не трогаются вовсе. `REWRITING` означает «прямо сейчас другой прогон отправляет
 * туда новый текст»; перезаписать его вердиктом, полученным до отправки, — значит
 * потерять факт отправки и переписать объявление второй раз.
 */
export async function pollAdModeration(
  db: ModerationDb,
  target: ModerationTarget,
  ctx: ChannelContext,
  adapter: ChannelAdapter,
): Promise<PollResult> {
  const result: PollResult = { polled: 0, updated: 0, orphaned: 0, rejected: [] };

  const groups: LocalGroup[] = await db.adGroup.findMany({
    where: { campaign: { clientId: target.clientId, provider: target.provider } },
    select: {
      id: true,
      externalId: true,
      campaignId: true,
      campaign: { select: { name: true } },
    },
  });
  if (groups.length === 0) return result;

  const groupByExternalId = new Map(groups.map((group) => [group.externalId, group]));

  const locals: LocalAd[] = await db.ad.findMany({
    where: { adGroupId: { in: groups.map((group) => group.id) } },
    select: {
      id: true,
      adGroupId: true,
      externalId: true,
      moderationStatus: true,
      moderationReason: true,
      moderationRetries: true,
    },
  });
  const localByKey = new Map(locals.map((ad) => [key(ad.adGroupId, ad.externalId), ad]));

  const remote = await adapter.listAds(ctx, [...groupByExternalId.keys()]);

  for (const ad of remote) {
    const group = groupByExternalId.get(ad.adGroupExternalId);
    if (!group) {
      result.orphaned += 1;
      continue;
    }
    const local = localByKey.get(key(group.id, ad.externalId));
    if (!local) {
      result.orphaned += 1;
      continue;
    }

    result.polled += 1;
    if (local.moderationStatus === ModerationStatus.REWRITING) continue;

    const status = toModerationStatus(ad.moderationStatus);
    const reason = ad.moderationReason ?? null;

    if (status !== local.moderationStatus || reason !== local.moderationReason) {
      const written = await db.ad.updateMany({
        where: { id: local.id, moderationStatus: { not: ModerationStatus.REWRITING } },
        data: {
          moderationStatus: status,
          moderationReason: reason,
          // Объявление приняли — прошлые отказы больше не в счёт, и следующая
          // правка текста снова получит все три попытки.
          ...(status === ModerationStatus.APPROVED ? { moderationRetries: 0 } : {}),
        },
      });
      if (written.count > 0) result.updated += 1;
    }

    if (status !== ModerationStatus.REJECTED) continue;

    result.rejected.push({
      id: local.id,
      externalId: ad.externalId,
      campaignId: group.campaignId,
      campaignName: group.campaign.name,
      retries: local.moderationRetries,
      reason: reason ?? '',
      ad: remoteText(ad),
    });
  }

  return result;
}
