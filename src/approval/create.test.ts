import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InlineKeyboardMarkup } from 'grammy/types';
import { env } from '@/config/index.js';
import type { ApprovalAction } from '@/approval/types.js';

interface CreatedRow {
  id: string;
  chatId: string;
  summary: string;
  expiresAt: Date;
  messageId: string | null;
  error: string | null;
  payload: unknown;
  action: string;
}

const h = vi.hoisted(() => {
  const state: { created: CreatedRow | null } = { created: null };
  return {
    state,
    prisma: {
      client: {
        findUnique: vi.fn(async () => ({ name: 'ООО «Ромашка»', approvalChatId: '-100500' })),
      },
      pendingApproval: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          state.created = {
            id: 'ap1',
            messageId: null,
            error: null,
            ...(data as unknown as Omit<CreatedRow, 'id' | 'messageId' | 'error'>),
          };
          return { ...state.created };
        }),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          if (state.created) Object.assign(state.created, data);
          return { ...(state.created as CreatedRow) };
        }),
      },
    },
  };
});

vi.mock('@/db/prisma.js', () => ({ prisma: h.prisma }));

const { createApproval, requestApprovalIfNeeded } = await import('@/approval/create.js');
const { setMessenger } = await import('@/approval/telegram.js');

const sendMessage = vi.fn(
  async (_chatId: string, _text: string, _markup?: InlineKeyboardMarkup) => ({ messageId: 4242 }),
);

const NOW = new Date('2026-08-08T09:00:00Z');

const action: ApprovalAction = {
  kind: 'budget_change',
  clientId: 'cl1',
  channel: 'YANDEX_DIRECT',
  reason: 'CPA 850 ₽ vs целевой 500 ₽ (7 дней)',
  campaignExternalId: '777',
  campaignName: 'SEO услуги',
  before: 5000,
  after: 3000,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.state.created = null;
  sendMessage.mockResolvedValue({ messageId: 4242 });
  setMessenger({
    sendMessage,
    editMessageText: async () => undefined,
    answerCallbackQuery: async () => undefined,
  });
});

describe('createApproval', () => {
  it('рендерит карточку по формату TZ §3.5', async () => {
    await createApproval(action, { now: NOW });

    const text = sendMessage.mock.calls[0]?.[1] ?? '';
    expect(text).toContain('🔔 Апрув требуется: ООО «Ромашка»');
    expect(text).toContain(
      'Действие: Снизить дневной бюджет кампании «SEO услуги» с 5 000 до 3 000 ₽/сут',
    );
    expect(text).toContain('Причина: CPA 850 ₽ vs целевой 500 ₽ (7 дней)');
    expect(text).toContain('Правило: изменение дневного бюджета более чем на 20%');
  });

  it('вешает три кнопки и сохраняет messageId', async () => {
    const approval = await createApproval(action, { now: NOW });

    const markup = sendMessage.mock.calls[0]?.[2];
    expect(markup?.inline_keyboard[0]).toHaveLength(3);
    expect(approval.messageId).toBe('4242');
    expect(h.state.created?.messageId).toBe('4242');
  });

  it('срок жизни берётся из APPROVAL_TTL_MINUTES', async () => {
    await createApproval(action, { now: NOW });
    const expected = new Date(NOW.getTime() + env.APPROVAL_TTL_MINUTES * 60_000);
    expect(h.state.created?.expiresAt.getTime()).toBe(expected.getTime());
  });

  it('payload кладётся целиком — apply не пересчитывает решение', async () => {
    await createApproval(action, { now: NOW });
    expect(h.state.created?.payload).toEqual(action);
    expect(h.state.created?.action).toBe('budget_change');
  });

  it('недоставленная карточка не теряет заявку, а записывает ошибку', async () => {
    sendMessage.mockRejectedValue(new Error('chat not found'));

    const approval = await createApproval(action, { now: NOW });

    expect(approval.error).toContain('chat not found');
    expect(h.state.created?.messageId).toBeNull();
  });

  it('requestApprovalIfNeeded молчит, когда политика разрешает автомат', async () => {
    const small: ApprovalAction = { ...action, after: 4600 };
    await expect(requestApprovalIfNeeded(small, { now: NOW })).resolves.toBeNull();
    expect(h.prisma.pendingApproval.create).not.toHaveBeenCalled();
  });

  it('requestApprovalIfNeeded создаёт заявку, когда правило сработало', async () => {
    await expect(requestApprovalIfNeeded(action, { now: NOW })).resolves.not.toBeNull();
    expect(h.prisma.pendingApproval.create).toHaveBeenCalledTimes(1);
  });
});
