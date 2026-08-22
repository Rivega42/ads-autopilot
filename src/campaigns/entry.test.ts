import { ApprovalDecision, ApprovalKind, ClientStatus, Provider } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import type { ClientBriefData } from '@/ai/onboarding/index.js';
import { renderEntryBlock, renderPlanSummary, renderReadiness } from '@/campaigns/entry-text.js';
import { checkCampaignEntry, launchCampaign, type CampaignEntryStore } from '@/campaigns/entry.js';
import { campaignCreateKey, CAMPAIGN_PLAN_PROVIDER } from '@/campaigns/index.js';
import type { CampaignPlan } from '@/campaigns/plan.schema.js';
import { EmptyPlanError } from '@/campaigns/planner.js';
import { env } from '@/env.js';

/**
 * Разбор случаев на входе в создание кампании.
 *
 * Каждый «нельзя» здесь стоит клиенту либо денег на модель, либо второй кампании
 * на те же деньги, поэтому проверяется не только факт отказа, но и то, что отказ
 * случается ДО платного вызова и ДО выпуска карточек.
 */

const CLIENT_ID = 'client-1';
const PLAN_ID = 'plan-1';
/** Бриф старше плана: план, собранный после правки брифа, — свежий. */
const BRIEF_UPDATED_AT = new Date('2026-07-20T10:00:00Z');

function briefOf(over: Partial<ClientBriefData> = {}): ClientBriefData {
  return {
    product: 'Курсы английского для программистов',
    audience: { description: 'Разработчики 25-40 лет' },
    geo: ['Москва'],
    negativeCities: [],
    usp: ['IT-лексика'],
    targetCpaRub: 2_000,
    dailyBudgetRub: 5_000,
    budgetScope: 'per_channel',
    competitors: [{ name: 'Skyeng' }],
    conversionGoals: [{ name: 'заявка' }],
    metrika: null,
    landingUrl: 'https://example.com/course',
    ...over,
  };
}

function planOf(campaigns = 1): CampaignPlan {
  const campaign = {
    channel: Provider.YANDEX_DIRECT,
    placement: 'search' as const,
    name: 'Поиск — Курсы',
    dailyBudgetRub: 3_500,
    targetCpaRub: 2_000,
    strategy: { search: { type: 'HIGHEST_POSITION' }, network: { type: 'SERVING_OFF' } },
    negativeKeywords: [],
    adGroups: [
      {
        name: 'Горячий спрос',
        regionIds: [213],
        keywords: [{ phrase: 'курсы английского', bidRub: 100 }],
        negativeKeywords: [],
        ads: [{ title: 'Английский для IT', text: 'Курс с практикой', href: 'https://e.com/a' }],
      },
    ],
  };
  return {
    id: PLAN_ID,
    clientId: CLIENT_ID,
    createdAt: new Date('2026-08-01T10:00:00Z').toISOString(),
    totalDailyBudgetRub: 3_500 * campaigns,
    summary: 'План на поиск',
    campaigns: Array.from({ length: campaigns }, (_, i) => ({
      ...campaign,
      name: `${campaign.name} ${i + 1}`,
    })),
    warnings: [],
    prompts: [],
  };
}

interface ApprovalRow {
  id: string;
  decision: ApprovalDecision;
  expiresAt: Date;
  chatId: string | null;
  payload: unknown;
}

interface FakeState {
  client?: { name: string; status: ClientStatus } | null;
  credentials?: Provider[];
  brief?: { data: unknown; updatedAt?: Date } | null;
  approvals?: ApprovalRow[];
  plan?: CampaignPlan | null;
  keys?: { key: string; entityId: string }[];
}

interface WhereDecision {
  decision?: ApprovalDecision | { in?: ApprovalDecision[] };
  expiresAt?: { gt?: Date };
}

/**
 * Хранилище в памяти, отвечающее по условиям запроса, а не «что удобно».
 *
 * Фильтры по решению и сроку реализованы честно: именно на них держится правило
 * «пока карточка жива, второй план не строим», и фейк, возвращающий все строки
 * подряд, доказывал бы обратное (docs/LESSONS.md).
 */
function fakeStore(state: FakeState): CampaignEntryStore {
  const matches = (row: ApprovalRow, clause: WhereDecision): boolean => {
    const decision = clause.decision;
    const byDecision =
      decision === undefined
        ? true
        : typeof decision === 'string'
          ? row.decision === decision
          : (decision.in ?? []).includes(row.decision);
    const byExpiry = clause.expiresAt?.gt === undefined || row.expiresAt > clause.expiresAt.gt;
    return byDecision && byExpiry;
  };

  const store = {
    client: {
      findUnique: () => Promise.resolve(state.client ?? null),
    },
    credential: {
      findMany: ({ where }: { where: { provider: { in: Provider[] } } }) =>
        Promise.resolve(
          (state.credentials ?? [])
            .filter((p) => where.provider.in.includes(p))
            .map((p) => ({
              provider: p,
            })),
        ),
    },
    clientBrief: {
      findUnique: () =>
        Promise.resolve(
          state.brief
            ? { data: state.brief.data, updatedAt: state.brief.updatedAt ?? BRIEF_UPDATED_AT }
            : null,
        ),
    },
    pendingApproval: {
      findMany: ({ where }: { where: { kind: ApprovalKind; OR: WhereDecision[] } }) => {
        expect(where.kind).toBe(ApprovalKind.NEW_CAMPAIGN);
        const rows = (state.approvals ?? []).filter((row) =>
          where.OR.some((clause) => matches(row, clause)),
        );
        return Promise.resolve(rows);
      },
    },
    creative: {
      findFirst: ({ where }: { where: { provider: string } }) => {
        expect(where.provider).toBe(CAMPAIGN_PLAN_PROVIDER);
        return Promise.resolve(state.plan ? { id: PLAN_ID } : null);
      },
      findUnique: () =>
        Promise.resolve(
          state.plan
            ? {
                id: PLAN_ID,
                provider: CAMPAIGN_PLAN_PROVIDER,
                payload: JSON.parse(JSON.stringify(state.plan)) as unknown,
              }
            : null,
        ),
    },
    idempotencyKey: {
      findMany: ({ where }: { where: { key: { in: string[] } } }) =>
        Promise.resolve((state.keys ?? []).filter((row) => where.key.in.includes(row.key))),
    },
  };

  return store as unknown as CampaignEntryStore;
}

function ready(state: FakeState = {}): FakeState {
  return {
    client: { name: 'Клиент', status: ClientStatus.ACTIVE },
    credentials: [Provider.YANDEX_DIRECT],
    brief: { data: briefOf() },
    ...state,
  };
}

describe('checkCampaignEntry: чего не хватает для запуска', () => {
  it('незнакомый и отключённый клиент до брифа не доходят', async () => {
    expect((await checkCampaignEntry(CLIENT_ID, { db: fakeStore({ client: null }) })).kind).toBe(
      'client_unknown',
    );

    const paused = await checkCampaignEntry(CLIENT_ID, {
      db: fakeStore({ client: { name: 'Клиент', status: ClientStatus.PAUSED } }),
    });
    expect(paused).toMatchObject({ kind: 'client_inactive', status: ClientStatus.PAUSED });
  });

  it('без токена кабинета плану некуда уезжать', async () => {
    const outcome = await checkCampaignEntry(CLIENT_ID, {
      db: fakeStore(ready({ credentials: [] })),
    });
    expect(outcome).toMatchObject({ kind: 'no_credentials', channels: [Provider.YANDEX_DIRECT] });
  });

  it('брифа нет — отправляем в интервью', async () => {
    const outcome = await checkCampaignEntry(CLIENT_ID, { db: fakeStore(ready({ brief: null })) });
    expect(outcome.kind).toBe('brief_missing');
    expect(renderEntryBlock(outcome as never)).toContain('/onboarding');
  });

  it('незаконченный бриф перечисляет все дыры разом', async () => {
    const brief = briefOf();
    delete (brief as Partial<ClientBriefData>).usp;
    delete (brief as Partial<ClientBriefData>).landingUrl;

    const outcome = await checkCampaignEntry(CLIENT_ID, {
      db: fakeStore(ready({ brief: { data: brief } })),
    });
    expect(outcome.kind).toBe('brief_incomplete');
    expect(renderEntryBlock(outcome as never)).toContain('УТП');
  });

  it('одна лишь недостающая ссылка объясняется причиной, а не списком полей', async () => {
    const brief = briefOf();
    delete (brief as Partial<ClientBriefData>).landingUrl;

    const outcome = await checkCampaignEntry(CLIENT_ID, {
      db: fakeStore(ready({ brief: { data: brief } })),
    });
    expect(outcome.kind).toBe('landing_missing');

    const text = renderEntryBlock(outcome as never);
    expect(text).toContain('Директ не принимает объявление, которому некуда вести');
    expect(text).toContain('пришли ссылку');
  });

  it('минимального бюджета хватает ровно на одну кампанию, и человек видит какую', async () => {
    const outcome = await checkCampaignEntry(CLIENT_ID, {
      db: fakeStore(ready({ brief: { data: briefOf({ dailyBudgetRub: 300 }) } })),
    });
    expect(outcome.kind).toBe('ready');
    if (outcome.kind !== 'ready') return;

    // 300 ₽ — минимум Директа на кампанию: РСЯ отваливается целиком, а не
    // создаётся с бюджетом, который площадка не примет.
    expect(outcome.budgets).toEqual([
      { channel: Provider.YANDEX_DIRECT, placement: 'search', dailyBudgetRub: 300 },
    ]);
    expect(outcome.notes.join(' ')).toContain('РСЯ');
  });

  it('когда денег не хватает даже на одну кампанию, отказ объясняет минимум', () => {
    const text = renderEntryBlock({
      kind: 'budget_too_small',
      dailyBudgetRub: 200,
      minRub: 300,
      notes: [],
    });
    expect(text).toContain('300 ₽/сут');
  });

  it('бриф, исключающий собственные города показа, отсекается без модели', async () => {
    const brief = briefOf({ geo: ['Москва'], negativeCities: ['Москва'] });
    const outcome = await checkCampaignEntry(CLIENT_ID, {
      db: fakeStore(ready({ brief: { data: brief } })),
    });
    expect(outcome.kind).toBe('geo_contradiction');
  });
});

describe('checkCampaignEntry: что уже происходит с клиентом', () => {
  const now = (): Date => new Date('2026-08-20T12:00:00Z');

  function approval(over: Partial<ApprovalRow> = {}): ApprovalRow {
    return {
      id: 'appr-1',
      decision: ApprovalDecision.PENDING,
      expiresAt: new Date('2026-08-20T14:00:00Z'),
      chatId: '42',
      payload: {
        kind: 'create_campaign',
        clientId: CLIENT_ID,
        channel: Provider.YANDEX_DIRECT,
        reason: 'план собран',
        campaignName: 'Поиск — Курсы',
        dailyBudget: 3_500,
        strategy: { planId: PLAN_ID, campaignIndex: 0, placement: 'search' },
      },
      ...over,
    };
  }

  it('живая карточка останавливает вход', async () => {
    const outcome = await checkCampaignEntry(CLIENT_ID, {
      db: fakeStore(ready({ approvals: [approval()] })),
      now,
    });
    expect(outcome.kind).toBe('awaiting_decision');
    expect(renderEntryBlock(outcome as never)).toContain('Поиск — Курсы');
  });

  it('истёкшая карточка живой не считается: решать по ней уже нечего', async () => {
    const outcome = await checkCampaignEntry(CLIENT_ID, {
      db: fakeStore(
        ready({ approvals: [approval({ expiresAt: new Date('2026-08-20T11:00:00Z') })] }),
      ),
      now,
    });
    expect(outcome.kind).toBe('ready');
  });

  it('созданная кампания видна по ключу идемпотентности, а не по статусу заявки', async () => {
    const outcome = await checkCampaignEntry(CLIENT_ID, {
      db: fakeStore(
        ready({
          plan: planOf(),
          keys: [{ key: campaignCreateKey(PLAN_ID, 0), entityId: '777' }],
          // Заявка применена, но это ничего не доказывает: в dry-run она такая же.
          approvals: [approval({ decision: ApprovalDecision.APPLIED })],
        }),
      ),
      now,
    });
    expect(outcome).toMatchObject({ kind: 'already_created', planId: PLAN_ID });
    expect(renderEntryBlock(outcome as never)).toContain('777');
  });

  it('незавершённая попытка требует человека, а не повтора', async () => {
    const outcome = await checkCampaignEntry(CLIENT_ID, {
      db: fakeStore(
        ready({
          plan: planOf(),
          keys: [{ key: campaignCreateKey(PLAN_ID, 0), entityId: 'pending' }],
        }),
      ),
      now,
    });
    expect(outcome.kind).toBe('attempt_unresolved');
    expect(renderEntryBlock(outcome as never)).toContain('вручную');
  });

  it('по наполовину созданному плану переспрашиваем только про нетронутые кампании', async () => {
    const outcome = await checkCampaignEntry(CLIENT_ID, {
      db: fakeStore(
        ready({
          plan: planOf(2),
          // Первую кампанию создали, по второй человек нажал ❌ — ключа нет.
          keys: [{ key: campaignCreateKey(PLAN_ID, 0), entityId: '777' }],
        }),
      ),
      now,
    });
    expect(outcome.kind).toBe('ready');
    if (outcome.kind !== 'ready') return;

    expect(outcome.reusablePlan?.untouched).toEqual([1]);
    expect(outcome.notes.join(' ')).toContain('уже создана: 1 из 2');

    const text = renderReadiness(outcome);
    expect(text).toContain('модель звать не буду');
    expect(text).toContain('которых ещё нет в кабинете: 1 из 2');
  });

  it('план, собранный до правки брифа, переиспользованию не подлежит', async () => {
    const outcome = await checkCampaignEntry(CLIENT_ID, {
      db: fakeStore(
        ready({
          plan: planOf(),
          brief: { data: briefOf(), updatedAt: new Date('2026-08-10T10:00:00Z') },
        }),
      ),
      now,
    });
    expect(outcome.kind).toBe('ready');
    if (outcome.kind !== 'ready') return;

    // Иначе человек одобрит карточку с бюджетом, о котором он уже передоговорился.
    expect(outcome.reusablePlan).toBeNull();
    expect(outcome.notes.join(' ')).toContain('Бриф менялся');
  });

  it('готовность показывает деньги, регионы и режим до вызова модели', async () => {
    const outcome = await checkCampaignEntry(CLIENT_ID, {
      db: fakeStore(
        ready({
          brief: { data: briefOf({ geo: ['Московская область'], negativeCities: ['Москва'] }) },
        }),
      ),
      dryRun: true,
      now,
    });
    expect(outcome.kind).toBe('ready');
    if (outcome.kind !== 'ready') return;

    expect(outcome.budgets.map((b) => b.dailyBudgetRub)).toEqual([3_500, 1_500]);
    expect(outcome.dryRun).toBe(true);

    const text = renderReadiness(outcome);
    expect(text).toContain('3 500 ₽/сут');
    expect(text).toContain('Московская область (кроме: Москва)');
    expect(text).toContain('DRY_RUN включён');
    expect(text).toContain('два платных вызова модели');
  });
});

describe('launchCampaign', () => {
  const deps = (state: FakeState) => ({ db: fakeStore(state), submit: vi.fn(() => []) });

  it('готовый план прошлого захода переиспользуется: модель не зовут', async () => {
    const planner = vi.fn();
    const submit = vi.fn().mockResolvedValue([{ id: 'appr-1' }]);

    const outcome = await launchCampaign(CLIENT_ID, {
      db: fakeStore(ready({ plan: planOf() })),
      planner: planner as never,
      submit: submit as never,
    });

    expect(planner).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ kind: 'submitted', reused: true });
  });

  it('карточки по наполовину созданному плану выпускаются только на нетронутые', async () => {
    const submit = vi.fn().mockResolvedValue([{ id: 'appr-2' }]);

    const outcome = await launchCampaign(CLIENT_ID, {
      db: fakeStore(
        ready({
          plan: planOf(2),
          keys: [{ key: campaignCreateKey(PLAN_ID, 0), entityId: '777' }],
        }),
      ),
      planner: vi.fn() as never,
      submit: submit as never,
    });

    // Позиции плана, а не порядковые номера в отфильтрованном списке: из позиции
    // выводится ключ идемпотентности.
    expect(submit.mock.calls[0]?.[1]).toMatchObject({ campaignIndexes: [1] });
    expect(outcome).toMatchObject({ kind: 'submitted', reused: true, campaignIndexes: [1] });
  });

  it('--new собирает новый план поверх уже созданных кампаний', async () => {
    const planner = vi.fn().mockResolvedValue(planOf());
    const submit = vi.fn().mockResolvedValue([]);

    const outcome = await launchCampaign(CLIENT_ID, {
      db: fakeStore(
        ready({ plan: planOf(), keys: [{ key: campaignCreateKey(PLAN_ID, 0), entityId: '777' }] }),
      ),
      fresh: true,
      planner: planner as never,
      submit: submit as never,
    });

    expect(planner).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ kind: 'submitted', reused: false });
  });

  it('без --new повтор поверх созданных кампаний не строит второй план', async () => {
    const planner = vi.fn();
    const outcome = await launchCampaign(CLIENT_ID, {
      db: fakeStore(
        ready({ plan: planOf(), keys: [{ key: campaignCreateKey(PLAN_ID, 0), entityId: '777' }] }),
      ),
      planner: planner as never,
      submit: deps(ready()).submit as never,
    });

    expect(planner).not.toHaveBeenCalled();
    expect(outcome.kind).toBe('already_created');
  });

  it('отказ планировщика пересказывается человеку, а не пробрасывается', async () => {
    const planner = vi
      .fn()
      .mockRejectedValue(new EmptyPlanError(CLIENT_ID, 'модель не вернула ни одного текста'));

    const outcome = await launchCampaign(CLIENT_ID, {
      db: fakeStore(ready()),
      planner: planner as never,
      submit: vi.fn() as never,
    });

    expect(outcome).toMatchObject({
      kind: 'not_plannable',
      reason: 'модель не вернула ни одного текста',
    });
  });

  it('сбой, который не про данные клиента, наружу не прячется', async () => {
    const planner = vi.fn().mockRejectedValue(new Error('postgres упал'));

    await expect(
      launchCampaign(CLIENT_ID, {
        db: fakeStore(ready()),
        planner: planner as never,
        submit: vi.fn() as never,
      }),
    ).rejects.toThrow('postgres упал');
  });

  it('dry-run из окружения уезжает в карточку, и опция его не снимает', async () => {
    // Предпосылка, а не проверяемое поведение: предохранитель в тестах включён
    // (vitest.setup.ts). Ожидание ниже — литерал: взять его из того же
    // `env.DRY_RUN`, который читает проверяемая функция, значило бы сверить код
    // сам с собой — такая проверка зелена при любой формуле внутри.
    expect(env.DRY_RUN).toBe(true);

    const submit = vi.fn().mockResolvedValue([]);
    await launchCampaign(CLIENT_ID, {
      db: fakeStore(ready({ plan: planOf() })),
      submit: submit as never,
    });
    expect(submit.mock.calls[0]?.[1]).toMatchObject({ dryRun: true });

    submit.mockClear();
    await launchCampaign(CLIENT_ID, {
      db: fakeStore(ready({ plan: planOf() })),
      dryRun: true,
      submit: submit as never,
    });
    expect(submit.mock.calls[0]?.[1]).toMatchObject({ dryRun: true });

    // Опция умеет только усилить защиту: снять её отсюда нельзя.
    submit.mockClear();
    await launchCampaign(CLIENT_ID, {
      db: fakeStore(ready({ plan: planOf() })),
      dryRun: false,
      submit: submit as never,
    });
    expect(submit.mock.calls[0]?.[1]).toMatchObject({ dryRun: true });
  });
});

describe('renderPlanSummary', () => {
  it('показывает состав плана: группы, фразы, объявления и регионы', () => {
    const text = renderPlanSummary(planOf(2), { dryRun: false });

    expect(text).toContain('Общий дневной бюджет: 7 000 ₽/сут');
    expect(text).toContain('Групп: 1, фраз: 1, объявлений: 1');
    expect(text).toContain('Регионы: Москва');
    expect(text).toContain('DRY_RUN снят');
  });

  it('часть плана считает деньги по себе, а не по всему плану', () => {
    const text = renderPlanSummary(planOf(2), { dryRun: false, only: [1] });

    // 7 000 ₽ здесь было бы обещанием списать и то, что уже списывается.
    expect(text).toContain('Общий дневной бюджет: 3 500 ₽/сут');
    expect(text).toContain('из них уже создано: 1');
    expect(text).toContain('Поиск — Курсы 2');
    expect(text).not.toContain('Поиск — Курсы 1');
  });

  it('группа без фраз показывает «не задано», а не ставку в ноль рублей', () => {
    const plan = planOf();
    const group = plan.campaigns[0]?.adGroups[0];
    if (!group || !plan.campaigns[0]) throw new Error('фикстура плана сломана');
    plan.campaigns[0].adGroups = [{ ...group, keywords: [] }];

    const text = renderPlanSummary(plan, { dryRun: false });
    expect(text).toContain('ставка не задана');
    expect(text).not.toContain('ставка 0');
  });

  it('длинный план не перечисляет все группы поимённо', () => {
    const plan = planOf();
    const group = plan.campaigns[0]?.adGroups[0];
    if (!group || !plan.campaigns[0]) throw new Error('фикстура плана сломана');
    plan.campaigns[0].adGroups = Array.from({ length: 12 }, (_, i) => ({
      ...group,
      name: `Группа ${i + 1}`,
    }));

    const text = renderPlanSummary(plan, { dryRun: false, maxGroups: 3 });
    expect(text).toContain('и ещё групп: 9');
  });
});
