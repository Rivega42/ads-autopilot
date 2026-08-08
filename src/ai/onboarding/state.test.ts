import { describe, expect, it } from 'vitest';

import {
  emptyTranscript,
  lastAssistantTurn,
  parseDraft,
  parseTranscript,
  toJsonValue,
  toLlmMessages,
  userMessages,
  KICKOFF_MESSAGE,
  TRANSCRIPT_VERSION,
  type InterviewTranscript,
} from './state.js';

function transcript(): InterviewTranscript {
  return {
    version: TRANSCRIPT_VERSION,
    askedCount: 2,
    turns: [
      { role: 'assistant', text: 'Что продаём?', at: '2026-08-08T10:00:00.000Z' },
      { role: 'user', text: 'Курсы английского', at: '2026-08-08T10:01:00.000Z' },
      { role: 'assistant', text: 'Кто клиент?', at: '2026-08-08T10:02:00.000Z' },
    ],
  };
}

describe('parseTranscript', () => {
  it('читает свой формат', () => {
    expect(parseTranscript(transcript()).turns).toHaveLength(3);
  });

  it('на мусоре отдаёт пустую историю, а не падает', () => {
    // Историю вопросов потерять не страшно, ответы клиента лежат в data.
    expect(parseTranscript('сломано')).toEqual(emptyTranscript());
    expect(parseTranscript(null)).toEqual(emptyTranscript());
    expect(parseTranscript({ version: 99, turns: [] })).toEqual(emptyTranscript());
  });
});

describe('parseDraft', () => {
  it('оставляет только то, что проходит схему брифа', () => {
    expect(parseDraft({ product: 'Курсы', мусор: 1 })).toEqual({ product: 'Курсы' });
    expect(parseDraft('не объект')).toEqual({});
  });
});

describe('toLlmMessages', () => {
  it('начинает историю с user-хода: Anthropic не примет иначе', () => {
    const messages = toLlmMessages(transcript());
    expect(messages[0]).toEqual({ role: 'user', content: KICKOFF_MESSAGE });
    expect(messages).toHaveLength(4);
  });

  it('обрезает хвостом, чтобы длинное интервью не разносило контекст', () => {
    const long: InterviewTranscript = {
      version: TRANSCRIPT_VERSION,
      askedCount: 50,
      turns: Array.from({ length: 50 }, (_, i) => ({
        role: i % 2 === 0 ? ('assistant' as const) : ('user' as const),
        text: `ход ${i}`,
        at: '2026-08-08T10:00:00.000Z',
      })),
    };

    const messages = toLlmMessages(long, 10);
    expect(messages).toHaveLength(11);
    expect(messages.at(-1)?.content).toBe('ход 49');
  });
});

describe('lastAssistantTurn и userMessages', () => {
  it('находят последний вопрос и все ответы клиента', () => {
    expect(lastAssistantTurn(transcript())?.text).toBe('Кто клиент?');
    expect(userMessages(transcript())).toEqual(['Курсы английского']);
    expect(lastAssistantTurn(emptyTranscript())).toBeUndefined();
  });
});

describe('toJsonValue', () => {
  it('выкидывает undefined: Prisma поняла бы их как «не менять поле»', () => {
    expect(toJsonValue({ a: 1, b: undefined })).toEqual({ a: 1 });
  });

  it('пустой ввод превращает в null, а не в undefined', () => {
    expect(toJsonValue(undefined)).toBeNull();
  });
});
