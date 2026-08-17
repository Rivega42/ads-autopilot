import { isRetryable, toDirectError, type DirectErrorPayload } from './errors.js';

const PRODUCTION_URL = 'https://api.direct.yandex.com/json/v5';
const SANDBOX_URL = 'https://api-sandbox.direct.yandex.com/json/v5';

/** Баллы Директа: сколько списано за запрос, сколько осталось, суточный лимит. */
export interface UnitsState {
  readonly spent: number;
  readonly rest: number;
  readonly limit: number;
}

export interface YandexDirectClientOptions {
  readonly token: string;
  /** Песочница не тратит реальные баллы и не создаёт настоящих кампаний. */
  readonly sandbox?: boolean;
  /** Логин рекламодателя — обязателен для агентских аккаунтов. */
  readonly clientLogin?: string;
  readonly language?: 'ru' | 'en';
  readonly maxRetries?: number;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

interface DirectResponse<TResult> {
  readonly result?: TResult;
  readonly error?: DirectErrorPayload;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseUnits(header: string | null): UnitsState | null {
  if (header === null) return null;
  const parts = header.split('/').map((n) => Number.parseInt(n.trim(), 10));
  const [spent, rest, limit] = parts;
  if (parts.length !== 3 || spent === undefined || rest === undefined || limit === undefined) {
    return null;
  }
  if (Number.isNaN(spent) || Number.isNaN(rest) || Number.isNaN(limit)) return null;
  return { spent, rest, limit };
}

/** Токен в логах — только хвост, чтобы можно было отличить один от другого. */
export function maskToken(token: string): string {
  return `***${token.slice(-4)}`;
}

/**
 * Клиент Yandex Direct API v5.
 *
 * Директ отвечает HTTP 200 даже на ошибку, кладя её в тело ответа, —
 * поэтому статус проверяем, но решение принимаем по body.error.
 */
export class YandexDirectClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly clientLogin: string | undefined;
  private readonly language: 'ru' | 'en';
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  private lastUnits: UnitsState | null = null;
  private lastRequestId: string | null = null;

  constructor(options: YandexDirectClientOptions) {
    if (options.token.trim() === '') {
      throw new Error('YandexDirectClient: пустой OAuth-токен');
    }

    this.token = options.token;
    this.baseUrl = options.sandbox === true ? SANDBOX_URL : PRODUCTION_URL;
    this.clientLogin = options.clientLogin;
    this.language = options.language ?? 'ru';
    this.maxRetries = options.maxRetries ?? 3;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
  }

  get units(): UnitsState | null {
    return this.lastUnits;
  }

  get requestId(): string | null {
    return this.lastRequestId;
  }

  get isSandbox(): boolean {
    return this.baseUrl === SANDBOX_URL;
  }

  async request<TResult>(
    service: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<TResult> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (attempt > 0) {
        await this.sleep(2 ** attempt * 1000);
      }

      try {
        return await this.send<TResult>(service, method, params);
      } catch (error) {
        lastError = error;
        if (!isRetryable(error)) throw error;
      }
    }

    throw lastError;
  }

  private async send<TResult>(
    service: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<TResult> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      'Accept-Language': this.language,
      'Content-Type': 'application/json; charset=utf-8',
      // Директ считает баллы дешевле, когда клиент явно просит краткие ошибки.
      'Use-Operator-Units': 'false',
    };
    if (this.clientLogin !== undefined) {
      headers['Client-Login'] = this.clientLogin;
    }

    const response = await this.fetchImpl(`${this.baseUrl}/${service}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ method, params }),
    });

    this.lastUnits = parseUnits(response.headers.get('Units'));
    this.lastRequestId = response.headers.get('RequestId');

    if (!response.ok && RETRYABLE_STATUS.has(response.status)) {
      throw toDirectError({
        error_code: 56,
        error_string: `HTTP ${response.status}`,
        error_detail: 'Временная ошибка на стороне Директа',
      });
    }

    const body = (await response.json()) as DirectResponse<TResult>;

    if (body.error !== undefined) {
      throw toDirectError(body.error);
    }
    if (body.result === undefined) {
      throw new Error(`Yandex Direct: пустой ответ ${service}.${method}`);
    }

    return body.result;
  }
}
