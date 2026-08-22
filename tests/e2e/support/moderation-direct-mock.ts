import { http, HttpResponse, type HttpHandler } from 'msw';
import { setupServer, type SetupServer } from 'msw/node';

/** Совпадает с `YANDEX_DIRECT_BASE_URL` при `YANDEX_DIRECT_USE_SANDBOX=true`. */
const BASE = 'https://api-sandbox.direct.yandex.com/json/v5';

/**
 * Мок сервиса `ads` Директа v5 для сценария модерации.
 *
 * Отдельный от `yandex-api-mock.ts`: тот знает про кампании, ставки и минус-фразы,
 * но не отдаёт ни одного объявления, а модерация только их и читает. Правила те же,
 * что у мока VK, и написаны они ровно затем, чтобы фикстура не оказалась удобнее
 * протокола (docs/LESSONS.md):
 *
 *  • токен обязателен на каждом запросе: без `Authorization: Bearer` — 53, а не выдача;
 *  • `FieldNames` реально применяется — в ответе только запрошенные поля, а
 *    `TextAd` появляется только когда спросили `TextAdFieldNames`;
 *  • `SelectionCriteria` без единого критерия отбора — это 400, а не «все объявления»;
 *  • страница ограничена `pageCap`, и `LimitedBy` заставляет клиент дочитать остаток:
 *    пагинация обязана работать, а не помещаться в один ответ;
 *  • `ads.update` проверяет длины теми же лимитами, что и площадка (33/30/81), и
 *    отвечает пообъектной ошибкой, а не 400 на весь запрос;
 *  • правка текста возвращает объявление на модерацию — как в кабинете. Объявление,
 *    которое площадка отклоняет всегда, отдаёт новый вердикт с новой формулировкой.
 *
 * Состояние живое: следующий листинг обязан показать то, что записала правка.
 */

export interface DirectAdSpec {
  id: number;
  adGroupId: number;
  campaignId: number;
  /** `Ad.State`: крутится или выключено. */
  state?: string;
  /** `Ad.Status`: вердикт модерации. */
  status?: string;
  statusClarification?: string | null;
  title: string;
  title2?: string;
  text: string;
  href?: string;
  /**
   * Что площадка делает с объявлением сразу после правки текста:
   *  • `moderation` — обычный путь: новый текст уехал на проверку;
   *  • `reject` — площадка отклоняет и переписанное, с новой формулировкой.
   */
  afterUpdate?: 'moderation' | 'reject';
}

interface DirectAd extends Required<Omit<DirectAdSpec, 'title2' | 'href'>> {
  title2?: string;
  href?: string;
  /** Сколько раз текст этого объявления правили. */
  updates: number;
}

export interface DirectCall {
  service: string;
  method: string;
  params: Record<string, unknown>;
  status: number;
  /** Токен запроса: по нему видно, что клиент вообще авторизуется. */
  token: string | null;
}

/** Программируемый одноразовый ответ: пообъектная ошибка, 500, странная форма тела. */
export interface ProgrammedDirectResponse {
  service: string;
  method?: string;
  status?: number;
  body?: unknown;
}

export interface DirectApiMockOptions {
  ads: readonly DirectAdSpec[];
  /** Токен, который кабинет считает живым. */
  token: string;
  /** Сколько объявлений площадка отдаёт за страницу, даже если попросили больше. */
  pageCap?: number;
}

export interface DirectApiMock {
  server: SetupServer;
  calls: DirectCall[];
  adById(id: number): DirectAd | undefined;
  callsTo(service: string, method: string): DirectCall[];
  /** Правки текста, дошедшие до кабинета: id объявления в порядке применения. */
  updated: number[];
  program(response: ProgrammedDirectResponse): void;
  /** Подменить вердикт площадки — так проверяется «следующий опрос видит новое». */
  setVerdict(id: number, status: string, clarification: string | null): void;
  reset(): void;
}

const HEADERS = {
  // Формат `spent/remaining/dailyLimit` — по нему считается UnitsLedger.
  Units: '10/60000/64000',
  RequestId: '9234567890123456789',
};

/** Лимиты Директа. Дублируются намеренно: мок обязан быть площадкой, а не нашим кодом. */
const LIMITS: Readonly<Record<'Title' | 'Title2' | 'Text', number>> = {
  Title: 33,
  Title2: 30,
  Text: 81,
};

interface Body {
  method: string;
  params: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asNumbers(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((v): v is number => typeof v === 'number') : [];
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function ok(result: Record<string, unknown>): Response {
  return HttpResponse.json({ result }, { headers: HEADERS });
}

function fail(status: number, code: number, text: string, detail?: string): Response {
  return HttpResponse.json(
    {
      error: {
        error_code: code,
        error_string: text,
        error_detail: detail ?? text,
        request_id: HEADERS.RequestId,
      },
    },
    { status, headers: HEADERS },
  );
}

function toAd(spec: DirectAdSpec): DirectAd {
  const ad: DirectAd = {
    id: spec.id,
    adGroupId: spec.adGroupId,
    campaignId: spec.campaignId,
    state: spec.state ?? 'ON',
    status: spec.status ?? 'ACCEPTED',
    statusClarification: spec.statusClarification ?? null,
    title: spec.title,
    text: spec.text,
    afterUpdate: spec.afterUpdate ?? 'moderation',
    updates: 0,
  };
  if (spec.title2 !== undefined) ad.title2 = spec.title2;
  if (spec.href !== undefined) ad.href = spec.href;
  return ad;
}

export function createDirectApiMock(options: DirectApiMockOptions): DirectApiMock {
  const ads = new Map<number, DirectAd>();
  for (const spec of options.ads) ads.set(spec.id, toAd(spec));

  const calls: DirectCall[] = [];
  const updated: number[] = [];
  const programmed: ProgrammedDirectResponse[] = [];
  const pageCap = options.pageCap ?? 2;

  const takeProgrammed = (service: string, method: string): ProgrammedDirectResponse | null => {
    const index = programmed.findIndex(
      (p) => p.service === service && (p.method === undefined || p.method === method),
    );
    if (index === -1) return null;
    return programmed.splice(index, 1)[0] as ProgrammedDirectResponse;
  };

  const project = (
    ad: DirectAd,
    fieldNames: readonly string[],
    textAdFieldNames: readonly string[],
  ): Record<string, unknown> => {
    const full: Record<string, unknown> = {
      Id: ad.id,
      CampaignId: ad.campaignId,
      AdGroupId: ad.adGroupId,
      State: ad.state,
      Status: ad.status,
      StatusClarification: ad.statusClarification,
    };
    const out: Record<string, unknown> = {};
    for (const field of fieldNames) {
      if (field in full) out[field] = full[field];
    }
    if (textAdFieldNames.length > 0) {
      const textAd: Record<string, unknown> = {};
      const source: Record<string, unknown> = {
        Title: ad.title,
        Title2: ad.title2,
        Text: ad.text,
        Href: ad.href ?? null,
        DisplayDomain: null,
      };
      for (const field of textAdFieldNames) {
        // Второго заголовка может не быть вовсе — площадка тогда не отдаёт и ключ.
        if (field in source && source[field] !== undefined) textAd[field] = source[field];
      }
      out['TextAd'] = textAd;
    }
    return out;
  };

  const handler: HttpHandler = http.post(`${BASE}/:service`, async ({ request, params }) => {
    const service = String(params['service']);
    const body = (await request.json()) as Body;
    const raw = request.headers.get('authorization');
    const token = raw?.startsWith('Bearer ') ? raw.slice('Bearer '.length) : null;
    const record = (status: number, response: Response): Response => {
      calls.push({ service, method: body.method, params: body.params, status, token });
      return response;
    };

    const preset = takeProgrammed(service, body.method);
    if (preset) {
      const status = preset.status ?? 200;
      return record(
        status,
        HttpResponse.json((preset.body ?? {}) as object, { status, headers: HEADERS }),
      );
    }

    // Токен обязателен на каждом вызове: 53 — «недействительный OAuth-токен».
    if (token !== options.token) {
      return record(401, fail(401, 53, 'Authorization error', 'Invalid OAuth token'));
    }
    // Директ отвечает по-русски только с этим заголовком; наш клиент шлёт его всегда.
    if (!request.headers.get('accept-language')) {
      return record(400, fail(400, 8000, 'Accept-Language is required'));
    }
    if (service !== 'ads') {
      return record(404, fail(404, 3001, `No access to service ${service}`));
    }

    const p = body.params;

    if (body.method === 'get') {
      const fieldNames = asStrings(p['FieldNames']);
      if (fieldNames.length === 0) {
        return record(400, fail(400, 4000, 'FieldNames is required'));
      }
      const textAdFieldNames = asStrings(p['TextAdFieldNames']);
      const criteria = asRecord(p['SelectionCriteria']);
      const ids = asNumbers(criteria['Ids']);
      const adGroupIds = asNumbers(criteria['AdGroupIds']);
      const campaignIds = asNumbers(criteria['CampaignIds']);
      if (ids.length === 0 && adGroupIds.length === 0 && campaignIds.length === 0) {
        // Выборка «всё сразу» у Директа запрещена — иначе один запрос выгружал бы кабинет.
        return record(400, fail(400, 4000, 'SelectionCriteria must narrow the selection'));
      }
      const states = asStrings(criteria['States']);
      const statuses = asStrings(criteria['Statuses']);

      const selected = [...ads.values()].filter((ad) => {
        if (ids.length > 0 && !ids.includes(ad.id)) return false;
        if (adGroupIds.length > 0 && !adGroupIds.includes(ad.adGroupId)) return false;
        if (campaignIds.length > 0 && !campaignIds.includes(ad.campaignId)) return false;
        if (states.length > 0 && !states.includes(ad.state)) return false;
        if (statuses.length > 0 && !statuses.includes(ad.status)) return false;
        return true;
      });

      const page = asRecord(p['Page']);
      const offset = Number(page['Offset'] ?? 0) || 0;
      const limit = Math.min(Number(page['Limit'] ?? pageCap) || pageCap, pageCap);
      const slice = selected.slice(offset, offset + limit);

      const result: Record<string, unknown> = {
        Ads: slice.map((ad) => project(ad, fieldNames, textAdFieldNames)),
      };
      // `LimitedBy` — смещение следующей страницы. Без него клиент решит, что дочитал.
      if (offset + slice.length < selected.length) result['LimitedBy'] = offset + slice.length;
      return record(200, ok(result));
    }

    if (body.method === 'update') {
      const items = Array.isArray(p['Ads']) ? p['Ads'] : [];
      if (items.length === 0) {
        return record(400, fail(400, 4000, 'Ads is required'));
      }
      const results = items.map((rawItem) => {
        const item = asRecord(rawItem);
        const id = Number(item['Id']);
        const ad = ads.get(id);
        if (!ad) {
          return { Id: id, Errors: [{ Code: 8800, Message: 'Объявление не найдено' }] };
        }
        const patch = asRecord(item['TextAd']);
        for (const [field, limit] of Object.entries(LIMITS)) {
          const value = patch[field];
          if (typeof value === 'string' && [...value].length > limit) {
            return {
              Id: id,
              Errors: [
                { Code: 5005, Message: `Превышена длина поля ${field}`, Details: `max ${limit}` },
              ],
            };
          }
        }
        if (typeof patch['Title'] === 'string') ad.title = patch['Title'];
        if (typeof patch['Title2'] === 'string') ad.title2 = patch['Title2'];
        if (typeof patch['Text'] === 'string') ad.text = patch['Text'];
        ad.updates += 1;
        updated.push(id);
        if (ad.afterUpdate === 'reject') {
          ad.status = 'REJECTED';
          ad.statusClarification = `Отказ №${ad.updates}: претензия осталась`;
        } else {
          // Правка текста возвращает объявление на модерацию — так делает кабинет.
          ad.status = 'MODERATION';
          ad.statusClarification = null;
        }
        return { Id: id };
      });
      return record(200, ok({ UpdateResults: results }));
    }

    return record(400, fail(400, 8000, `unexpected ads.${body.method}`));
  });

  return {
    server: setupServer(handler),
    calls,
    updated,
    adById: (id) => ads.get(id),
    callsTo: (service, method) => calls.filter((c) => c.service === service && c.method === method),
    program(response: ProgrammedDirectResponse): void {
      programmed.push(response);
    },
    setVerdict(id: number, status: string, clarification: string | null): void {
      const ad = ads.get(id);
      if (!ad) throw new Error(`нет объявления ${id} в кабинете мока`);
      ad.status = status;
      ad.statusClarification = clarification;
    },
    reset(): void {
      calls.length = 0;
      updated.length = 0;
      programmed.length = 0;
    },
  };
}
