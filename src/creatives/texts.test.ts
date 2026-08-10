import { describe, expect, it, vi } from 'vitest';

import { generateTextVariants, NoUsableVariantsError, validateDrafts } from './texts.js';
import type { CreativeTextsDraft } from './texts.schema.js';

import type { ClientBriefData } from '@/ai/onboarding/brief.schema.js';
import type { AgentRun } from '@/clients/llm/index.js';
import type { CreativeStore } from '@/creatives/store.js';

/**
 * Тексты креативов проверяются целиком, но без сети: модель и БД подменены,
 * промпт читается с диска. Ни один тест не должен уметь потратить деньги.
 */

const BRIEF: ClientBriefData = {
  product: 'Курсы английского для программистов',
  audience: { description: 'Разработчики 25-40 лет', ageFrom: 25, ageTo: 40 },
  geo: ['Москва'],
  negativeCities: [],
  usp: ['IT-лексика', 'Преподаватели из индустрии'],
  targetCpaRub: 2_000,
  dailyBudgetRub: 5_000,
  budgetScope: 'per_channel',
  competitors: [],
  conversionGoals: [{ name: 'заявка с формы' }],
  landingUrl: 'https://example.com/course',
};

const SEGMENT = {
  name: 'Горячий спрос',
  intent: 'Ищут курс прямо сейчас',
  keywords: ['курсы английского для программистов'],
};

function variantsDraft(count: number): CreativeTextsDraft {
  return {
    variants: Array.from({ length: count }, (_, i) => ({
      angle: `посыл-${i + 1}`,
      title: `Английский для IT ${i + 1}`,
      title2: 'Старт в любой день',
      text: `Разговорный курс с IT-лексикой. Вариант ${i + 1}.`,
    })),
  };
}

function runOf(
  data: CreativeTextsDraft,
  over: Partial<AgentRun<CreativeTextsDraft>> = {},
): () => Promise<AgentRun<CreativeTextsDraft>> {
  return () =>
    Promise.resolve({
      data,
      text: JSON.stringify(data),
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      usage: { tokensIn: 1_000, tokensOut: 500 },
      costUsd: 0.0105,
      latencyMs: 1_200,
      cached: false,
      aiRunId: '1',
      ...over,
    });
}

function storeOf(): { db: CreativeStore; created: () => Record<string, unknown> | undefined } {
  let captured: Record<string, unknown> | undefined;
  const db = {
    creative: {
      create: vi.fn((args: { data: Record<string, unknown> }) => {
        captured = args.data;
        return Promise.resolve({ id: 'creative-1' });
      }),
    },
  } as unknown as CreativeStore;
  return { db, created: () => captured };
}

describe('generateTextVariants', () => {
  it('возвращает проверенные варианты и просит у модели число из диапазона ТЗ', async () => {
    const run = vi.fn(runOf(variantsDraft(6)));
    const set = await generateTextVariants({
      clientId: 'c1',
      brief: BRIEF,
      segment: SEGMENT,
      run,
      persist: false,
    });

    expect(set.variants).toHaveLength(6);
    expect(set.rejected).toEqual([]);
    expect(set.promptVersion).toMatch(/^creatives-texts@/u);
    expect(run.mock.calls[0]?.[0]?.task).toBe('creatives.texts');
    expect(run.mock.calls[0]?.[0]?.system).toContain('Яндекс Директ');
  });

  it('зажимает количество вариантов в 5..10', async () => {
    const run = vi.fn(runOf(variantsDraft(5)));
    await generateTextVariants({
      clientId: 'c1',
      brief: BRIEF,
      segment: SEGMENT,
      count: 50,
      run,
      persist: false,
    });
    expect(run.mock.calls[0]?.[0]?.system).toContain('**10**');
  });

  it('для VK просит не заполнять второй заголовок и выбрасывает его из результата', async () => {
    const run = vi.fn(runOf(variantsDraft(5)));
    const set = await generateTextVariants({
      clientId: 'c1',
      brief: BRIEF,
      segment: SEGMENT,
      platform: 'vk_ads',
      run,
      persist: false,
    });

    expect(run.mock.calls[0]?.[0]?.system).toContain('второго заголовка нет');
    expect(set.variants.every((v) => v.title2 === undefined)).toBe(true);
  });

  it('записывает стоимость генерации в Creative', async () => {
    const { db, created } = storeOf();
    const set = await generateTextVariants({
      clientId: 'c1',
      brief: BRIEF,
      segment: SEGMENT,
      run: runOf(variantsDraft(6)),
      db,
    });

    expect(set.creativeId).toBe('creative-1');
    expect(set.costUsd).toBe(0.0105);
    expect(created()).toMatchObject({
      clientId: 'c1',
      kind: 'TEXT',
      provider: 'claude-sonnet-5',
      costUsd: 0.0105,
    });
  });

  it('неизвестная цена модели записывается как null, а не как ноль', async () => {
    const { db, created } = storeOf();
    await generateTextVariants({
      clientId: 'c1',
      brief: BRIEF,
      segment: SEGMENT,
      run: runOf(variantsDraft(5), { costUsd: null }),
      db,
    });
    expect(created()?.costUsd).toBeNull();
  });

  it('без db строку Creative не пишет, но варианты отдаёт', async () => {
    const set = await generateTextVariants({
      clientId: 'c1',
      brief: BRIEF,
      segment: SEGMENT,
      run: runOf(variantsDraft(5)),
    });
    expect(set.creativeId).toBeNull();
    expect(set.variants).toHaveLength(5);
  });

  it('падает, если после проверки лимитов не осталось ни одного варианта', async () => {
    const broken: CreativeTextsDraft = {
      variants: [
        // Пустой заголовок Директ отклоняет так же, как слишком длинный,
        // и обрезка его не спасает — вариант обязан быть отброшен целиком.
        { angle: 'пустой', title: '   ', text: 'Разговорный курс с IT-лексикой.' },
      ],
    };
    await expect(
      generateTextVariants({
        clientId: 'c1',
        brief: BRIEF,
        segment: SEGMENT,
        run: runOf(broken),
        persist: false,
      }),
    ).rejects.toBeInstanceOf(NoUsableVariantsError);
  });

  it('предупреждает, когда вариантов меньше рекомендованных пяти', async () => {
    const set = await generateTextVariants({
      clientId: 'c1',
      brief: BRIEF,
      segment: SEGMENT,
      run: runOf(variantsDraft(2)),
      persist: false,
    });
    expect(set.warnings.join(' ')).toContain('меньше рекомендованных');
  });
});

describe('validateDrafts', () => {
  it('обрезает то, что можно спасти, и помечает вариант', () => {
    const draft: CreativeTextsDraft = {
      variants: [
        {
          angle: 'срок',
          title: 'Курсы английского языка для программистов и тестировщиков',
          text: 'Короткий текст.',
        },
      ],
    };
    const { variants } = validateDrafts(draft, 'yandex_direct');
    expect(variants[0]?.truncated).toBe(true);
    expect(variants[0]?.title).toBe('Курсы английского языка для');
  });

  it('отбрасывает дубликаты: одинаковый текст — это один вариант', () => {
    const one = {
      angle: 'цена',
      title: 'Английский для IT',
      text: 'Разговорный курс с IT-лексикой.',
    };
    const { variants, rejected } = validateDrafts(
      { variants: [one, { ...one, angle: 'срок' }] },
      'yandex_direct',
    );
    expect(variants).toHaveLength(1);
    expect(rejected[0]?.reason).toContain('дубликат');
  });

  it('id варианта зависит только от текста, а не от порядка', () => {
    const a = validateDrafts(
      { variants: [{ angle: 'x', title: 'Заголовок', text: 'Текст объявления.' }] },
      'yandex_direct',
    );
    const b = validateDrafts(
      {
        variants: [
          { angle: 'y', title: 'Другой', text: 'Другой текст тут.' },
          { angle: 'z', title: 'Заголовок', text: 'Текст объявления.' },
        ],
      },
      'yandex_direct',
    );
    expect(a.variants[0]?.id).toBe(b.variants[1]?.id);
  });

  it('копит предупреждения об обрезке', () => {
    const warnings: string[] = [];
    validateDrafts(
      {
        variants: [
          {
            angle: 'a',
            title: 'Курсы английского языка для программистов и тестировщиков',
            text: 'Текст.',
          },
        ],
      },
      'yandex_direct',
      warnings,
    );
    expect(warnings.join(' ')).toContain('Обрезано под лимиты');
  });
});
