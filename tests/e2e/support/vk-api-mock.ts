import { http, HttpResponse, type HttpHandler, type JsonBodyType } from 'msw';
import { setupServer, type SetupServer } from 'msw/node';

/** Совпадает с `VK_ADS_BASE_URL` (`src/constants.ts`), без хвостового слэша. */
const BASE = 'https://ads.vk.ru/api/v2';

/**
 * Мок ads.vk.ru, который ведёт себя как протокол, а не как удобный ответ.
 *
 * Правила, ради которых он написан:
 *  • токен обязателен на каждом вызове, кроме `oauth2/*` — запрос без живого
 *    Bearer получает 401 в той же форме, в какой его отдаёт площадка;
 *  • `_id__in` / `_status__in` / `limit` / `offset` / `fields` реально применяются
 *    к выдаче: фильтр, который мы отправили, обязан влиять на то, что мы получим,
 *    иначе тест проверяет код против выдуманного ответа;
 *  • обязательный параметр, которого нет в запросе, — это 400, а не пустой ответ;
 *  • ошибки отдаются в тех формах, которые разбирает `parseVkError`
 *    (`src/clients/vk-ads/schemas.ts`): объект `error`, строка `error` с
 *    `error_description` и полевые ошибки валидации;
 *  • деньги в ответах — строки ("1500.00"), счётчики — то числа, то строки:
 *    ровно то, подо что написан `toNumber`.
 *
 * Состояние кабинета живое: пауза, ставка, создание и удаление баннера меняют
 * его, и следующий листинг обязан показать изменённое. Без этого нельзя
 * проверить ни идемпотентность, ни пересоздание баннера.
 */

/** Словарь статусов из ТЗ §2.2. `deleted` — то, чем становится удалённый объект. */
export const VK_STATUSES = [
  'active',
  'blocked',
  'deleted',
  'pending_moderation',
  'rejected',
] as const;

export interface VkAdPlanState {
  id: number;
  name: string;
  status: string;
  objective: string;
  /** Деньги площадка отдаёт строкой. `null` — «лимита нет». */
  budget_limit_day: string | null;
  budget_limit: string | null;
  autobidding_mode: string | null;
  max_price: string | null;
}

export interface VkAdGroupState {
  id: number;
  ad_plan_id: number;
  name: string;
  status: string;
  max_price: string | null;
  autobidding_mode: string | null;
  targetings: Record<string, unknown>;
}

export interface VkBannerState {
  id: number;
  ad_group_id: number;
  name: string;
  status: string;
  moderation_status?: string;
  moderation_reason_type?: string;
  moderation_reason?: string;
  textblocks: Record<string, unknown>;
  urls?: Record<string, unknown>;
  content?: Record<string, unknown>;
  url?: string;
}

export interface VkStatDay {
  /** yyyy-MM-dd */
  date: string;
  shows: number;
  clicks: number;
  goals: number;
  /** Строкой — как отдаёт площадка. */
  spent: string;
}

export type VkObjectType = 'ad_plans' | 'ad_groups' | 'banners';

export interface VkCabinet {
  adPlans: VkAdPlanState[];
  adGroups: VkAdGroupState[];
  banners: VkBannerState[];
  /** objectType → id объекта → строки по дням. */
  stats: Record<VkObjectType, Record<number, VkStatDay[]>>;
}

export interface VkCall {
  method: string;
  /** Путь без базового URL, например `banners.json`. */
  path: string;
  query: Record<string, string>;
  body?: unknown;
  /** Токен, с которым пришёл запрос: по нему видно, что после 401 сходили за новым. */
  token: string | null;
  status: number;
}

/** Программируемый одноразовый ответ: 429, 500, странная форма тела. */
export interface ProgrammedResponse {
  /** Совпадение по началу пути (`banners.json`, `statistics/`). */
  path: string;
  method?: string;
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface VkApiMockOptions {
  /** Реквизиты приложения: чужие — это 400, как у настоящего OAuth. */
  app: { clientId: string; clientSecret: string };
  cabinet: VkCabinet;
  /** Потолок одновременно живых токенов. У VK — 5 (ТЗ §2.2). */
  maxTokens?: number;
  /** Токены, занятые «другими процессами» ещё до старта сценария. */
  preexistingTokens?: number;
  /** Сколько объектов площадка отдаёт за страницу, даже если попросили больше. */
  pageCap?: number;
  /**
   * Отдавать на листинге только те поля, которые перечислены в `fields`.
   *
   * Наш же `VkListOptions.fields` (`src/clients/vk-ads/entities.ts`) утверждает,
   * что «VK по умолчанию отдаёт урезанный набор». Проверить это без живого токена
   * нельзя, поэтому по умолчанию мок щедрый, а урезание включается точечно — там,
   * где сценарий показывает, чем это обернётся.
   */
  trimUnrequestedFields?: boolean;
  /** Форма ответа `mass_action`: плоский массив или `{items: [...]}`. */
  massActionAck?: 'array' | 'items';
  /** Отдавать ли id созданного объекта строкой (VK так делает в части ответов). */
  createdIdAsString?: boolean;
  /** rps в заголовках лимитов: от него `RateLimitGovernor` строит спейсинг. */
  rpsLimit?: number;
}

export interface VkApiMock {
  server: SetupServer;
  cabinet: VkCabinet;
  calls: VkCall[];
  /** Живые токены на стороне площадки. */
  liveTokens: Set<string>;
  /** Сколько раз кабинет выдал новый токен. */
  minted: number;
  /** Одноразовый ответ на следующий подходящий запрос. */
  program(response: ProgrammedResponse): void;
  bannerById(id: number): VkBannerState | undefined;
  adGroupById(id: number): VkAdGroupState | undefined;
  adPlanById(id: number): VkAdPlanState | undefined;
  callsTo(path: string): VkCall[];
  reset(): void;
}

interface MockOpts {
  app: { clientId: string; clientSecret: string };
  cabinet: VkCabinet;
  maxTokens: number;
  preexistingTokens: number;
  pageCap: number;
  trimUnrequestedFields: boolean;
  massActionAck: 'array' | 'items';
  createdIdAsString: boolean;
  rpsLimit: number;
}

interface MockState {
  calls: VkCall[];
  liveTokens: Set<string>;
  minted: number;
  programmed: ProgrammedResponse[];
  nextId: number;
}

interface Ctx {
  opts: MockOpts;
  state: MockState;
}

function headersOf(ctx: Ctx): Record<string, string> {
  const rps = ctx.opts.rpsLimit;
  return {
    'x-ratelimit-rps-limit': String(rps),
    'x-ratelimit-rps-remaining': String(rps - 1),
    'x-ratelimit-hourly-limit': '5000',
    'x-ratelimit-hourly-remaining': '4900',
    'x-ratelimit-daily-limit': '50000',
    'x-ratelimit-daily-remaining': '49000',
  };
}

/** `{"error": {"code": ..., "message": ...}}` — основная форма ошибки VK. */
function vkError(ctx: Ctx, status: number, code: string, message: string): Response {
  return HttpResponse.json({ error: { code, message } }, { status, headers: headersOf(ctx) });
}

/** Полевая форма: `{"field": [{"code": ..., "message": ...}]}`. */
function vkFieldError(ctx: Ctx, field: string, message: string): Response {
  return HttpResponse.json(
    { [field]: [{ code: 'required', message }] },
    { status: 400, headers: headersOf(ctx) },
  );
}

function ok(ctx: Ctx, body: JsonBodyType): Response {
  return HttpResponse.json(body, { status: 200, headers: headersOf(ctx) });
}

function queryOf(request: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of new URL(request.url).searchParams) out[key] = value;
  return out;
}

function bearer(request: Request): string | null {
  const raw = request.headers.get('authorization');
  if (!raw) return null;
  const match = /^Bearer (.+)$/.exec(raw);
  return match ? (match[1] as string) : null;
}

function record(ctx: Ctx, call: Omit<VkCall, 'status'>, status: number): void {
  ctx.state.calls.push({ ...call, status });
}

function takeProgrammed(ctx: Ctx, method: string, path: string): ProgrammedResponse | null {
  const index = ctx.state.programmed.findIndex(
    (p) => path.startsWith(p.path) && (p.method === undefined || p.method === method),
  );
  if (index === -1) return null;
  return ctx.state.programmed.splice(index, 1)[0] as ProgrammedResponse;
}

function objectsOf(ctx: Ctx, type: VkObjectType): Array<Record<string, unknown>> {
  const { cabinet } = ctx.opts;
  if (type === 'ad_plans') return cabinet.adPlans as unknown as Array<Record<string, unknown>>;
  if (type === 'ad_groups') return cabinet.adGroups as unknown as Array<Record<string, unknown>>;
  return cabinet.banners as unknown as Array<Record<string, unknown>>;
}

function resourceOf(raw: string): VkObjectType | null {
  const name = raw.endsWith('.json') ? raw.slice(0, -'.json'.length) : null;
  if (name === 'ad_plans' || name === 'ad_groups' || name === 'banners') return name;
  return null;
}

/**
 * Проекция объекта под `fields`.
 *
 * Если `fields` не пришёл — отдаём объект целиком либо, при `trimUnrequestedFields`,
 * только идентификаторы: это и есть спорное место, из-за которого поле `fields`
 * в клиенте существует, но никем не заполняется.
 */
function project(
  ctx: Ctx,
  type: VkObjectType,
  object: Record<string, unknown>,
  fields: readonly string[] | undefined,
): Record<string, unknown> {
  if (fields === undefined) {
    if (!ctx.opts.trimUnrequestedFields) return { ...object };
    const minimal: Record<string, unknown> = { id: object['id'] };
    if (type === 'ad_groups') minimal['ad_plan_id'] = object['ad_plan_id'];
    if (type === 'banners') minimal['ad_group_id'] = object['ad_group_id'];
    return minimal;
  }
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in object) out[field] = object[field];
  }
  return out;
}

/** Разбирает `_id__in=1,2,3` в набор чисел. */
function idsOf(value: string | undefined): number[] | null {
  if (value === undefined || value === '') return null;
  return value
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isFinite(n));
}

export function createVkApiMock(options: VkApiMockOptions): VkApiMock {
  const ctx: Ctx = {
    opts: {
      app: options.app,
      cabinet: options.cabinet,
      maxTokens: options.maxTokens ?? 5,
      preexistingTokens: options.preexistingTokens ?? 0,
      pageCap: options.pageCap ?? 200,
      trimUnrequestedFields: options.trimUnrequestedFields ?? false,
      massActionAck: options.massActionAck ?? 'array',
      createdIdAsString: options.createdIdAsString ?? false,
      rpsLimit: options.rpsLimit ?? 20,
    },
    state: {
      calls: [] as VkCall[],
      liveTokens: new Set<string>(),
      minted: 0,
      programmed: [] as ProgrammedResponse[],
      nextId: 9000,
    },
  };

  for (let i = 0; i < ctx.opts.preexistingTokens; i++) {
    ctx.state.liveTokens.add(`vk-token-foreign-${i}`);
  }

  const handlers: HttpHandler[] = [
    // ── OAuth ───────────────────────────────────────────────────────────────
    http.post(`${BASE}/oauth2/token.json`, async ({ request }) => {
      const form = new URLSearchParams(await request.text());
      const body = Object.fromEntries(form) as Record<string, string>;
      const path = 'oauth2/token.json';
      const call = { method: 'POST', path, query: {}, body, token: null };

      const programmed = takeProgrammed(ctx, 'POST', path);
      if (programmed) {
        record(ctx, call, programmed.status ?? 200);
        return HttpResponse.json((programmed.body ?? {}) as object, {
          status: programmed.status ?? 200,
          headers: { ...headersOf(ctx), ...programmed.headers },
        });
      }

      for (const required of ['grant_type', 'client_id', 'client_secret']) {
        if (!form.get(required)) {
          record(ctx, call, 400);
          return HttpResponse.json(
            { error: 'invalid_request', error_description: `${required} is required` },
            { status: 400, headers: headersOf(ctx) },
          );
        }
      }
      const grant = form.get('grant_type');
      if (grant === 'agency_client_credentials' && !form.get('agency_client_name')) {
        record(ctx, call, 400);
        return HttpResponse.json(
          { error: 'invalid_request', error_description: 'agency_client_name is required' },
          { status: 400, headers: headersOf(ctx) },
        );
      }
      if (
        form.get('client_id') !== ctx.opts.app.clientId ||
        form.get('client_secret') !== ctx.opts.app.clientSecret
      ) {
        record(ctx, call, 400);
        return HttpResponse.json(
          { error: 'invalid_client', error_description: 'client_id/client_secret mismatch' },
          { status: 400, headers: headersOf(ctx) },
        );
      }

      // Потолок токенов: 6-й не выдаётся вовсе, вытеснения самого старого нет.
      if (ctx.state.liveTokens.size >= ctx.opts.maxTokens) {
        record(ctx, call, 403);
        return vkError(
          ctx,
          403,
          'access_denied',
          'Reached the maximum count of tokens for this user',
        );
      }

      ctx.state.minted += 1;
      const token = `vk-token-${ctx.state.minted}`;
      ctx.state.liveTokens.add(token);
      record(ctx, call, 200);
      return ok(ctx, { access_token: token, token_type: 'Bearer', expires_in: 86400 });
    }),

    http.post(`${BASE}/oauth2/token/delete.json`, async ({ request }) => {
      const form = new URLSearchParams(await request.text());
      const path = 'oauth2/token/delete.json';
      const call = {
        method: 'POST',
        path,
        query: {},
        body: Object.fromEntries(form) as Record<string, string>,
        token: null,
      };
      if (!form.get('client_id') || !form.get('client_secret')) {
        record(ctx, call, 400);
        return HttpResponse.json(
          { error: 'invalid_request', error_description: 'client credentials are required' },
          { status: 400, headers: headersOf(ctx) },
        );
      }
      const one = form.get('access_token');
      if (one) ctx.state.liveTokens.delete(one);
      else ctx.state.liveTokens.clear();
      record(ctx, call, 200);
      return ok(ctx, {});
    }),

    // ── Статистика ──────────────────────────────────────────────────────────
    http.get(`${BASE}/statistics/:objectType/:granularity`, ({ request, params }) => {
      const objectType = String(params['objectType']);
      const granularity = String(params['granularity']).replace(/\.json$/u, '');
      const path = `statistics/${objectType}/${granularity}.json`;
      const query = queryOf(request);
      const token = bearer(request);
      const call = { method: 'GET', path, query, token };

      const programmed = takeProgrammed(ctx, 'GET', path);
      if (programmed) {
        record(ctx, call, programmed.status ?? 200);
        return HttpResponse.json((programmed.body ?? {}) as object, {
          status: programmed.status ?? 200,
          headers: { ...headersOf(ctx), ...programmed.headers },
        });
      }
      const denied = authorize(ctx, call);
      if (denied) return denied;

      if (objectType !== 'ad_plans' && objectType !== 'ad_groups' && objectType !== 'banners') {
        record(ctx, call, 404);
        return vkError(ctx, 404, 'not_found', `unknown object type ${objectType}`);
      }
      if (granularity !== 'day' && granularity !== 'summary') {
        record(ctx, call, 404);
        return vkError(ctx, 404, 'not_found', `unknown granularity ${granularity}`);
      }
      for (const required of ['id', 'date_from', 'date_to']) {
        if (!query[required]) {
          record(ctx, call, 400);
          return vkFieldError(ctx, required, `${required} is required`);
        }
      }

      const ids = idsOf(query['id']) ?? [];
      if (ids.length > 200) {
        record(ctx, call, 400);
        return vkFieldError(ctx, 'id', 'no more than 200 objects per request');
      }

      const from = query['date_from'] as string;
      const to = query['date_to'] as string;
      const byId = ctx.opts.cabinet.stats[objectType];
      const items = ids.map((id) => {
        const rows = (byId[id] ?? []).filter((row) => row.date >= from && row.date <= to);
        return {
          id: String(id),
          rows: rows.map((row) => ({
            date: row.date,
            base: {
              shows: row.shows,
              clicks: row.clicks,
              goals: row.goals,
              spent: row.spent,
            },
          })),
        };
      });
      record(ctx, call, 200);
      return ok(ctx, { items });
    }),

    // ── Массовая запись ─────────────────────────────────────────────────────
    http.post(`${BASE}/:resource/mass_action.json`, async ({ request, params }) => {
      const resource = resourceOf(`${String(params['resource'])}.json`);
      const path = `${String(params['resource'])}/mass_action.json`;
      const body = (await request.json()) as unknown;
      const token = bearer(request);
      const call = { method: 'POST', path, query: queryOf(request), body, token };

      const programmed = takeProgrammed(ctx, 'POST', path);
      if (programmed) {
        record(ctx, call, programmed.status ?? 200);
        return HttpResponse.json((programmed.body ?? {}) as object, {
          status: programmed.status ?? 200,
          headers: { ...headersOf(ctx), ...programmed.headers },
        });
      }
      const denied = authorize(ctx, call);
      if (denied) return denied;

      if (resource === null) {
        record(ctx, call, 404);
        return vkError(ctx, 404, 'not_found', `unknown collection ${String(params['resource'])}`);
      }
      if (!Array.isArray(body)) {
        record(ctx, call, 400);
        return vkFieldError(ctx, 'items', 'mass_action expects an array of objects');
      }

      const objects = objectsOf(ctx, resource);
      const results = body.map((raw) => {
        const patch = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<
          string,
          unknown
        >;
        const id = patch['id'];
        if (typeof id !== 'number' || !Number.isInteger(id)) {
          return {
            id: id ?? null,
            error: { code: 'invalid_id', message: 'id must be an integer' },
          };
        }
        const target = objects.find((o) => o['id'] === id);
        if (!target || target['status'] === 'deleted') {
          return { id, error: { code: 'object_not_found', message: `object ${id} not found` } };
        }
        for (const [key, value] of Object.entries(patch)) {
          if (key === 'id') continue;
          if (key === 'status') {
            if (!VK_STATUSES.includes(String(value) as (typeof VK_STATUSES)[number])) {
              return {
                id,
                error: { code: 'invalid_status', message: `unknown status ${String(value)}` },
              };
            }
            target['status'] = String(value);
            continue;
          }
          if (key === 'max_price' || key === 'budget_limit_day' || key === 'budget_limit') {
            const amount = Number(value);
            if (!Number.isFinite(amount) || amount <= 0) {
              return {
                id,
                error: { code: 'invalid_value', message: `${key} must be a positive number` },
              };
            }
            // Площадка хранит деньги строкой с двумя знаками — так же их и вернёт.
            target[key] = amount.toFixed(2);
            continue;
          }
          target[key] = value;
        }
        return { id, success: true };
      });

      record(ctx, call, 200);
      return ok(ctx, ctx.opts.massActionAck === 'items' ? { items: results } : results);
    }),

    // ── Создание ────────────────────────────────────────────────────────────
    http.post(`${BASE}/:resource`, async ({ request, params }) => {
      const resource = resourceOf(String(params['resource']));
      const path = String(params['resource']);
      const body = (await request.json()) as Record<string, unknown>;
      const token = bearer(request);
      const call = { method: 'POST', path, query: queryOf(request), body, token };

      const programmed = takeProgrammed(ctx, 'POST', path);
      if (programmed) {
        record(ctx, call, programmed.status ?? 200);
        return HttpResponse.json((programmed.body ?? {}) as object, {
          status: programmed.status ?? 200,
          headers: { ...headersOf(ctx), ...programmed.headers },
        });
      }
      const denied = authorize(ctx, call);
      if (denied) return denied;

      if (resource !== 'banners') {
        record(ctx, call, 404);
        return vkError(ctx, 404, 'not_found', `creation of ${path} is not supported`);
      }

      const groupId = body['ad_group_id'];
      if (typeof groupId !== 'number') {
        record(ctx, call, 400);
        return vkFieldError(ctx, 'ad_group_id', 'ad_group_id is required and must be an integer');
      }
      if (!ctx.opts.cabinet.adGroups.some((g) => g.id === groupId)) {
        record(ctx, call, 400);
        return vkFieldError(ctx, 'ad_group_id', `ad group ${groupId} does not exist`);
      }
      const textblocks = body['textblocks'];
      if (typeof textblocks !== 'object' || textblocks === null) {
        record(ctx, call, 400);
        return vkFieldError(ctx, 'textblocks', 'textblocks is required');
      }
      const status = body['status'] === undefined ? 'active' : String(body['status']);
      if (!VK_STATUSES.includes(status as (typeof VK_STATUSES)[number])) {
        record(ctx, call, 400);
        return vkFieldError(ctx, 'status', `unknown status ${status}`);
      }

      ctx.state.nextId += 1;
      const created: VkBannerState = {
        id: ctx.state.nextId,
        ad_group_id: groupId,
        name: typeof body['name'] === 'string' ? body['name'] : '',
        status,
        // Новый баннер всегда уходит на модерацию заново — в этом весь смысл пересоздания.
        moderation_status: 'pending',
        textblocks: textblocks as Record<string, unknown>,
      };
      if (typeof body['url'] === 'string') created.url = body['url'];
      if (typeof body['urls'] === 'object' && body['urls'] !== null) {
        created.urls = body['urls'] as Record<string, unknown>;
      }
      if (typeof body['content'] === 'object' && body['content'] !== null) {
        created.content = body['content'] as Record<string, unknown>;
      }
      ctx.opts.cabinet.banners.push(created);

      record(ctx, call, 200);
      return ok(ctx, {
        ...created,
        id: ctx.opts.createdIdAsString ? String(created.id) : created.id,
      });
    }),

    // ── Удаление ────────────────────────────────────────────────────────────
    http.delete(`${BASE}/:resource/:id`, ({ request, params }) => {
      const resource = resourceOf(`${String(params['resource'])}.json`);
      const rawId = String(params['id']).replace(/\.json$/u, '');
      const path = `${String(params['resource'])}/${rawId}.json`;
      const token = bearer(request);
      const call = { method: 'DELETE', path, query: queryOf(request), token };

      const programmed = takeProgrammed(ctx, 'DELETE', path);
      if (programmed) {
        record(ctx, call, programmed.status ?? 200);
        return HttpResponse.json((programmed.body ?? {}) as object, {
          status: programmed.status ?? 200,
          headers: { ...headersOf(ctx), ...programmed.headers },
        });
      }
      const denied = authorize(ctx, call);
      if (denied) return denied;

      if (resource === null) {
        record(ctx, call, 404);
        return vkError(ctx, 404, 'not_found', `unknown collection ${String(params['resource'])}`);
      }
      const id = Number(rawId);
      const target = objectsOf(ctx, resource).find((o) => o['id'] === id);
      if (!target || target['status'] === 'deleted') {
        record(ctx, call, 404);
        return vkError(ctx, 404, 'not_found', `object ${rawId} not found`);
      }
      // Удаление — это статус, а не исчезновение строки: объект остаётся в кабинете.
      target['status'] = 'deleted';
      record(ctx, call, 204);
      return new HttpResponse(null, { status: 204, headers: headersOf(ctx) });
    }),

    // ── Листинг ─────────────────────────────────────────────────────────────
    http.get(`${BASE}/:resource`, ({ request, params }) => {
      const resource = resourceOf(String(params['resource']));
      const path = String(params['resource']);
      const query = queryOf(request);
      const token = bearer(request);
      const call = { method: 'GET', path, query, token };

      const programmed = takeProgrammed(ctx, 'GET', path);
      if (programmed) {
        record(ctx, call, programmed.status ?? 200);
        return HttpResponse.json((programmed.body ?? {}) as object, {
          status: programmed.status ?? 200,
          headers: { ...headersOf(ctx), ...programmed.headers },
        });
      }
      const denied = authorize(ctx, call);
      if (denied) return denied;

      if (resource === null) {
        record(ctx, call, 404);
        return vkError(ctx, 404, 'not_found', `unknown collection ${path}`);
      }

      const ids = idsOf(query['_id__in']);
      if (ids !== null && ids.length > 200) {
        record(ctx, call, 400);
        return vkFieldError(ctx, '_id__in', 'no more than 200 ids per request');
      }
      const statuses = query['_status__in']?.split(',').map((s) => s.trim());

      let selected = objectsOf(ctx, resource).filter((object) => {
        if (ids !== null && !ids.includes(object['id'] as number)) return false;
        if (statuses && !statuses.includes(String(object['status']))) return false;
        if (
          resource === 'ad_groups' &&
          query['_ad_plan_id__in'] !== undefined &&
          !(idsOf(query['_ad_plan_id__in']) ?? []).includes(object['ad_plan_id'] as number)
        ) {
          return false;
        }
        if (
          resource === 'banners' &&
          query['_ad_group_id__in'] !== undefined &&
          !(idsOf(query['_ad_group_id__in']) ?? []).includes(object['ad_group_id'] as number)
        ) {
          return false;
        }
        return true;
      });

      const count = selected.length;
      const offset = Number(query['offset'] ?? 0) || 0;
      const limit = Math.min(Number(query['limit'] ?? ctx.opts.pageCap) || 0, ctx.opts.pageCap);
      selected = selected.slice(offset, offset + limit);

      const fields = query['fields']?.split(',').map((f) => f.trim());
      const items = selected.map((object) => project(ctx, resource, object, fields));

      record(ctx, call, 200);
      return ok(ctx, { count, offset, items });
    }),
  ];

  function authorize(c: Ctx, call: Omit<VkCall, 'status'>): Response | null {
    if (call.token !== null && c.state.liveTokens.has(call.token)) return null;
    record(c, call, 401);
    return vkError(c, 401, 'invalid_token', 'access token is invalid or expired');
  }

  const { cabinet } = ctx.opts;
  return {
    server: setupServer(...handlers),
    cabinet,
    calls: ctx.state.calls,
    liveTokens: ctx.state.liveTokens,
    get minted(): number {
      return ctx.state.minted;
    },
    program(response: ProgrammedResponse): void {
      ctx.state.programmed.push(response);
    },
    bannerById: (id) => cabinet.banners.find((b) => b.id === id),
    adGroupById: (id) => cabinet.adGroups.find((g) => g.id === id),
    adPlanById: (id) => cabinet.adPlans.find((p) => p.id === id),
    callsTo: (path) => ctx.state.calls.filter((c) => c.path.startsWith(path)),
    reset(): void {
      ctx.state.calls.length = 0;
      ctx.state.programmed.length = 0;
    },
  };
}
