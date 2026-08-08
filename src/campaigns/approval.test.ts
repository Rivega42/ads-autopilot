import { ApprovalKind, Provider, type PendingApproval } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { renderApprovalCard, renderDetails } from '@/approval/card.js';
import { matchApprovalRule } from '@/approval/policy.js';
import { approvalActionSchema, type ApprovalAction } from '@/approval/types.js';
import type { ApplyPlanDeps, ApplyStore } from '@/campaigns/apply.js';
import { executeCreateCampaign, submitCampaignPlan } from '@/campaigns/approval.js';
import { createInMemoryCampaignIdempotency } from '@/campaigns/idempotency.js';
import { campaignPlanSchema, readPlanRef, type CampaignPlan } from '@/campaigns/plan.schema.js';
import { CAMPAIGN_PLAN_PROVIDER } from '@/campaigns/store.js';
import { markCreateOutcome, type CampaignWriter } from '@/campaigns/writer.js';
import type { ChannelContext } from '@/channels/types.js';
import { AppError } from '@/lib/errors.js';

const CTX: ChannelContext = { clientId: 'c1', credentials: {}, dryRun: false };

function planWith(id: string | null): CampaignPlan {
  return campaignPlanSchema.parse({
    id,
    clientId: 'c1',
    createdAt: '2026-08-08T09:00:00.000Z',
    totalDailyBudgetRub: 5_000,
    summary: 'Поиск плюс сети',
    campaigns: ['search', 'network'].map((placement, index) => ({
      channel: Provider.YANDEX_DIRECT,
      placement,
      name: placement === 'search' ? 'Поиск — Курсы' : 'РСЯ — Курсы',
      dailyBudgetRub: index === 0 ? 3_500 : 1_500,
      targetCpaRub: 2_000,
      strategy: { search: { type: 'HIGHEST_POSITION' }, network: { type: 'SERVING_OFF' } },
      negativeKeywords: [],
      adGroups: [
        {
          name: 'Группа',
          regionIds: [213],
          keywords: [{ phrase: 'фраза', bidRub: 100 }],
          negativeKeywords: [],
          ads: [{ title: 'Заголовок', text: 'Текст объявления.' }],
        },
      ],
    })),
    warnings: ['Обрезано полей объявлений под лимиты Директа: 2.'],
    prompts: [],
  });
}

let approvalSeq = 0;

function fakeApproval(action: ApprovalAction): PendingApproval {
  approvalSeq += 1;
  return {
    id: `ap-${approvalSeq}`,
    clientId: action.clientId,
    kind: ApprovalKind.NEW_CAMPAIGN,
    payload: action,
    summary: null,
    chatId: null,
    tgMessageId: null,
    expiresAt: new Date('2026-08-08T11:00:00.000Z'),
    decision: 'PENDING',
    decidedAt: null,
    respondedBy: null,
    error: null,
    createdAt: new Date('2026-08-08T09:00:00.000Z'),
  } as unknown as PendingApproval;
}

describe('submitCampaignPlan', () => {
  it('выпускает по карточке на кампанию со ссылкой на план', async () => {
    const actions: ApprovalAction[] = [];
    const approvals = await submitCampaignPlan(planWith('plan-1'), {
      createApproval: (action) => {
        actions.push(action);
        return Promise.resolve(fakeApproval(action));
      },
    });

    expect(approvals).toHaveLength(2);
    expect(actions.map((a) => a.kind)).toEqual(['create_campaign', 'create_campaign']);
    expect(
      actions.map((a) =>
        a.kind === 'create_campaign' ? readPlanRef(a.strategy)?.campaignIndex : null,
      ),
    ).toEqual([0, 1]);
    expect(actions[0]).toMatchObject({
      clientId: 'c1',
      channel: Provider.YANDEX_DIRECT,
      campaignName: 'Поиск — Курсы',
      dailyBudget: 3_500,
    });
  });

  it('причина карточки несёт и вывод стратега, и предупреждения плана', async () => {
    const actions: ApprovalAction[] = [];
    await submitCampaignPlan(planWith('plan-1'), {
      createApproval: (action) => {
        actions.push(action);
        return Promise.resolve(fakeApproval(action));
      },
    });

    expect(actions[0]?.reason).toContain('Поиск плюс сети');
    expect(actions[0]?.reason).toContain('Обрезано полей объявлений');
  });

  it('действие проходит схему апрувов и требует человека', async () => {
    const actions: ApprovalAction[] = [];
    await submitCampaignPlan(planWith('plan-1'), {
      createApproval: (action) => {
        actions.push(action);
        return Promise.resolve(fakeApproval(action));
      },
    });

    const action = approvalActionSchema.parse(actions[0]);
    expect(matchApprovalRule(action)?.code).toBe('new_campaign');
    expect(renderApprovalCard({ action, clientName: 'ООО', expiresAt: new Date() })).toContain(
      'Создать кампанию «Поиск — Курсы»',
    );
    // Детали уходят alert'ом Telegram: он режется на 200 символах, поэтому в
    // strategy лежит ссылка на план, а не план.
    expect(renderDetails(action).length).toBeLessThan(200);
  });

  it('несохранённый план в апрув не отдаётся', async () => {
    await expect(
      submitCampaignPlan(planWith(null), { createApproval: () => Promise.reject(new Error('no')) }),
    ).rejects.toThrow('unsaved campaign plan');
  });
});

describe('executeCreateCampaign', () => {
  const action: ApprovalAction = approvalActionSchema.parse({
    kind: 'create_campaign',
    clientId: 'c1',
    channel: Provider.YANDEX_DIRECT,
    reason: 'План стратега',
    campaignName: 'Поиск — Курсы',
    dailyBudget: 3_500,
    strategy: { planId: 'plan-1', campaignIndex: 0, placement: 'search' },
  });

  function depsWith(writer: CampaignWriter): ApplyPlanDeps {
    return {
      writers: { [Provider.YANDEX_DIRECT]: writer },
      idempotency: createInMemoryCampaignIdempotency(),
      db: {
        creative: {
          findUnique: () =>
            Promise.resolve({
              id: 'plan-1',
              provider: CAMPAIGN_PLAN_PROVIDER,
              payload: JSON.parse(JSON.stringify(planWith(null))) as unknown,
            }),
        },
        campaign: { upsert: () => Promise.resolve({ id: 'db-1' }) },
        adGroup: { upsert: () => Promise.resolve({ id: 'db-g1' }) },
        keyword: {
          findFirst: () => Promise.resolve(null),
          update: () => Promise.resolve({ id: 'db-k1' }),
          create: () => Promise.resolve({ id: 'db-k1' }),
        },
        idempotencyKey: {},
      } as unknown as ApplyStore,
    };
  }

  function recordingWriter(): { writer: CampaignWriter; contexts: ChannelContext[] } {
    const contexts: ChannelContext[] = [];
    const writer: CampaignWriter = {
      channel: Provider.YANDEX_DIRECT,
      createCampaign: (ctx) => {
        contexts.push(ctx);
        return Promise.resolve({ externalId: 'ext-1' });
      },
      createAdGroups: (_ctx, _id, groups) =>
        Promise.resolve(groups.map((g, i) => ({ externalId: `g${i}`, name: g.name }))),
      createKeywords: (_ctx, keywords) =>
        Promise.resolve(keywords.map((_, i) => ({ externalId: `k${i}` }))),
      createAds: (_ctx, ads) => Promise.resolve(ads.map((_, i) => ({ externalId: `a${i}` }))),
    };
    return { writer, contexts };
  }

  it('создаёт кампанию, на которую указывает заявка, в контексте апрува', async () => {
    const { writer, contexts } = recordingWriter();
    const result = await executeCreateCampaign(CTX, action, depsWith(writer));

    expect(result.applied).toBe(true);
    expect(result.result?.externalId).toBe('ext-1');
    expect(result.result?.name).toBe('Поиск — Курсы');
    // Контекст собирает approval-модуль вместе с обещанным карточке режимом;
    // пересобирать его здесь означало бы применить не то, что видел человек.
    expect(contexts).toEqual([CTX]);
  });

  it('в dry-run ничего не создаёт и не считается применённым', async () => {
    const { writer, contexts } = recordingWriter();
    const dryCtx: ChannelContext = { ...CTX, dryRun: true };

    const result = await executeCreateCampaign(dryCtx, action, depsWith(writer));

    expect(result.applied).toBe(false);
    expect(result.result?.status).toBe('planned');
    expect(contexts).toEqual([]);
  });

  it('провал создания превращается в исключение — апрув уходит в FAILED', async () => {
    const failing: CampaignWriter = {
      ...recordingWriter().writer,
      createCampaign: () =>
        Promise.reject(
          markCreateOutcome(
            new AppError('Директ отклонил кампанию', { code: 'YANDEX_CREATE_REJECTED' }),
            'not-created',
          ),
        ),
    };

    const err = await executeCreateCampaign(CTX, action, depsWith(failing)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('CAMPAIGN_CREATE_FAILED');
    expect((err as AppError).message).toContain('Директ отклонил кампанию');
  });

  it('неподтверждённое создание — отдельный код: повторять нельзя, нужен человек', async () => {
    const lost: CampaignWriter = {
      ...recordingWriter().writer,
      createCampaign: () => Promise.reject(new Error('timeout of 60000ms exceeded')),
    };

    const err = await executeCreateCampaign(CTX, action, depsWith(lost)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('CAMPAIGN_CREATE_UNKNOWN');
    expect((err as AppError).message).toContain('проверьте кабинет вручную');
  });

  it('заявка без ссылки на план не создаёт «пустую» кампанию', async () => {
    const orphan = approvalActionSchema.parse({ ...action, strategy: {} });
    await expect(executeCreateCampaign(CTX, orphan)).rejects.toThrow('не ссылается на план');
  });

  it('чужой вид действия отвергается', async () => {
    const other = approvalActionSchema.parse({
      kind: 'add_negatives',
      clientId: 'c1',
      channel: Provider.YANDEX_DIRECT,
      reason: 'r',
      campaignExternalId: '1',
      phrases: ['x'],
    });
    await expect(executeCreateCampaign(CTX, other)).rejects.toThrow('executeCreateCampaign');
  });
});
