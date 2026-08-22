import { Provider } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DECISION_ACTIONS,
  SERVICE_ACTIONS,
  changeActionLabel,
  describeChange,
} from '../../web/lib/labels.js';
import { listChangesView } from '../../web/lib/queries.js';

import {
  dashboardFilters,
  disconnectDashboardPrisma,
  expectRenderable,
} from './support/dashboard-checks.js';
import {
  BID_PAIR,
  seedApprovedBidChange,
  seedDashboard,
  seedOptimizerBidChange,
  type SeededDashboard,
} from './support/dashboard-seed.js';
import { resetDatabase } from './support/database.js';

import { approvalActionSchema } from '@/approval/types.js';
import { ESCALATION_ACTION, MISSING_ACTION, REWRITE_ACTION } from '@/moderation/repair.js';

/**
 * Карта названий действий против настоящих писателей журнала.
 *
 * Было сломано: `web/lib/labels.ts` знал `bid_up`, `bid_down` и `pause` — их не
 * пишет никто, — а восемнадцать действий, которые система пишет на самом деле,
 * доезжали до человека сырыми идентификаторами. Карта устарела целиком и молча,
 * потому что промах подставлял сам идентификатор в ту же колонку, где стоят
 * человеческие названия: отличить «нет названия» от «название такое» было нельзя.
 *
 * Здесь словари берутся у самого кода, а не переписываются в тест:
 * `approvalActionSchema` — тот же объект, по которому apply разбирает payload,
 * `*_ACTION` — те же константы, которые уходят в `ChangeLog.action`. Скопировать
 * список значило бы завести вторую карту, которая устареет так же.
 *
 * Канонические решения (`DecisionAction`) сюда не попадают намеренно: их полноту
 * держит `Record<DecisionAction, string>` в самой карте, и промах там —
 * ошибка компиляции, а не красный тест.
 */

let seeded: SeededDashboard;

/** Виды действий апрува — прямо из discriminated union, без копии. */
function approvalActionKinds(): readonly string[] {
  return approvalActionSchema.options.map((option) => option.shape.kind.value);
}

beforeAll(async () => {
  await resetDatabase();
  seeded = await seedDashboard();
});

afterAll(async () => {
  await disconnectDashboardPrisma();
});

describe('витрина: названия действий', () => {
  it('у каждого действия апрува есть название', () => {
    const kinds = approvalActionKinds();

    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) {
      expect(describeChange({ action: kind, actor: 'USER', approvedBy: null }).form, kind).toBe(
        'decision',
      );
    }
  });

  it('карта решений не описывает того, чего апрув не пишет', () => {
    // Обратная сторона: мёртвые ключи и есть то, чем карта была занята целиком.
    expect(Object.keys(DECISION_ACTIONS).sort()).toEqual([...approvalActionKinds()].sort());
  });

  it('у каждой отметки модерации есть название', () => {
    for (const action of [REWRITE_ACTION, ESCALATION_ACTION, MISSING_ACTION]) {
      expect(describeChange({ action, actor: 'AI', approvedBy: null }).form, action).toBe(
        'service',
      );
    }
  });

  it('карта модерации не описывает того, чего модерация не пишет', () => {
    expect(Object.keys(SERVICE_ACTIONS).sort()).toEqual(
      [REWRITE_ACTION, ESCALATION_ACTION, MISSING_ACTION].sort(),
    );
  });

  it('незнакомое действие видно человеку, а не выдаёт себя за название', async () => {
    // В сиде лежат заведомо чужие действия (`edge-*`). Витрина обязана показать
    // их идентификатором и пометить, а не молча подставить в колонку названий.
    const view = await listChangesView(dashboardFilters());
    const alien = view.rows.filter((row) => describeChange(row).form === 'unknown');

    expect(alien.length).toBeGreaterThan(0);
    for (const row of alien) {
      const described = describeChange(row);
      expect(described.label).toBe(row.action);
      expect(described.note).not.toBeNull();
    }
    expectRenderable('changes', view.rows);
  });
});

/**
 * Одно изменение ставки, выпущенное человеком, лежит в журнале двумя строками.
 * Так сделано намеренно (см. `approval/bid-journal.ts`), но клиент на витрине
 * читал их как два изменения подряд.
 */
describe('витрина: пара строк за одно изменение ставки', () => {
  beforeAll(async () => {
    await seedApprovedBidChange(
      seeded.campaignIds.search,
      'internal-keyword-77',
      Provider.YANDEX_DIRECT,
    );
    await seedOptimizerBidChange(
      seeded.campaignIds.search,
      'internal-keyword-88',
      Provider.YANDEX_DIRECT,
    );
  });

  it('обе строки остаются в истории', async () => {
    const view = await listChangesView(dashboardFilters({ to: '2026-07-31' }));
    const actions = view.rows.map((row) => row.action);

    expect(actions).toContain('bid_change');
    expect(actions).toContain('BID_DECREASE');
  });

  it('ровно одна строка пары называет изменение, вторая помечена как не отдельное', async () => {
    const view = await listChangesView(dashboardFilters({ to: '2026-07-31' }));
    const pair = view.rows.filter((row) => row.reason === BID_PAIR.reason);

    expect(pair).toHaveLength(2);
    expect(pair.filter((row) => describeChange(row).duplicate)).toHaveLength(1);

    const twin = pair.find((row) => describeChange(row).duplicate);
    expect(twin?.action).toBe('BID_DECREASE');
    expect(describeChange(twin!).note).not.toBeNull();
  });

  it('решение человека остаётся полноценной строкой истории', async () => {
    const view = await listChangesView(dashboardFilters({ to: '2026-07-31' }));
    const decision = view.rows.find((row) => row.action === 'bid_change');

    expect(decision).toBeDefined();
    expect(describeChange(decision!).duplicate).toBe(false);
    expect(describeChange(decision!).label).toBe(changeActionLabel('bid_change'));
    // Ставки до и после в ней есть — поэтому прятать каноническую строку было бы
    // возможно, а прятать эту нельзя ни при каких условиях.
    expect(JSON.stringify(decision?.newValue)).toContain(String(BID_PAIR.bidAfter));
  });

  it('ставка, которую двигал ночной прогон, дублем не помечается', async () => {
    // У неё нет и не может быть парной строки решения: пометить её технической —
    // значит объявить служебной единственную запись об изменении.
    const view = await listChangesView(dashboardFilters({ to: '2026-07-31' }));
    const nightly = view.rows.find((row) => row.action === 'BID_INCREASE');

    expect(nightly).toBeDefined();
    expect(nightly?.actor).toBe('AI');
    expect(describeChange(nightly!).duplicate).toBe(false);
  });
});
