import { CRON_SCHEDULE, cronIntervalMinutes, QUEUE_NAMES } from '@/scheduler/schedule.js';

/**
 * Период крона `check-moderation` — единственные часы этого модуля.
 *
 * Модерация целиком живёт тиками: срок зависшего захвата (`poll.ts`) и отступ после
 * упавшей починки (`repair.ts`) измеряются в них же. Период считается из самого
 * расписания, а не записан числом рядом: отдельная константа разъезжается с кроном
 * при первой же его правке, и разъезжается молча.
 *
 * Отдельный модуль, а не поле в `poll.ts` или `repair.ts`: обоим нужно одно и то же,
 * а импорт друг у друга завязал бы их в кольцо.
 */
export const MODERATION_TICK_MINUTES = cronIntervalMinutes(
  CRON_SCHEDULE[QUEUE_NAMES.checkModeration],
);

export const MODERATION_TICK_MS = MODERATION_TICK_MINUTES * 60_000;
