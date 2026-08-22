import { Provider } from '@prisma/client';
import { beforeAll, describe, expect, it } from 'vitest';

import { executeAction } from '@/approval/execute.js';
import { unsupportedActionReason } from '@/approval/supported.js';
import {
  approvalActionSchema,
  parseAction,
  type ApprovalAction,
  type ApprovalActionInput,
  type ApprovalActionKind,
} from '@/approval/types.js';
import { campaignWriters } from '@/campaigns/apply.js';
import { bootstrapChannels } from '@/channels/bootstrap.js';
import type { ChannelContext, StatLevel } from '@/channels/types.js';

/**
 * Инвариант: пара «вид действия × канал» либо исполнима, либо карточка не выпускается.
 *
 * Прошлая версия проверки держалась по виду действия и подставляла адаптер, который
 * умеет всё, — а до кабинета едет не он. С настоящим `vkAdsAdapter` объявленное
 * `add_negatives` отвечает «канал не умеет минус-слова», а `pause_entities` с уровнем
 * `keyword` — «VK has no entity level». Сегодня такие карточки не рождаются по
 * стечению обстоятельств (у VK нет источника поисковых запросов, а правило паузы
 * фраз кормится ими же), но это не инвариант, а везение.
 *
 * Поэтому здесь: каждая пара прогоняется против **настоящих** адаптеров, а объявление
 * (`unsupportedActionReason`, по которому отказывает `createApproval`) обязано с ними
 * совпасть. Отсюда же следует, почему `executeAction` намеренно НЕ сверяется с тем же
 * объявлением: проверка стала бы сверкой таблицы с самой собой и перестала бы ловить
 * расхождение.
 */

/** Ставит dry-run: ни один настоящий адаптер в этом режиме не ходит в сеть. */
const PROBE_CTX: ChannelContext = { clientId: 'probe', credentials: {}, dryRun: true };

const LEVELS: readonly StatLevel[] = ['campaign', 'adgroup', 'ad', 'keyword'];

/**
 * Идентификаторы намеренно числовые: Директ проверяет их числом при настоящей записи,
 * и нечисловой id в пробе спутал бы «канал не умеет» с «id не годится».
 */
function samplesFor(channel: Provider): Array<[string, ApprovalActionInput]> {
  const base = { clientId: 'cl1', channel, reason: 'проба' } as const;
  const samples: Array<[string, ApprovalActionInput]> = [
    [
      'create_campaign',
      { ...base, kind: 'create_campaign', campaignName: 'SEO', dailyBudget: 500 },
    ],
    [
      'budget_change',
      {
        ...base,
        kind: 'budget_change',
        campaignExternalId: '777',
        campaignName: 'SEO',
        before: 5000,
        after: 8000,
      },
    ],
    ['bid_change', { ...base, kind: 'bid_change', changes: [{ keywordExternalId: '1', bid: 30 }] }],
    [
      'add_negatives',
      { ...base, kind: 'add_negatives', campaignExternalId: '777', phrases: ['бесплатно'] },
    ],
  ];

  for (const level of LEVELS) {
    samples.push([
      `pause_entities:${level}`,
      { ...base, kind: 'pause_entities', level, externalIds: ['1'] },
    ]);
    samples.push([
      `resume_entities:${level}`,
      { ...base, kind: 'resume_entities', level, externalIds: ['1'] },
    ]);
  }

  return samples;
}

/**
 * Умеет ли канал это действие на самом деле.
 *
 * Для действий адаптера — вызов настоящего адаптера в dry-run: успешный план значит
 * «умеет», любое исключение — «нет». Ни кода ошибки, ни имени канала здесь нет
 * намеренно: новый адаптер вправе назвать свой отказ по-своему, а «в dry-run бросил»
 * — это уже неисполнимая пара, чем бы её ни объяснили.
 *
 * Создание кампании через `executeAction` не проверить: исполнитель требует ссылку на
 * сохранённый план и живую БД. Его исполнимость определяет ровно наличие writer'а —
 * его и сверяем.
 */
async function reallyExecutable(action: ApprovalAction): Promise<boolean> {
  if (action.kind === 'create_campaign') {
    return campaignWriters()[action.channel] !== undefined;
  }
  try {
    await executeAction(PROBE_CTX, action);
    return true;
  } catch {
    return false;
  }
}

function declaredKinds(): ApprovalActionKind[] {
  return approvalActionSchema.options.map((option) => option.shape.kind.value);
}

describe('unsupportedActionReason', () => {
  beforeAll(() => {
    bootstrapChannels();
  });

  it('пробы покрывают ровно те виды действий, что объявлены в схеме', () => {
    const covered = new Set(
      samplesFor(Provider.YANDEX_DIRECT).map(([label]) => label.split(':')[0]),
    );
    expect(covered).toEqual(new Set(declaredKinds()));
  });

  for (const channel of Object.values(Provider)) {
    it(`объявление про ${channel} совпадает с тем, что умеет настоящий канал`, async () => {
      const declared: Record<string, boolean> = {};
      const real: Record<string, boolean> = {};

      for (const [label, input] of samplesFor(channel)) {
        const action = parseAction(input);
        declared[label] = unsupportedActionReason(action) === null;
        real[label] = await reallyExecutable(action);
      }

      expect(real).toEqual(declared);
    });
  }

  it('отказ называет и канал, и вид действия: по тексту видно, что чинить', () => {
    const reason = unsupportedActionReason(
      parseAction({
        clientId: 'cl1',
        channel: Provider.VK_ADS,
        reason: 'проба',
        kind: 'add_negatives',
        campaignExternalId: '777',
        phrases: ['бесплатно'],
      }),
    );

    expect(reason).toContain('VK_ADS');
    expect(reason).toContain('минус-слов');
  });

  it('канал без адаптера не умеет ничего: применять такую заявку будет некому', () => {
    for (const [, input] of samplesFor(Provider.TIKTOK_ADS)) {
      expect(unsupportedActionReason(parseAction(input))).not.toBeNull();
    }
  });
});
