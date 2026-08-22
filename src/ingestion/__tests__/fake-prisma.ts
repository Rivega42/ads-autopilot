import type { PrismaClient } from '@prisma/client';

/**
 * Минимальный Postgres в памяти: ровно те операции, которыми пользуется
 * ingestion, но с настоящей семантикой upsert, составных ключей и связей.
 *
 * Мокать каждый вызов по отдельности здесь бесполезно: проверять надо как раз
 * то, что повторный прогон обновляет строку, а не добавляет вторую, — а это
 * свойство хранилища, а не вызова. `delete`/`deleteMany` намеренно падают:
 * ingestion не имеет права удалять историю.
 */

export type FakeRow = Record<string, unknown>;

interface Relation {
  target: ModelName;
  get: (row: FakeRow, store: Store) => FakeRow | undefined;
}

export type ModelName =
  | 'client'
  | 'credential'
  | 'campaign'
  | 'adGroup'
  | 'ad'
  | 'keyword'
  | 'campaignStat'
  | 'searchQueryStat'
  | 'changeLog'
  | 'errorLog';

type Store = Record<ModelName, FakeRow[]>;

const RELATIONS: Partial<Record<ModelName, Record<string, Relation>>> = {
  credential: {
    client: { target: 'client', get: (row, s) => find(s.client, 'id', row['clientId']) },
  },
  campaign: {
    client: { target: 'client', get: (row, s) => find(s.client, 'id', row['clientId']) },
  },
  adGroup: {
    campaign: { target: 'campaign', get: (row, s) => find(s.campaign, 'id', row['campaignId']) },
  },
  ad: {
    adGroup: { target: 'adGroup', get: (row, s) => find(s.adGroup, 'id', row['adGroupId']) },
  },
  keyword: {
    adGroup: { target: 'adGroup', get: (row, s) => find(s.adGroup, 'id', row['adGroupId']) },
  },
};

/** Колонки со значением по умолчанию — иначе create отдавал бы undefined там, где схема обещает 0. */
const DEFAULTS: Partial<Record<ModelName, FakeRow>> = {
  client: { metrikaCounterId: null, metrikaGoalId: null, metrikaAttribution: null },
  campaign: { status: 'DRAFT' },
  adGroup: { status: 'ACTIVE', targetings: null },
  ad: { moderationStatus: 'PENDING', moderationRetries: 0, supersededExternalIds: [] },
  keyword: { status: 'ACTIVE', matchType: 'PHRASE', externalId: null, bid: null },
  campaignStat: {
    impressions: 0,
    clicks: 0,
    spend: 0,
    conversions: 0,
    ctr: null,
    cpc: null,
    // Умолчание колонки: строка без явного источника считается площадочной.
    conversionSource: 'PLATFORM',
  },
  searchQueryStat: { impressions: 0, clicks: 0, spend: 0, conversions: 0, negated: false },
  changeLog: { campaignId: null, prevValue: null, newValue: null, reason: null, provider: null },
  errorLog: { context: {} },
};

/** Модели с `BigInt`-первичным ключом: тесты заодно ловят утечку BigInt в JSON. */
const BIGINT_ID = new Set<ModelName>(['campaignStat', 'searchQueryStat', 'errorLog']);

function find(rows: FakeRow[], key: string, value: unknown): FakeRow | undefined {
  return rows.find((row) => row[key] === value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

function equals(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

/** Даты сравниваются по времени, числа — как есть; остальное несравнимо. */
function comparable(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return undefined;
}

function matchRange(cond: Record<string, unknown>, value: unknown): boolean {
  const left = comparable(value);
  if (left === undefined) return false;
  for (const [op, bound] of Object.entries(cond)) {
    const right = comparable(bound);
    if (right === undefined) return false;
    if (op === 'gte' && !(left >= right)) return false;
    if (op === 'gt' && !(left > right)) return false;
    if (op === 'lte' && !(left <= right)) return false;
    if (op === 'lt' && !(left < right)) return false;
  }
  return true;
}

const RANGE_OPS = ['gte', 'gt', 'lte', 'lt'];

function matchValue(cond: unknown, value: unknown): boolean {
  if (!isPlainObject(cond)) return equals(cond, value);
  if ('in' in cond) return (cond['in'] as unknown[]).some((v) => equals(v, value));
  if ('notIn' in cond) return !(cond['notIn'] as unknown[]).some((v) => equals(v, value));
  if ('not' in cond) return !matchValue(cond['not'], value);
  if (RANGE_OPS.some((op) => op in cond)) return matchRange(cond, value);
  return equals(cond, value);
}

/** `{ provider_externalId: { provider, externalId } }` — составной ключ, а не колонка. */
function expand(where: Record<string, unknown>, model: ModelName): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(where)) {
    const isRelation = RELATIONS[model]?.[key] !== undefined;
    if (!isRelation && key.includes('_') && isPlainObject(value)) Object.assign(out, value);
    else out[key] = value;
  }
  return out;
}

function matchRow(
  model: ModelName,
  row: FakeRow,
  where: Record<string, unknown>,
  store: Store,
): boolean {
  for (const [key, cond] of Object.entries(expand(where, model))) {
    const relation = RELATIONS[model]?.[key];
    if (relation) {
      const parent = relation.get(row, store);
      if (!parent || !isPlainObject(cond)) return false;
      if (!matchRow(relation.target, parent, cond, store)) return false;
      continue;
    }
    if (!matchValue(cond, row[key])) return false;
  }
  return true;
}

function applySelect(
  model: ModelName,
  row: FakeRow,
  select: Record<string, unknown> | undefined,
  store: Store,
): FakeRow {
  if (!select) return { ...row };
  const out: FakeRow = {};
  for (const [key, spec] of Object.entries(select)) {
    if (spec === true) {
      out[key] = row[key];
      continue;
    }
    const relation = RELATIONS[model]?.[key];
    if (relation && isPlainObject(spec)) {
      const parent = relation.get(row, store);
      out[key] = parent
        ? applySelect(relation.target, parent, spec['select'] as Record<string, unknown>, store)
        : null;
    }
  }
  return out;
}

interface FindManyArgs {
  where?: Record<string, unknown>;
  select?: Record<string, unknown>;
  orderBy?: unknown;
}

class FakeModel {
  constructor(
    private readonly model: ModelName,
    private readonly store: Store,
    private readonly nextId: () => number,
  ) {}

  private get rows(): FakeRow[] {
    return this.store[this.model];
  }

  private filter(where: Record<string, unknown> | undefined): FakeRow[] {
    if (!where) return [...this.rows];
    return this.rows.filter((row) => matchRow(this.model, row, where, this.store));
  }

  findMany = async ({ where, select }: FindManyArgs = {}): Promise<FakeRow[]> =>
    this.filter(where).map((row) => applySelect(this.model, row, select, this.store));

  findFirst = async ({ where, select }: FindManyArgs = {}): Promise<FakeRow | null> => {
    const row = this.filter(where)[0];
    return row ? applySelect(this.model, row, select, this.store) : null;
  };

  findUnique = this.findFirst;

  count = async ({ where }: FindManyArgs = {}): Promise<number> => this.filter(where).length;

  create = async ({
    data,
    select,
  }: {
    data: FakeRow;
    select?: Record<string, unknown>;
  }): Promise<FakeRow> => {
    const n = this.nextId();
    const row: FakeRow = {
      id: BIGINT_ID.has(this.model) ? BigInt(n) : `${this.model}-${n}`,
      ...DEFAULTS[this.model],
      ...data,
    };
    this.rows.push(row);
    return applySelect(this.model, row, select, this.store);
  };

  update = async ({
    where,
    data,
    select,
  }: {
    where: Record<string, unknown>;
    data: FakeRow;
    select?: Record<string, unknown>;
  }): Promise<FakeRow> => {
    const row = this.filter(where)[0];
    if (!row) throw new Error(`${this.model}.update: no row matches ${JSON.stringify(where)}`);
    Object.assign(row, data);
    return applySelect(this.model, row, select, this.store);
  };

  updateMany = async ({
    where,
    data,
  }: {
    where?: Record<string, unknown>;
    data: FakeRow;
  }): Promise<{ count: number }> => {
    const rows = this.filter(where);
    for (const row of rows) Object.assign(row, data);
    return { count: rows.length };
  };

  upsert = async ({
    where,
    create,
    update,
    select,
  }: {
    where: Record<string, unknown>;
    create: FakeRow;
    update: FakeRow;
    select?: Record<string, unknown>;
  }): Promise<FakeRow> => {
    const row = this.filter(where)[0];
    if (row) {
      Object.assign(row, update);
      return applySelect(this.model, row, select, this.store);
    }
    return this.create(select ? { data: create, select } : { data: create });
  };

  delete = async (): Promise<never> => {
    throw new Error(`${this.model}.delete is forbidden: ingestion must never drop history`);
  };

  deleteMany = this.delete;
}

export class FakePrisma {
  readonly store: Store = {
    client: [],
    credential: [],
    campaign: [],
    adGroup: [],
    ad: [],
    keyword: [],
    campaignStat: [],
    searchQueryStat: [],
    changeLog: [],
    errorLog: [],
  };

  private sequence = 0;

  private readonly next = (): number => (this.sequence += 1);

  readonly client = new FakeModel('client', this.store, this.next);
  readonly credential = new FakeModel('credential', this.store, this.next);
  readonly campaign = new FakeModel('campaign', this.store, this.next);
  readonly adGroup = new FakeModel('adGroup', this.store, this.next);
  readonly ad = new FakeModel('ad', this.store, this.next);
  readonly keyword = new FakeModel('keyword', this.store, this.next);
  readonly campaignStat = new FakeModel('campaignStat', this.store, this.next);
  readonly searchQueryStat = new FakeModel('searchQueryStat', this.store, this.next);
  readonly changeLog = new FakeModel('changeLog', this.store, this.next);
  readonly errorLog = new FakeModel('errorLog', this.store, this.next);

  seed(model: ModelName, rows: FakeRow[]): void {
    for (const row of rows) {
      this.store[model].push({ ...DEFAULTS[model], ...row });
    }
  }

  asPrisma(): PrismaClient {
    return this as unknown as PrismaClient;
  }
}
