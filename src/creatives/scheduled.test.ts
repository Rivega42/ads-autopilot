import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApprovalAction } from '@/approval/types.js';

interface GroupRow {
  id: string;
  name: string;
  campaign: { clientId: string; provider: 'YANDEX_DIRECT' };
  _count: { ads: number };
}

interface AdRow {
  id: string;
  adGroupId: string;
  externalId: string;
  llmVariant: string | null;
  createdAt: Date;
}

interface StatRow {
  entityId: string;
  impressions: number;
  clicks: number;
}

const NOW = new Date('2026-08-16T09:00:00.000Z');

const h = vi.hoisted(() => {
  const state: {
    groups: unknown[];
    ads: unknown[];
    stats: unknown[];
    reserved: Set<string>;
    statWhere: unknown;
  } = {
    groups: [],
    ads: [],
    stats: [],
    reserved: new Set<string>(),
    statWhere: null,
  };

  const duplicate = (): Error =>
    new Prisma.PrismaClientKnownRequestError('duplicate key', {
      code: 'P2002',
      clientVersion: 'test',
    });

  return {
    state,
    createApproval: vi.fn(async (action: ApprovalAction, _opts?: { dryRun?: boolean }) => ({
      id: `ap-${action.kind}`,
    })),
    prisma: {
      adGroup: { findMany: vi.fn(async (_args: { where: unknown }) => state.groups) },
      ad: {
        findMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
          const where = args.where as { adGroupId?: string; id?: { in: string[] } };
          const ads = state.ads as AdRow[];
          if (where.adGroupId !== undefined) {
            return ads
              .filter((ad) => ad.adGroupId === where.adGroupId)
              .map((ad) => ({ id: ad.id, llmVariant: ad.llmVariant, createdAt: ad.createdAt }));
          }
          const ids = where.id?.in ?? [];
          return ads
            .filter((ad) => ids.includes(ad.id))
            .map((ad) => ({ id: ad.id, externalId: ad.externalId }));
        }),
      },
      campaignStat: {
        findMany: vi.fn(async (args: { where: { entityId: { in: string[] } } }) => {
          state.statWhere = args.where;
          const ids = args.where.entityId.in;
          return (state.stats as StatRow[]).filter((row) => ids.includes(row.entityId));
        }),
      },
      idempotencyKey: {
        create: vi.fn(async (args: { data: { key: string } }) => {
          if (state.reserved.has(args.data.key)) throw duplicate();
          state.reserved.add(args.data.key);
          return args.data;
        }),
        deleteMany: vi.fn(async (args: { where: { key: string } }) => {
          state.reserved.delete(args.where.key);
          return { count: 1 };
        }),
      },
    },
  };
});

vi.mock('@/db/prisma.js', () => ({ prisma: h.prisma }));
vi.mock('@/approval/index.js', () => ({ createApproval: h.createApproval }));

const { runAbEvaluation, abApprovalIdempotencyKey, AB_WINDOW_DAYS } =
  await import('./scheduled.js');

function group(overrides: Partial<GroupRow> = {}): GroupRow {
  return {
    id: 'ag-1',
    name: 'Ремонт квартир — горячие',
    campaign: { clientId: 'cl-1', provider: 'YANDEX_DIRECT' },
    _count: { ads: 2 },
    ...overrides,
  };
}

function ad(id: string, variant: string | null, adGroupId = 'ag-1'): AdRow {
  return {
    id,
    adGroupId,
    externalId: `ext-${id}`,
    llmVariant: variant,
    createdAt: new Date('2026-08-10T00:00:00.000Z'),
  };
}

/** Разрыв, на котором `selectWinner` объявляет победителя: CTR 5% против 1%. */
function decisiveStats(): StatRow[] {
  return [
    { entityId: 'ad-1', impressions: 2000, clicks: 100 },
    { entityId: 'ad-2', impressions: 2000, clicks: 20 },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.groups = [group()];
  h.state.ads = [ad('ad-1', 'v-a'), ad('ad-2', 'v-b')];
  h.state.stats = decisiveStats();
  h.state.reserved = new Set<string>();
  h.state.statWhere = null;
});

describe('runAbEvaluation: победитель', () => {
  it('просит человека выключить проигравшие объявления, а не пишет в кабинет сам', async () => {
    const summary = await runAbEvaluation({ dryRun: false, now: NOW });

    expect(summary.winners).toBe(1);
    expect(summary.approvals).toBe(1);
    expect(h.createApproval).toHaveBeenCalledTimes(1);

    const [action] = h.createApproval.mock.calls[0] ?? [];
    expect(action).toMatchObject({
      kind: 'pause_entities',
      level: 'ad',
      clientId: 'cl-1',
      channel: 'YANDEX_DIRECT',
      externalIds: ['ext-ad-2'],
    });
    // Победитель на паузу не уходит — иначе тест выключил бы лучший текст.
    expect(action?.kind === 'pause_entities' && action.externalIds).not.toContain('ext-ad-1');
  });

  it('кладёт в карточку объяснение решения, а не голый id варианта', async () => {
    await runAbEvaluation({ dryRun: false, now: NOW });

    const [action] = h.createApproval.mock.calls[0] ?? [];
    expect(action?.reason).toContain('Ремонт квартир — горячие');
    expect(action?.reason).toContain('Победитель');
  });

  it('передаёт dry-run в карточку: обещание карточки должно совпасть с режимом', async () => {
    await runAbEvaluation({ dryRun: true, now: NOW });

    const [, opts] = h.createApproval.mock.calls[0] ?? [];
    expect(opts).toMatchObject({ dryRun: true });
  });

  it('складывает объявления одного варианта в одну карточку', async () => {
    h.state.groups = [group({ _count: { ads: 3 } })];
    h.state.ads = [ad('ad-1', 'v-a'), ad('ad-2', 'v-b'), ad('ad-3', 'v-b')];
    h.state.stats = [...decisiveStats(), { entityId: 'ad-3', impressions: 2000, clicks: 20 }];

    await runAbEvaluation({ dryRun: false, now: NOW });

    const [action] = h.createApproval.mock.calls[0] ?? [];
    expect(action?.kind === 'pause_entities' && action.externalIds).toEqual([
      'ext-ad-2',
      'ext-ad-3',
    ]);
  });
});

describe('runAbEvaluation: решения без победителя', () => {
  it('не трогает ничего, пока данные набираются', async () => {
    h.state.stats = [
      { entityId: 'ad-1', impressions: 100, clicks: 5 },
      { entityId: 'ad-2', impressions: 90, clicks: 1 },
    ];

    const summary = await runAbEvaluation({ dryRun: false, now: NOW });

    expect(summary.collecting).toBe(1);
    expect(summary.winners).toBe(0);
    expect(h.createApproval).not.toHaveBeenCalled();
  });

  it('считает неубедительный результат отдельно от набора данных', async () => {
    h.state.stats = [
      { entityId: 'ad-1', impressions: 2000, clicks: 101 },
      { entityId: 'ad-2', impressions: 2000, clicks: 100 },
    ];

    const summary = await runAbEvaluation({ dryRun: false, now: NOW });

    expect(summary.inconclusive).toBe(1);
    expect(h.createApproval).not.toHaveBeenCalled();
  });

  it('группу с одним объявлением не оценивает вовсе', async () => {
    h.state.groups = [group({ _count: { ads: 1 } })];

    const summary = await runAbEvaluation({ dryRun: false, now: NOW });

    expect(summary.adGroups).toBe(0);
    expect(h.prisma.campaignStat.findMany).not.toHaveBeenCalled();
  });

  it('три копии одного текста экспериментом не считает', async () => {
    h.state.ads = [ad('ad-1', 'v-a'), ad('ad-2', 'v-a')];

    const summary = await runAbEvaluation({ dryRun: false, now: NOW });

    expect(summary.singleVariant).toBe(1);
    expect(summary.inconclusive).toBe(0);
    expect(h.createApproval).not.toHaveBeenCalled();
  });

  it('победитель без адресуемых проигравших не превращается в пустую карточку', async () => {
    h.state.ads = [ad('ad-1', 'v-a'), { ...ad('ad-2', 'v-b'), externalId: '' }];

    const summary = await runAbEvaluation({ dryRun: false, now: NOW });

    expect(summary.winners).toBe(1);
    expect(summary.unbuildable).toBe(1);
    expect(h.createApproval).not.toHaveBeenCalled();
  });
});

describe('runAbEvaluation: идемпотентность', () => {
  it('повтор задачи BullMQ не шлёт вторую такую же карточку', async () => {
    const first = await runAbEvaluation({ dryRun: false, now: NOW });
    const second = await runAbEvaluation({ dryRun: false, now: NOW });

    expect(first.approvals).toBe(1);
    expect(second.approvals).toBe(0);
    expect(second.approvalsDuplicate).toBe(1);
    expect(h.createApproval).toHaveBeenCalledTimes(1);
  });

  it('назавтра карточку не повторяет: решение то же, статистика другая', async () => {
    await runAbEvaluation({ dryRun: false, now: NOW });
    // Сутки спустя показов больше, p-value другое — но победитель и проигравшие те же.
    h.state.stats = [
      { entityId: 'ad-1', impressions: 3000, clicks: 150 },
      { entityId: 'ad-2', impressions: 3000, clicks: 30 },
    ];

    const next = await runAbEvaluation({
      dryRun: false,
      now: new Date('2026-08-17T09:00:00.000Z'),
    });

    expect(next.approvalsDuplicate).toBe(1);
    expect(h.createApproval).toHaveBeenCalledTimes(1);
  });

  it('освобождает ключ, если карточка не создалась, чтобы повтор дошёл до человека', async () => {
    h.createApproval.mockRejectedValueOnce(new Error('telegram down'));

    const first = await runAbEvaluation({ dryRun: false, now: NOW });
    const second = await runAbEvaluation({ dryRun: false, now: NOW });

    expect(first.approvalsFailed).toBe(1);
    expect(second.approvals).toBe(1);
  });

  it('ключ зависит от победителя и набора проигравших, а не от p-value', () => {
    const key = abApprovalIdempotencyKey('ag-1', 'v-a', ['ext-ad-2']);

    expect(key).toBe(abApprovalIdempotencyKey('ag-1', 'v-a', ['ext-ad-2']));
    expect(key).not.toBe(abApprovalIdempotencyKey('ag-1', 'v-b', ['ext-ad-2']));
    expect(key).not.toBe(abApprovalIdempotencyKey('ag-1', 'v-a', ['ext-ad-2', 'ext-ad-3']));
    expect(key).not.toBe(abApprovalIdempotencyKey('ag-2', 'v-a', ['ext-ad-2']));
  });
});

describe('runAbEvaluation: окно и устойчивость', () => {
  it('смотрит окно не короче срока сбора данных', async () => {
    await runAbEvaluation({ dryRun: false, now: NOW });

    const where = h.state.statWhere as { date: { gte: Date; lte: Date } };
    const days = (where.date.lte.getTime() - where.date.gte.getTime()) / 86_400_000 + 1;
    expect(days).toBe(AB_WINDOW_DAYS);
    // Границы — календарные даты: колонка CampaignStat.date имеет тип Date.
    expect(where.date.lte.toISOString()).toBe('2026-08-16T00:00:00.000Z');
  });

  it('падение на одной группе не отменяет остальные', async () => {
    h.state.groups = [group({ id: 'ag-broken' }), group()];
    h.prisma.ad.findMany.mockImplementationOnce(async () => {
      throw new Error('соединение потеряно');
    });

    const summary = await runAbEvaluation({ dryRun: false, now: NOW });

    expect(summary.failed).toBe(1);
    expect(summary.approvals).toBe(1);
  });

  it('берёт только активные группы активных кампаний активных клиентов', async () => {
    await runAbEvaluation({ dryRun: false, now: NOW, clientId: 'cl-1' });

    const [args] = h.prisma.adGroup.findMany.mock.calls[0] ?? [];
    expect(args).toMatchObject({
      where: {
        status: 'ACTIVE',
        campaign: { status: 'ACTIVE', client: { status: 'ACTIVE' }, clientId: 'cl-1' },
      },
    });
  });
});
