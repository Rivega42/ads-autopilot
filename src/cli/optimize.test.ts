import { describe, expect, it, vi } from 'vitest';

import { runOptimizeCommand, type OptimizeCampaign, type OptimizeCommandDeps } from './optimize.js';

import type { OptimizerRun } from '@/optimizer/index.js';
import type { Decision, ScheduledOptimizationSummary } from '@/optimizer/index.js';

function collector() {
  const lines: string[] = [];
  return { out: (line: string) => lines.push(line), text: () => lines.join('\n') };
}

const CAMPAIGN: OptimizeCampaign = { id: 'cmp_1', name: 'Поиск — Слоны', clientId: 'cl_1' };

function decision(over: Partial<Decision> = {}): Decision {
  return {
    action: 'BID_DECREASE',
    entityType: 'KEYWORD',
    entityId: 'kw_1',
    label: 'купить слона',
    prevValue: { kind: 'bid', amount: 30 },
    nextValue: { kind: 'bid', amount: 25.5 },
    reason: 'CPA 2100 ₽ при цели 1000 ₽ за 7 дней',
    requiresApproval: false,
    layer: 'rule',
    ruleId: 'cpa_high',
    approvalKind: null,
    ...over,
  };
}

function runOf(over: Partial<OptimizerRun> = {}): OptimizerRun {
  return {
    campaignId: CAMPAIGN.id,
    runId: 'run_1',
    windowStart: new Date('2026-08-01T00:00:00Z'),
    windowEnd: new Date('2026-08-08T00:00:00Z'),
    dryRun: true,
    targets: null,
    targetCpaSource: 'brief',
    proposed: [],
    allowed: [],
    clamped: [],
    rejected: [],
    autoApply: [],
    approvals: [],
    skipped: null,
    ...over,
  };
}

function summaryOf(over: Partial<ScheduledOptimizationSummary> = {}): ScheduledOptimizationSummary {
  return {
    campaigns: 1,
    autoApply: 0,
    plannedOnly: 0,
    noop: 0,
    applyFailed: 0,
    localStateFailed: 0,
    approvals: 0,
    approvalsFailed: 0,
    approvalsUndelivered: 0,
    approvalsDuplicate: 0,
    rejected: 0,
    clamped: 0,
    noTargetCpa: 0,
    skipped: {},
    failed: 0,
    ...over,
  };
}

function depsWith(over: Partial<OptimizeCommandDeps> = {}): OptimizeCommandDeps {
  return {
    listCampaigns: () => Promise.resolve([CAMPAIGN]),
    preview: () => Promise.resolve(runOf()),
    applyAll: () => Promise.resolve(summaryOf()),
    dryRunEnv: false,
    ...over,
  };
}

describe('optimize: показ рекомендаций (пункт приёмки ТЗ §9.3)', () => {
  it('на пустой базе отправляет за данными, а не молчит', async () => {
    const sink = collector();
    const preview = vi.fn();
    await runOptimizeCommand(
      { apply: false },
      depsWith({ out: sink.out, listCampaigns: () => Promise.resolve([]), preview }),
    );

    expect(sink.text()).toContain('Кампаний нет');
    expect(sink.text()).toContain('ingest');
    expect(preview).not.toHaveBeenCalled();
  });

  it('печатает решение с сущностью и причиной, а не только код действия', async () => {
    const sink = collector();
    await runOptimizeCommand(
      { apply: false },
      depsWith({
        out: sink.out,
        preview: () => Promise.resolve(runOf({ autoApply: [decision()] })),
      }),
    );

    const text = sink.text();
    expect(text).toContain('Поиск — Слоны');
    expect(text).toContain('BID_DECREASE');
    expect(text).toContain('купить слона');
    expect(text).toContain('CPA 2100 ₽ при цели 1000 ₽');
    expect(text).toContain('Всего решений: 1');
    expect(text).toContain('ничего не применено');
  });

  it('заявку на апрув показывает текстом карточки', async () => {
    const sink = collector();
    await runOptimizeCommand(
      { apply: false },
      depsWith({
        out: sink.out,
        preview: () =>
          Promise.resolve(
            runOf({
              approvals: [
                {
                  kind: 'BID_CHANGE',
                  decisions: [decision({ requiresApproval: true })],
                  summary: 'Снизить ставку по 1 фразе',
                },
              ],
            }),
          ),
      }),
    );

    expect(sink.text()).toContain('BID_CHANGE');
    expect(sink.text()).toContain('Снизить ставку по 1 фразе');
  });

  it('отклонённое предохранителем печатается с названием рельса', async () => {
    const sink = collector();
    await runOptimizeCommand(
      { apply: false },
      depsWith({
        out: sink.out,
        preview: () =>
          Promise.resolve(
            runOf({
              rejected: [
                {
                  decision: decision({ label: 'свежая фраза' }),
                  rail: 'MIN_OBSERVATIONS',
                  note: 'данных за 1 день, нужно 3',
                },
              ],
              clamped: [
                {
                  decision: decision({ label: 'дорогая фраза' }),
                  original: decision({ label: 'дорогая фраза' }),
                  rail: 'MAX_BID_CHANGE',
                  note: 'изменение ставки ≤ 20%',
                },
              ],
            }),
          ),
      }),
    );

    const text = sink.text();
    expect(text).toContain('MIN_OBSERVATIONS');
    expect(text).toContain('данных за 1 день');
    expect(text).toContain('MAX_BID_CHANGE');
    expect(text).toContain('изменение ставки ≤ 20%');
  });

  it('кампания без цели по CPA названа отдельно: три правила из четырёх для неё молчат', async () => {
    const sink = collector();
    await runOptimizeCommand(
      { apply: false },
      depsWith({
        out: sink.out,
        preview: () => Promise.resolve(runOf({ targetCpaSource: null })),
      }),
    );
    expect(sink.text()).toContain('цели по CPA');
  });

  it('пропущенные кампании названы причиной пропуска', async () => {
    const sink = collector();
    await runOptimizeCommand(
      { apply: false },
      depsWith({
        out: sink.out,
        preview: () => Promise.resolve(runOf({ skipped: 'NO_STATISTICS' })),
      }),
    );
    expect(sink.text()).toContain('NO_STATISTICS');
  });

  it('пустой результат объясняется словами, а не пустым выводом', async () => {
    const sink = collector();
    await runOptimizeCommand({ apply: false }, depsWith({ out: sink.out }));
    expect(sink.text()).toContain('Рекомендаций нет');
  });
});

describe('optimize --apply', () => {
  it('применяет через ту же точку, что и крон, и печатает, что записано', async () => {
    const sink = collector();
    const preview = vi.fn();
    const applyAll = vi.fn(() =>
      Promise.resolve(summaryOf({ campaigns: 2, autoApply: 3, approvals: 1, rejected: 2 })),
    );

    await runOptimizeCommand(
      { apply: true, clientId: 'cl_1' },
      depsWith({ out: sink.out, preview, applyAll }),
    );

    // Раньше `--apply` менял только флаг в отчёте: ни одной ставки, ни одной
    // карточки, ни строки в ChangeLog — а вывод при этом читался как «применено».
    expect(applyAll).toHaveBeenCalledWith('cl_1');
    expect(preview).not.toHaveBeenCalled();
    const text = sink.text();
    expect(text).toContain('Изменений записано в кабинеты: 3');
    expect(text).toContain('Карточек апрува выпущено: 1');
    expect(text).toContain('Кампаний просмотрено: 2');
  });

  it('провалы применения видны в выводе, а не только в логе', async () => {
    const sink = collector();
    await runOptimizeCommand(
      { apply: true },
      depsWith({
        out: sink.out,
        applyAll: () =>
          Promise.resolve(summaryOf({ applyFailed: 2, approvalsFailed: 1, failed: 1 })),
      }),
    );

    const text = sink.text();
    expect(text).toContain('⚠️');
    expect(text).toContain('не записано в кабинет: 2');
    expect(text).toContain('карточек не выпущено: 1');
  });

  it('DRY_RUN в окружении старше флага: применения не происходит', async () => {
    const sink = collector();
    const applyAll = vi.fn();
    await runOptimizeCommand(
      { apply: true },
      depsWith({ out: sink.out, applyAll, dryRunEnv: true }),
    );

    expect(applyAll).not.toHaveBeenCalled();
    expect(sink.text()).toContain('--apply проигнорирован');
    expect(sink.text()).toContain('DRY_RUN');
  });
});

describe('optimize --apply: код возврата и полнота сводки', () => {
  it('чистый прогон человека не зовёт', async () => {
    const sink = collector();
    const needsHuman = await runOptimizeCommand(
      { apply: true },
      depsWith({ out: sink.out, applyAll: () => Promise.resolve(summaryOf({ autoApply: 3 })) }),
    );
    expect(needsHuman).toBe(false);
  });

  it('потери зовут человека кодом возврата, а не только строкой ⚠️', async () => {
    // Скрипт, обходящий клиентов, читает код возврата: «не записано в кабинет: 5»
    // при нулевом коде он не отличит от успеха.
    const sink = collector();
    const needsHuman = await runOptimizeCommand(
      { apply: true },
      depsWith({ out: sink.out, applyAll: () => Promise.resolve(summaryOf({ applyFailed: 5 })) }),
    );
    expect(needsHuman).toBe(true);
    expect(sink.text()).toContain('не записано в кабинет: 5');
  });

  it('повтор в те же сутки говорит, что карточки уже выпущены, а не «ничего не вышло»', async () => {
    const sink = collector();
    await runOptimizeCommand(
      { apply: true },
      depsWith({
        out: sink.out,
        applyAll: () => Promise.resolve(summaryOf({ approvals: 0, approvalsDuplicate: 2 })),
      }),
    );
    const text = sink.text();
    expect(text).toContain('Карточек апрува выпущено: 0');
    expect(text).toContain('уже выпущено раньше');
    expect(text).toContain(': 2');
  });

  it('пропущенные кампании названы и в сводке применения — как в показе', async () => {
    const sink = collector();
    await runOptimizeCommand(
      { apply: true },
      depsWith({
        out: sink.out,
        applyAll: () => Promise.resolve(summaryOf({ skipped: { NO_STATISTICS: 3 } })),
      }),
    );
    expect(sink.text()).toContain('Пропущено кампаний (NO_STATISTICS): 3');
  });

  it('область прогона названа: по сводке из одних чисел её было не видно', async () => {
    const one = collector();
    await runOptimizeCommand({ apply: true, clientId: 'cl_7' }, depsWith({ out: one.out }));
    expect(one.text()).toContain('Клиент: cl_7');

    const all = collector();
    await runOptimizeCommand({ apply: true }, depsWith({ out: all.out }));
    expect(all.text()).toContain('Клиенты: все');
  });
});
