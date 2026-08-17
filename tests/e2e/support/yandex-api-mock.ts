import { http, HttpResponse } from 'msw';
import { setupServer, type SetupServer } from 'msw/node';

/** Совпадает с `YANDEX_DIRECT_BASE_URL` при `YANDEX_DIRECT_USE_SANDBOX=true`. */
const BASE = 'https://api-sandbox.direct.yandex.com/json/v5';

export interface YandexCall {
  service: string;
  method: string;
  params: Record<string, unknown>;
}

export interface CampaignState {
  id: number;
  name: string;
  dailyBudget: number;
  negativeKeywords: string[];
}

export interface YandexApiMock {
  server: SetupServer;
  /** Каждый запрос, включая чтения: 10 баллов за лишний `Campaigns.get` — тоже цена. */
  calls: YandexCall[];
  negativesOf(campaignId: number): string[];
  suspended: { keywords: number[]; ads: number[] };
  bids: Array<{ keywordId: number; searchBid: number }>;
}

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

const HEADERS = {
  // Формат `spent/remaining/dailyLimit` — по нему считается UnitsLedger.
  Units: '10/60000/64000',
  RequestId: '1234567890123456789',
};

function ok(result: Record<string, unknown>): Response {
  return HttpResponse.json({ result }, { headers: HEADERS });
}

/**
 * Мок Директа v5 поверх настоящего HTTP.
 *
 * Держит состояние кабинета (минус-фразы, приостановленные объекты, ставки),
 * потому что половина проверяемого — это «второй прогон не делает то же самое
 * второй раз», и без состояния такую проверку не построить.
 *
 * Ответы собираются строго по `FieldNames` запроса: API отдаёт ровно
 * запрошенные поля, и фикстура, которая щедрее настоящего ответа, скрывает
 * ошибки в схемах разбора.
 */
export function createYandexApiMock(initial: readonly CampaignState[]): YandexApiMock {
  const campaigns = new Map<number, CampaignState>();
  const calls: YandexCall[] = [];
  const suspended = { keywords: [] as number[], ads: [] as number[] };
  const bids: Array<{ keywordId: number; searchBid: number }> = [];

  for (const c of initial) {
    campaigns.set(c.id, { ...c, negativeKeywords: [...c.negativeKeywords] });
  }

  const projectCampaign = (
    state: CampaignState,
    fieldNames: readonly string[],
  ): Record<string, unknown> => {
    const full: Record<string, unknown> = {
      Id: state.id,
      Name: state.name,
      Type: 'TEXT_CAMPAIGN',
      Status: 'ACCEPTED',
      State: 'ON',
      DailyBudget: { Amount: state.dailyBudget * 1_000_000, Mode: 'STANDARD' },
      NegativeKeywords: { Items: [...state.negativeKeywords] },
    };
    const out: Record<string, unknown> = {};
    for (const field of fieldNames) {
      if (field in full) out[field] = full[field];
    }
    return out;
  };

  const handler = http.post(`${BASE}/:service`, async ({ request, params }) => {
    const service = String(params['service']);
    const body = (await request.json()) as Body;
    calls.push({ service, method: body.method, params: body.params });

    const p = body.params;

    if (service === 'campaigns' && body.method === 'get') {
      const ids = asNumbers(asRecord(p['SelectionCriteria'])['Ids']);
      const fieldNames = Array.isArray(p['FieldNames']) ? (p['FieldNames'] as string[]) : [];
      const selected = [...campaigns.values()].filter(
        (c) => ids.length === 0 || ids.includes(c.id),
      );
      return ok({ Campaigns: selected.map((c) => projectCampaign(c, fieldNames)) });
    }

    if (service === 'campaigns' && body.method === 'update') {
      const items = Array.isArray(p['Campaigns']) ? p['Campaigns'] : [];
      const results = items.map((raw) => {
        const item = asRecord(raw);
        const id = Number(item['Id']);
        const state = campaigns.get(id);
        const negatives = asRecord(item['NegativeKeywords'])['Items'];
        if (state && Array.isArray(negatives)) {
          state.negativeKeywords = negatives.map(String);
        }
        return { Id: id };
      });
      return ok({ UpdateResults: results });
    }

    if ((service === 'keywords' || service === 'ads') && body.method === 'suspend') {
      const ids = asNumbers(asRecord(p['SelectionCriteria'])['Ids']);
      const bucket = service === 'keywords' ? suspended.keywords : suspended.ads;
      bucket.push(...ids);
      return ok({ SuspendResults: ids.map((id) => ({ Id: id })) });
    }

    if (service === 'keywordbids' && body.method === 'set') {
      const items = Array.isArray(p['KeywordBids']) ? p['KeywordBids'] : [];
      const results = items.map((raw) => {
        const item = asRecord(raw);
        const keywordId = Number(item['KeywordId']);
        bids.push({ keywordId, searchBid: Number(item['SearchBid']) / 1_000_000 });
        return { KeywordId: keywordId };
      });
      return ok({ SetResults: results });
    }

    return HttpResponse.json(
      { error: { error_code: 8000, error_string: `unexpected ${service}.${body.method}` } },
      { headers: HEADERS },
    );
  });

  return {
    server: setupServer(handler),
    calls,
    negativesOf: (campaignId) => [...(campaigns.get(campaignId)?.negativeKeywords ?? [])],
    suspended,
    bids,
  };
}
