import { describe, expect, it } from 'vitest';

import {
  buildAuthHeaders,
  ensureFreshCredentials,
  isTokenNearExpiry,
  parseCredentials,
  REFRESH_LEAD_MS,
  yandexCredentialsSchema,
  type CredentialStore,
  type YandexCredentials,
} from '@/clients/yandex/auth.js';
import { decryptJson, encryptJson } from '@/lib/crypto.js';
import { AuthError } from '@/lib/errors.js';

describe('buildAuthHeaders', () => {
  it('sends a bearer token and Russian error messages', () => {
    const headers = buildAuthHeaders({ accessToken: 'abc' });
    expect(headers['Authorization']).toBe('Bearer abc');
    expect(headers['Accept-Language']).toBe('ru');
  });

  it('omits the agency headers for a direct advertiser token', () => {
    // Client-Login на не-агентском токене — гарантированная ошибка 54.
    const headers = buildAuthHeaders({ accessToken: 'abc', useOperatorUnits: true });
    expect(headers['Client-Login']).toBeUndefined();
    expect(headers['Use-Operator-Units']).toBeUndefined();
  });

  it('spends the agency units only when explicitly asked', () => {
    expect(
      buildAuthHeaders({ accessToken: 'abc', clientLogin: 'sub' })['Use-Operator-Units'],
    ).toBeUndefined();
    expect(
      buildAuthHeaders({ accessToken: 'abc', clientLogin: 'sub', useOperatorUnits: true })[
        'Use-Operator-Units'
      ],
    ).toBe('true');
  });
});

describe('parseCredentials', () => {
  it('accepts a minimal secret bundle', () => {
    expect(parseCredentials({ accessToken: 'abc' })).toEqual({ accessToken: 'abc' });
  });

  it('rejects an empty or malformed bundle with AuthError', () => {
    expect(() => parseCredentials({})).toThrow(AuthError);
    expect(() => parseCredentials({ accessToken: '' })).toThrow(AuthError);
    expect(() => parseCredentials(null)).toThrow(AuthError);
  });

  it('round-trips through the encrypted storage format', () => {
    const creds: YandexCredentials = {
      accessToken: 'abc',
      refreshToken: 'ref',
      clientLogin: 'sub-account',
      useOperatorUnits: true,
    };
    const restored = parseCredentials(decryptJson<unknown>(encryptJson(creds)));
    expect(restored).toEqual(creds);
    expect(yandexCredentialsSchema.safeParse(restored).success).toBe(true);
  });
});

describe('isTokenNearExpiry', () => {
  const now = Date.parse('2026-08-08T00:00:00Z');

  it('is false when no expiry is stored', () => {
    expect(isTokenNearExpiry({ accessToken: 'a' }, now)).toBe(false);
  });

  it('is false while the token has more than the lead time left', () => {
    const expiresAt = new Date(now + REFRESH_LEAD_MS + 60_000).toISOString();
    expect(isTokenNearExpiry({ accessToken: 'a', expiresAt }, now)).toBe(false);
  });

  it('is true inside the lead window and after expiry', () => {
    expect(
      isTokenNearExpiry({ accessToken: 'a', expiresAt: new Date(now + 1000).toISOString() }, now),
    ).toBe(true);
    expect(
      isTokenNearExpiry({ accessToken: 'a', expiresAt: new Date(now - 1000).toISOString() }, now),
    ).toBe(true);
  });

  it('is false for an unparsable expiry rather than refreshing on every call', () => {
    expect(isTokenNearExpiry({ accessToken: 'a', expiresAt: 'вчера' }, now)).toBe(false);
  });
});

describe('ensureFreshCredentials', () => {
  const store: CredentialStore = {
    load: async () => null,
    save: async () => undefined,
  };

  it('returns the credentials untouched when the token is far from expiry', async () => {
    const creds: YandexCredentials = { accessToken: 'a', refreshToken: 'r' };
    expect(await ensureFreshCredentials('client-1', creds, store)).toBe(creds);
  });

  it('returns the credentials untouched when there is no refresh token to use', async () => {
    const creds: YandexCredentials = { accessToken: 'a', expiresAt: new Date(0).toISOString() };
    expect(await ensureFreshCredentials('client-1', creds, store)).toBe(creds);
  });
});
