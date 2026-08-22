import { ApprovalKind } from '@prisma/client';
import type { InlineKeyboardMarkup } from 'grammy/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApprovalAction } from '@/approval/types.js';

interface CreatedRow {
  id: string;
  chatId: string;
  summary: string;
  expiresAt: Date;
  tgMessageId: bigint | null;
  error: string | null;
  payload: unknown;
  kind: ApprovalKind;
}

const h = vi.hoisted(() => {
  // Глобальный флаг выключаем до загрузки конфига: иначе dry-run включён всегда и
  // проверить противоположное направление расхождения нечем.
  process.env.DRY_RUN = 'false';

  const state: { created: CreatedRow | null; updateError: string | null } = {
    created: null,
    updateError: null,
  };
  return {
    state,
    prisma: {
      client: {
        findUnique: vi.fn(async () => ({ name: 'ООО «Ромашка»', tgUserId: 357896330n })),
      },
      pendingApproval: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          state.created = {
            id: 'ap1',
            tgMessageId: null,
            error: null,
            ...(data as unknown as Omit<CreatedRow, 'id' | 'tgMessageId' | 'error'>),
          };
          return { ...state.created };
        }),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          if (state.updateError) throw new Error(state.updateError);
          if (state.created) Object.assign(state.created, data);
          return { ...(state.created as CreatedRow) };
        }),
      },
    },
  };
});

vi.mock('@/db/prisma.js', () => ({ prisma: h.prisma }));

const { APPROVAL_TTL_MINUTES, env } = await import('@/env.js');
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

const DRY_RUN_BANNER = '⚠️ Режим dry-run';

beforeEach(() => {
  vi.clearAllMocks();
  h.state.created = null;
  h.state.updateError = null;
  env.DRY_RUN = false;
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

  it('шлёт карточку в личный чат клиента', async () => {
    await createApproval(action, { now: NOW });

    expect(sendMessage.mock.calls[0]?.[0]).toBe('357896330');
    // Чат фиксируется в строке: по нему проверяется право нажать кнопку.
    expect(h.state.created?.chatId).toBe('357896330');
  });

  it('вешает три кнопки и сохраняет tgMessageId', async () => {
    const approval = await createApproval(action, { now: NOW });

    const markup = sendMessage.mock.calls[0]?.[2];
    expect(markup?.inline_keyboard[0]).toHaveLength(3);
    expect(approval.tgMessageId).toBe(4242n);
    expect(h.state.created?.tgMessageId).toBe(4242n);
  });

  it('срок жизни берётся из APPROVAL_TTL_MINUTES', async () => {
    await createApproval(action, { now: NOW });
    const expected = new Date(NOW.getTime() + APPROVAL_TTL_MINUTES * 60_000);
    expect(h.state.created?.expiresAt.getTime()).toBe(expected.getTime());
  });

  it('payload кладётся целиком — apply не пересчитывает решение', async () => {
    await createApproval(action, { now: NOW });
    expect(h.state.created?.payload).toMatchObject({ ...action });
    expect(h.state.created?.kind).toBe(ApprovalKind.BUDGET_CHANGE);
  });

  it('недоставленная карточка не теряет заявку, а записывает ошибку', async () => {
    sendMessage.mockRejectedValue(new Error('chat not found'));

    const approval = await createApproval(action, { now: NOW });

    expect(approval.error).toContain('chat not found');
    expect(h.state.created?.tgMessageId).toBeNull();
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

  // ── #11: карточка обещает ровно тот режим, который будет применён ──────────
  it('карточка предупреждает о dry-run, когда он включён глобально', async () => {
    env.DRY_RUN = true;

    await createApproval(action, { now: NOW });

    expect(sendMessage.mock.calls[0]?.[1]).toContain(DRY_RUN_BANNER);
    expect(h.state.created?.payload).toMatchObject({ meta: { dryRun: true } });
  });

  it('без dry-run карточка о нём молчит, и это же значение уходит в payload', async () => {
    await createApproval(action, { now: NOW });

    expect(sendMessage.mock.calls[0]?.[1]).not.toContain(DRY_RUN_BANNER);
    expect(h.state.created?.payload).toMatchObject({ meta: { dryRun: false } });
  });

  it('опция dryRun только усиливает защиту', async () => {
    await createApproval(action, { now: NOW, dryRun: true });

    expect(sendMessage.mock.calls[0]?.[1]).toContain(DRY_RUN_BANNER);
    expect(h.state.created?.payload).toMatchObject({ meta: { dryRun: true } });
  });

  // ── неисполнимая пара «вид действия × канал» ──────────────────────────────
  it('не выпускает карточку, которую некому будет применить', async () => {
    // VK не умеет минус-слов: у канала нет ни фраз, ни поисковых запросов. Такая
    // карточка доходила до человека и падала уже после нажатия ✅ — то есть тогда,
    // когда он уверен, что дело сделано.
    const vkNegatives: ApprovalAction = {
      kind: 'add_negatives',
      clientId: 'cl1',
      channel: 'VK_ADS',
      reason: 'CTR 0.2% при 40 кликах',
      campaignExternalId: '777',
      phrases: ['бесплатно'],
    };

    await expect(createApproval(vkNegatives, { now: NOW })).rejects.toMatchObject({
      code: 'ACTION_NOT_SUPPORTED',
    });
    expect(h.prisma.pendingApproval.create).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('отказ звучит одинаково и для того, кто спрашивает политику', async () => {
    const vkKeywordPause: ApprovalAction = {
      kind: 'pause_entities',
      clientId: 'cl1',
      channel: 'VK_ADS',
      reason: 'Пауза: 0 конверсий',
      level: 'keyword',
      externalIds: ['1', '2'],
    };

    await expect(requestApprovalIfNeeded(vkKeywordPause, { now: NOW })).rejects.toMatchObject({
      code: 'ACTION_NOT_SUPPORTED',
    });
    expect(h.prisma.pendingApproval.create).not.toHaveBeenCalled();
  });

  // ── #19: карточка уже в чате — её нельзя потерять ─────────────────────────
  it('не роняет создание, если tgMessageId не записался после отправки', async () => {
    h.state.updateError = 'connection pool timeout';

    const approval = await createApproval(action, { now: NOW });

    // Иначе вызывающий считает создание неудачным и шлёт вторую карточку на то же изменение.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(approval.id).toBe('ap1');
    expect(approval.tgMessageId).toBe(4242n);
  });
});
