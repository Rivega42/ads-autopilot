/**
 * OAuth для Yandex Direct.
 *
 * Секрет приложения нужен только для обмена кода на токен (`response_type=code`).
 * Для разовой выдачи токена человеку хватает неявного потока — секрет
 * не покидает страницу Яндекса и не попадает ни в код, ни в логи.
 */

const AUTHORIZE_URL = 'https://oauth.yandex.ru/authorize';
const TOKEN_URL = 'https://oauth.yandex.ru/token';

export interface TokenResponse {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly expires_in: number;
  readonly token_type: string;
}

/** Неявный поток: токен показывается на странице подтверждения, секрет не нужен. */
export function buildImplicitAuthUrl(clientId: string): string {
  const params = new URLSearchParams({
    response_type: 'token',
    client_id: clientId,
    redirect_uri: 'https://oauth.yandex.ru/verification_code',
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/** Поток с кодом: нужен для серверного обмена и получения refresh_token. */
export function buildCodeAuthUrl(clientId: string, state?: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: 'https://oauth.yandex.ru/verification_code',
  });
  if (state !== undefined) params.set('state', state);
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export async function exchangeCodeForToken(
  code: string,
  clientId: string,
  clientSecret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  });

  const body = (await response.json()) as TokenResponse & {
    error?: string;
    error_description?: string;
  };

  if (body.error !== undefined) {
    // error_description может содержать код — в сообщение его не тащим.
    throw new Error(`OAuth Яндекса отказал: ${body.error}`);
  }

  return body;
}
