// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Context = any;
type MiddlewareFn<C> = (ctx: C, next: () => Promise<void>) => Promise<void> | void;

import { env } from '../../env.js';
import { logger } from '../../logger.js';

const adminIds: Set<number> = new Set(
  env.TELEGRAM_ADMIN_IDS.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number),
);

export const adminOnly: MiddlewareFn<Context> = async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId || !adminIds.has(userId)) {
    logger.warn({ userId, username: ctx.from?.username }, 'adminOnly: access denied');
    await ctx.reply('Access denied.').catch(() => undefined);
    return;
  }
  return next();
};
