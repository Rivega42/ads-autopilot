import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { plannerStubs, seedCampaignClient, structureOf } from './support/campaign-create-seed.js';
import { runCli } from './support/cli-process.js';
import { resetDatabase } from './support/database.js';

import type { ClientBriefData } from '@/ai/onboarding/brief.schema.js';
import { setMessenger } from '@/approval/telegram.js';
import { checkCampaignEntry, launchCampaign } from '@/campaigns/index.js';
import { prisma } from '@/db/prisma.js';

/**
 * Код возврата проверочного прогона, когда не доставлена ни одна карточка.
 *
 * Ненулевой код на недоставке был добавлен для состояния `awaiting_decision`, но
 * вход возвращает его, только пока жива хотя бы одна карточка: при полном отказе
 * доставки `actionable.length === 0`, и состояние снова `ready`. То есть дешёвый
 * прогон без `--apply` — тот самый, которым ходят по клиентам скриптом, —
 * отчитывался «готов к запуску» ровно в том случае, ради которого код возврата и
 * правился.
 *
 * Живого здесь: наша БД и наш код. Транспорт Telegram не задан вовсе, поэтому
 * карточки не доставляются по той же причине, что и в проде без токена, а
 * площадку никто не зовёт — создание кампании происходит только по нажатию.
 */

const LANDING = 'https://example.com/kursy';

function briefOf(): ClientBriefData {
  return {
    product: 'Курсы английского для скрипта',
    audience: { description: 'Разработчики 25-40 лет', ageFrom: 25, ageTo: 40 },
    geo: ['Москва'],
    negativeCities: [],
    usp: ['IT-лексика'],
    targetCpaRub: 2_000,
    dailyBudgetRub: 500,
    budgetScope: 'per_channel',
    competitors: [{ name: 'Skyeng' }],
    conversionGoals: [{ name: 'заявка с формы' }],
    metrika: null,
    landingUrl: LANDING,
  };
}

describe('campaign без --apply: ни одной доставленной карточки', () => {
  let clientId = '';
  let checkKind = '';

  beforeAll(async () => {
    await resetDatabase();
    // Транспорта нет: `getMessenger()` откажет ровно там же, где отказывает
    // прод без TELEGRAM_BOT_TOKEN.
    setMessenger(null);

    clientId = await seedCampaignClient({
      tgUserId: 900000001n,
      name: 'Клиент без телеграма',
      token: 'cli-exit-token',
      brief: briefOf(),
    });

    const stubs = plannerStubs(structureOf(1, 3));
    const built = await launchCampaign(clientId, {
      plan: { runStructure: stubs.runStructure, runTexts: stubs.runTexts },
    });
    if (built.kind !== 'submitted') throw new Error(`план не собрался: ${built.kind}`);
    expect(built.approvals.length).toBeGreaterThan(0);
    expect(built.approvals.every((a) => a.error !== null)).toBe(true);

    checkKind = (await checkCampaignEntry(clientId)).kind;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('вход не называет ожиданием решения то, чего нет в чате', () => {
    // Это поведение верное и остаётся: «реши по карточкам» про карточки, которых
    // человек не видит, было бы враньём. Проблема была в коде возврата.
    expect(checkKind).toBe('ready');
  });

  it('заявки живы, но ни одна не доставлена — иначе проверять нечего', async () => {
    const rows = await prisma.pendingApproval.findMany({
      where: { clientId },
      select: { error: true },
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.error !== null)).toBe(true);
  });

  it('скрипт видит отказ: код возврата ненулевой и причина названа', async () => {
    const result = await runCli(['campaign', '--client', clientId]);

    expect(result.stdout).toContain('не доставлено');
    expect(result.stdout).toContain('TELEGRAM_BOT_TOKEN');
    expect(result.code).not.toBe(0);
  });

  it('клиент без хвостов по-прежнему отвечает нулём', async () => {
    const clean = await seedCampaignClient({
      tgUserId: 900000002n,
      name: 'Клиент без заявок',
      token: 'cli-exit-token-2',
      brief: briefOf(),
    });
    const result = await runCli(['campaign', '--client', clean]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Ничего не сделано');
    expect(result.stdout).not.toContain('не доставлено');
  });
});
