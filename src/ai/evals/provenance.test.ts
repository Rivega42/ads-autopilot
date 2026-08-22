import { describe, expect, it } from 'vitest';

import { describeEvalTrust } from './provenance.js';
import type { EvalBaseline } from './score.js';

const FINGERPRINT = 'aaaaaaaaaaaaaaaa';

function baseline(patch: Partial<EvalBaseline> = {}): EvalBaseline {
  return {
    promptVersion: '1.1.0',
    promptFingerprint: FINGERPRINT,
    source: 'live',
    recordedAt: '2026-08-08T14:08:03.074Z',
    cases: { demo: 1 },
    aggregate: 1,
    ...patch,
  };
}

const LIVE_CASE = { id: 'demo', source: 'live' as const, promptFingerprint: FINGERPRINT };

describe('describeEvalTrust', () => {
  it('живой прогон считает доверенным', () => {
    const trust = describeEvalTrust({
      live: true,
      cases: [LIVE_CASE],
      baseline: baseline(),
      promptFingerprint: FINGERPRINT,
    });

    expect(trust.trusted).toBe(true);
    expect(trust.handwritten).toEqual([]);
  });

  it('офлайн на ручных фикстурах кричит об этом в заголовке', () => {
    const trust = describeEvalTrust({
      live: false,
      cases: [{ ...LIVE_CASE, source: 'handwritten' }],
      baseline: baseline({ source: 'handwritten' }),
      promptFingerprint: FINGERPRINT,
    });

    expect(trust.trusted).toBe(false);
    expect(trust.handwritten).toEqual(['demo']);
    // Заголовок уезжает в имя теста: его видно в каждом прогоне CI, а не только в логе.
    expect(trust.headline).toContain('НЕ проверен');
    expect(trust.banner).toContain('demo');
  });

  it('офлайн на записях живого прогона тоже не проверяет модель, но врать не даёт', () => {
    const trust = describeEvalTrust({
      live: false,
      cases: [LIVE_CASE],
      baseline: baseline(),
      promptFingerprint: FINGERPRINT,
    });

    expect(trust.trusted).toBe(false);
    expect(trust.handwritten).toEqual([]);
    expect(trust.headline).toContain('офлайн');
  });

  it('замечает фикстуру без пометки происхождения', () => {
    const trust = describeEvalTrust({
      live: false,
      cases: [{ id: 'demo', promptFingerprint: FINGERPRINT }],
      baseline: baseline(),
      promptFingerprint: FINGERPRINT,
    });

    expect(trust.unmarked).toEqual(['demo']);
  });

  it('замечает фикстуру, записанную на другом тексте промпта', () => {
    const trust = describeEvalTrust({
      live: false,
      cases: [{ ...LIVE_CASE, promptFingerprint: 'bbbbbbbbbbbbbbbb' }],
      baseline: baseline(),
      promptFingerprint: FINGERPRINT,
    });

    // Версию в фикстуре можно поправить рукой, отпечаток текста — нет.
    expect(trust.stale).toEqual(['demo']);
  });

  it('замечает baseline, снятый не с живого прогона', () => {
    const trust = describeEvalTrust({
      live: false,
      cases: [LIVE_CASE],
      baseline: baseline({ source: 'offline-replay' }),
      promptFingerprint: FINGERPRINT,
    });

    expect(trust.banner).toContain('offline-replay');
  });

  it('отсутствие baseline не роняет разбор', () => {
    const trust = describeEvalTrust({
      live: false,
      cases: [LIVE_CASE],
      baseline: null,
      promptFingerprint: FINGERPRINT,
    });

    expect(trust.banner).toContain('baseline');
  });
});
