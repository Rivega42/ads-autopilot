/**
 * Простая калитка перед дашбордом.
 *
 * ТЗ §5, Milestone 8 разрешает отдать авторизацию reverse-proxy (Nginx basic /
 * Cloudflare Access). Учётных записей здесь нет и не должно быть: дашборд —
 * витрина на чтение, а не система доступа.
 *
 * Три режима:
 * - `DASHBOARD_AUTH_MODE=proxy` — фронт закрыт снаружи, приложение пропускает всё;
 * - задан `DASHBOARD_PASSWORD` — HTTP Basic;
 * - не задано ничего — 503. Отказ по умолчанию: забытая переменная не должна
 *   молча открывать наружу расходы клиентов.
 */

export type AuthMode = 'proxy' | 'basic' | 'unconfigured';
export type AuthOutcome = 'ok' | 'challenge' | 'unconfigured';

export const AUTH_REALM = 'ads-autopilot';

export interface AuthConfig {
  readonly mode: AuthMode;
  readonly user: string;
  readonly password: string;
}

export interface AuthEnv {
  readonly DASHBOARD_AUTH_MODE?: string | undefined;
  readonly DASHBOARD_USER?: string | undefined;
  readonly DASHBOARD_PASSWORD?: string | undefined;
}

export function readAuthConfig(env: AuthEnv): AuthConfig {
  const password = env.DASHBOARD_PASSWORD?.trim() ?? '';
  const user = env.DASHBOARD_USER?.trim() || 'admin';

  if (env.DASHBOARD_AUTH_MODE?.trim() === 'proxy') return { mode: 'proxy', user, password };
  if (password !== '') return { mode: 'basic', user, password };
  return { mode: 'unconfigured', user, password };
}

export interface BasicCredentials {
  readonly user: string;
  readonly password: string;
}

export function decodeBasicHeader(header: string | null | undefined): BasicCredentials | null {
  if (!header) return null;

  const separatorIndex = header.indexOf(' ');
  if (separatorIndex < 0) return null;
  if (header.slice(0, separatorIndex).toLowerCase() !== 'basic') return null;

  const encoded = header.slice(separatorIndex + 1).trim();
  if (encoded === '') return null;

  let decoded: string;
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    decoded = new TextDecoder().decode(bytes);
  } catch {
    return null;
  }

  const colon = decoded.indexOf(':');
  if (colon < 0) return null;
  return { user: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

/** Сравнение без ранних выходов: длина совпадения не должна утекать по времени. */
export function constantTimeEquals(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export function authenticate(header: string | null | undefined, config: AuthConfig): AuthOutcome {
  if (config.mode === 'proxy') return 'ok';
  if (config.mode === 'unconfigured') return 'unconfigured';

  const credentials = decodeBasicHeader(header);
  if (!credentials) return 'challenge';

  const userMatches = constantTimeEquals(credentials.user, config.user);
  const passwordMatches = constantTimeEquals(credentials.password, config.password);
  return userMatches && passwordMatches ? 'ok' : 'challenge';
}
