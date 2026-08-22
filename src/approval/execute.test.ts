import { Provider } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clearActionExecutors, executeAction } from '@/approval/execute.js';
import {
  approvalActionSchema,
  parseAction,
  type ApprovalActionInput,
  type ApprovalActionKind,
} from '@/approval/types.js';
import { registerCampaignApprovalExecutor } from '@/campaigns/approval.js';
import { registerAdapter } from '@/channels/registry.js';
import type { ChannelAdapter, ChannelContext, WriteResult } from '@/channels/types.js';

/**
 * Инвариант: вид действия, объявленный в схеме, обязан быть исполнимым.
 *
 * Заявка живёт в БД до APPROVAL_TTL_MINUTES и заканчивается нажатием ✅ живого
 * человека. Вид действия, у которого нет исполнителя, — это карточка, которая
 * падает на человеке в момент, когда он уже согласился: «действие не
 * поддерживается» приходит после нажатия, а не до отправки. Поэтому проверка
 * идёт по всем членам `approvalActionSchema`, а не по списку, который кто-то
 * помнит.
 */

const OK: WriteResult = { applied: true, plan: {} };

/** Адаптер, который умеет всё, что описывает контракт канала. */
function fakeAdapter(): ChannelAdapter {
  const unused = (): never => {
    throw new Error('чтение в этом сценарии не используется');
  };
  return {
    channel: Provider.YANDEX_DIRECT,
    verifyAccess: () => Promise.resolve({ ok: true as const }),
    listCampaigns: unused,
    listAdGroups: unused,
    listAds: unused,
    listKeywords: unused,
    getStats: unused,
    setBids: vi.fn(() => Promise.resolve(OK)),
    setBudgets: vi.fn(() => Promise.resolve(OK)),
    pauseEntities: vi.fn(() => Promise.resolve(OK)),
    resumeEntities: vi.fn(() => Promise.resolve(OK)),
    addNegativeKeywords: vi.fn(() => Promise.resolve(OK)),
  };
}

const ctx: ChannelContext = { clientId: 'cl1', credentials: {}, dryRun: true };
const base = { clientId: 'cl1', channel: Provider.YANDEX_DIRECT, reason: 'проверка' } as const;

/**
 * По образцу на каждый вид действия. Таблица полная по построению: отдельная
 * проверка ниже сверяет её ключи со схемой, поэтому новый вид действия нельзя
 * добавить в схему, не показав здесь, кто его исполняет.
 */
const SAMPLES: Record<ApprovalActionKind, ApprovalActionInput> = {
  create_campaign: { ...base, kind: 'create_campaign', campaignName: 'SEO', dailyBudget: 5000 },
  budget_change: {
    ...base,
    kind: 'budget_change',
    campaignExternalId: 'c1',
    campaignName: 'SEO',
    before: 5000,
    after: 8000,
  },
  pause_entities: { ...base, kind: 'pause_entities', level: 'keyword', externalIds: ['k1'] },
  resume_entities: { ...base, kind: 'resume_entities', level: 'ad', externalIds: ['a1'] },
  bid_change: { ...base, kind: 'bid_change', changes: [{ keywordExternalId: 'k1', bid: 30 }] },
  add_negatives: {
    ...base,
    kind: 'add_negatives',
    campaignExternalId: 'c1',
    phrases: ['бесплатно'],
  },
};

function declaredKinds(): ApprovalActionKind[] {
  return approvalActionSchema.options.map((option) => option.shape.kind.value);
}

/** Код ошибки, если она наша; иначе null. */
function codeOf(err: unknown): string | null {
  return typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : null;
}

describe('executeAction', () => {
  beforeEach(() => {
    clearActionExecutors();
    registerAdapter(fakeAdapter());
    // Создание кампании исполняется зарегистрированным исполнителем, а не веткой
    // `executeAction`: точка расширения — часть контракта, а не обходной путь.
    registerCampaignApprovalExecutor();
  });

  it('образцы покрывают ровно те виды действий, что объявлены в схеме', () => {
    expect(new Set(Object.keys(SAMPLES))).toEqual(new Set(declaredKinds()));
  });

  for (const kind of declaredKinds()) {
    it(`«${kind}» есть кому исполнить`, async () => {
      const sample = SAMPLES[kind as ApprovalActionKind];
      expect(sample, `для «${kind}» нет образца`).toBeDefined();

      const err = await executeAction(ctx, parseAction(sample)).then(
        () => null,
        (e: unknown) => e,
      );

      // Исполнитель вправе отказать по существу (нет ссылки на план, канал не
      // умеет минус-слова), но не вправе не существовать.
      expect(codeOf(err)).not.toBe('ACTION_NOT_SUPPORTED');
    });
  }
});
