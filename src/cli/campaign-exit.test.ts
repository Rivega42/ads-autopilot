import { describe, expect, it } from 'vitest';

import { needsHumanFix } from './campaign-exit.js';

import type { CampaignEntryCheck, LiveApproval } from '@/campaigns/index.js';

function approval(error: string | null): LiveApproval {
  return {
    id: 'ap_1',
    chatId: '4242',
    error,
    kind: 'NEW_CAMPAIGN',
    expiresAt: new Date('2026-08-23T00:00:00Z'),
  } as unknown as LiveApproval;
}

function ready(undelivered: LiveApproval[]): CampaignEntryCheck {
  return {
    kind: 'ready',
    clientName: 'Ромашка',
    brief: {} as never,
    budgets: [],
    notes: [],
    regionIds: [225],
    dryRun: true,
    reusablePlan: null,
    created: [],
    undelivered,
  } as unknown as CampaignEntryCheck;
}

describe('код возврата команды campaign', () => {
  it('готовность без хвостов — не поломка', () => {
    expect(needsHumanFix(ready([]))).toBe(false);
  });

  it('«всё уже создано» — работа сделана, а не поломка', () => {
    expect(needsHumanFix({ kind: 'already_created', campaigns: [] })).toBe(false);
  });

  it('карточка в чате ждёт нажатия — штатное состояние', () => {
    expect(
      needsHumanFix({
        kind: 'awaiting_decision',
        approvals: [approval(null)],
        undelivered: [],
      }),
    ).toBe(false);
  });

  it('живая карточка есть, а часть не доставлена — чинить доставку', () => {
    expect(
      needsHumanFix({
        kind: 'awaiting_decision',
        approvals: [approval(null)],
        undelivered: [approval('bot was blocked')],
      }),
    ).toBe(true);
  });

  it('не доставлена ни одна карточка — проверка обязана отдать отказ', () => {
    // Вход возвращает `awaiting_decision`, только пока жива хотя бы одна карточка.
    // Когда Telegram не принял ни одной, состояние снова `ready` — и дешёвый
    // прогон без --apply, которым как раз ходят по клиентам скриптом, отчитывался
    // «готов» ровно в том случае, ради которого код возврата и правился.
    expect(needsHumanFix(ready([approval('bot was blocked')]))).toBe(true);
  });

  it('дыра в брифе, отсутствующий доступ, незавершённая попытка — отказ', () => {
    const blocks: CampaignEntryCheck[] = [
      { kind: 'client_unknown' },
      { kind: 'client_inactive', status: 'PAUSED' },
      { kind: 'no_credentials', channels: ['YANDEX_DIRECT'] },
      { kind: 'brief_missing' },
      { kind: 'brief_incomplete', missing: ['geo'] as never },
      { kind: 'brief_invalid', issues: ['geo'] },
      { kind: 'landing_missing' },
      { kind: 'budget_too_small', dailyBudgetRub: 100, minRub: 300, notes: [] },
      { kind: 'geo_contradiction', geo: ['Москва'], negativeCities: ['Москва'] },
      { kind: 'attempt_unresolved', campaigns: ['Поиск'] },
    ];
    for (const block of blocks) expect(needsHumanFix(block)).toBe(true);
  });
});
