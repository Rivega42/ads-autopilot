import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelContext } from '@/channels/types.js';
import {
  clearVkTokenCache,
  getVkAccessToken,
  grantTypeFor,
  isTokenFresh,
  isTokenLimitResponse,
  mintVkToken,
  readVkCredentials,
  refreshMarginForTtlMs,
  VK_MIN_REMINT_INTERVAL_MS,
  VK_REFRESH_MARGIN_MS,
  VK_TOKEN_TTL_SEC,
  type VkAuthDeps,
  type VkCredentials,
} from '@/clients/vk/auth.js';
import { AuthError, ChannelError } from '@/lib/errors.js';

interface PostCall {
  url: string;
  body: Record<string, string>;
}

function depsOf(
  responses: Array<{ status: number; data: unknown }>,
  now = () => 1_700_000_000_000,
): { deps: VkAuthDeps; posts: PostCall[]; saved: VkCredentials[] } {
  const posts: PostCall[] = [];
  const saved: VkCredentials[] = [];
  let i = 0;
  const deps: VkAuthDeps = {
    post: async (url, body) => {
      posts.push({ url, body: Object.fromEntries(body.entries()) });
      const res = responses[Math.min(i, responses.length - 1)] ?? { status: 200, data: {} };
      i += 1;
      return res;
    },
    save: async (_clientId, creds) => {
      saved.push(creds);
    },
    now,
  };
  return { deps, posts, saved };
}

const baseCreds: VkCredentials = { clientId: 'cid', clientSecret: 'secret' };

function ctxOf(credentials: Record<string, unknown>, clientId = 'client-1'): ChannelContext {
  return { clientId, credentials, dryRun: false };
}

beforeEach(() => {
  clearVkTokenCache();
});

describe('readVkCredentials', () => {
  it('accepts both camelCase and snake_case keys', () => {
    const creds = readVkCredentials({
      client_id: 'A',
      clientSecret: 'B',
      agency_client_name: '4242',
      access_token: 'tok',
    });
    expect(creds).toMatchObject({
      clientId: 'A',
      clientSecret: 'B',
      agencyClientName: '4242',
      accessToken: 'tok',
    });
  });

  it('fails loudly when there is nothing to authenticate with', () => {
    expect(() => readVkCredentials({})).toThrow(AuthError);
  });
});

describe('grantTypeFor', () => {
  it('switches to the agency grant only when an agency client is named', () => {
    expect(grantTypeFor(baseCreds)).toBe('client_credentials');
    expect(grantTypeFor({ ...baseCreds, agencyClientName: '77' })).toBe(
      'agency_client_credentials',
    );
  });
});

describe('isTokenFresh', () => {
  it('treats a token as stale once it enters the 4-hour refresh window', () => {
    const now = 1_000_000;
    expect(isTokenFresh(now + VK_REFRESH_MARGIN_MS + 1, now)).toBe(true);
    expect(isTokenFresh(now + VK_REFRESH_MARGIN_MS, now)).toBe(false);
    expect(isTokenFresh(undefined, now)).toBe(false);
  });
});

describe('refreshMarginForTtlMs', () => {
  it('never eats more than half of a short token life', () => {
    // Суточный токен обновляем за 4 часа — как и раньше.
    expect(refreshMarginForTtlMs(VK_TOKEN_TTL_SEC * 1000)).toBe(VK_REFRESH_MARGIN_MS);
    // 100-секундный токен с 4-часовым запасом был бы протухшим в момент выдачи.
    expect(refreshMarginForTtlMs(100_000)).toBe(50_000);
    expect(refreshMarginForTtlMs(0)).toBe(0);
  });
});

describe('isTokenLimitResponse', () => {
  it('recognises only VK’s own token-ceiling wording', () => {
    expect(
      isTokenLimitResponse(403, {
        error: { code: 'limit', message: 'Max count of tokens reached' },
      }),
    ).toBe(true);
    expect(isTokenLimitResponse(403, { error: { message: 'tokens limit' } })).toBe(true);
  });

  it('does not read a rate limit, an empty body or a plain 403 as the ceiling', () => {
    // Сносить все токены пользователя из-за такого 403 — убить и воркера, и бота.
    expect(isTokenLimitResponse(403, { error: { message: 'Rate limit exceeded' } })).toBe(false);
    expect(isTokenLimitResponse(403, '')).toBe(false);
    expect(isTokenLimitResponse(403, undefined)).toBe(false);
    expect(isTokenLimitResponse(403, { error: { message: 'Access denied' } })).toBe(false);
    expect(isTokenLimitResponse(200, { error: { message: 'tokens limit' } })).toBe(false);
  });
});

describe('mintVkToken', () => {
  it('deletes the known previous token before asking for a new one', async () => {
    const { deps, posts } = depsOf([
      { status: 200, data: { success: 1 } },
      { status: 200, data: { access_token: 'new', expires_in: VK_TOKEN_TTL_SEC } },
    ]);

    const minted = await mintVkToken({ ...baseCreds, accessToken: 'old' }, deps);

    expect(posts).toHaveLength(2);
    expect(posts[0]?.url).toContain('oauth2/token/delete.json');
    expect(posts[0]?.body['access_token']).toBe('old');
    expect(posts[1]?.url).toContain('oauth2/token.json');
    expect(minted.accessToken).toBe('new');
    expect(minted.expiresAtMs).toBe(1_700_000_000_000 + VK_TOKEN_TTL_SEC * 1000);
  });

  it('frees a slot and retries once when VK answers 403 on the 5-token ceiling', async () => {
    const { deps, posts } = depsOf([
      // Старого токена нет — сразу просим новый и получаем потолок.
      { status: 403, data: { error: { code: 'limit', message: 'Max count of tokens reached' } } },
      { status: 200, data: { success: 1 } },
      { status: 200, data: { access_token: 'after-cleanup', expires_in: 100 } },
    ]);

    const minted = await mintVkToken(baseCreds, deps);

    expect(posts.map((p) => p.url.split('/api/v2/')[1])).toEqual([
      'oauth2/token.json',
      'oauth2/token/delete.json',
      'oauth2/token.json',
    ]);
    // Слот освобождаем по всему пользователю: чей именно токен занял 5-й слот, мы не знаем.
    expect(posts[1]?.body['access_token']).toBeUndefined();
    expect(minted.accessToken).toBe('after-cleanup');
    // Короткий TTL доезжает до вызывающего: по нему считается запас на обновление.
    expect(minted.ttlMs).toBe(100_000);
    expect(minted.expiresAtMs).toBe(1_700_000_000_000 + 100_000);
  });

  it('does not free slots on a 403 that is merely a rate limit', async () => {
    const { deps, posts } = depsOf([
      { status: 403, data: { error: { message: 'Rate limit exceeded' } } },
    ]);

    await expect(mintVkToken(baseCreds, deps)).rejects.toBeInstanceOf(AuthError);
    // Ровно один запрос: никакого token/delete.json по всему пользователю.
    expect(posts.map((p) => p.url.split('/api/v2/')[1])).toEqual(['oauth2/token.json']);
  });

  it('does not free slots on an empty 403 from a WAF', async () => {
    const { deps, posts } = depsOf([{ status: 403, data: '' }]);

    await expect(mintVkToken(baseCreds, deps)).rejects.toBeInstanceOf(AuthError);
    expect(posts).toHaveLength(1);
  });

  it('treats a 503 from the token endpoint as retryable, not as an auth failure', async () => {
    const { deps } = depsOf([{ status: 503, data: { error: { message: 'upstream down' } } }]);

    const err = await mintVkToken(baseCreds, deps).catch((e: unknown) => e);
    // AuthError не ретраится: кабинет остался бы без токена до ручного вмешательства.
    expect(err).toBeInstanceOf(ChannelError);
    expect(err).not.toBeInstanceOf(AuthError);
    expect((err as ChannelError).retryable).toBe(true);
    expect((err as ChannelError).code).toBe('VK_TOKEN_ENDPOINT_UNAVAILABLE');
  });

  it('does not loop forever when the ceiling survives the cleanup', async () => {
    const { deps, posts } = depsOf([
      { status: 403, data: { error: { message: 'tokens limit' } } },
      { status: 200, data: { success: 1 } },
      { status: 403, data: { error: { message: 'tokens limit' } } },
    ]);

    await expect(mintVkToken(baseCreds, deps)).rejects.toBeInstanceOf(AuthError);
    expect(posts).toHaveLength(3);
  });

  it('rejects a token payload that does not look like a token', async () => {
    const { deps } = depsOf([{ status: 200, data: { nothing: 'here' } }]);
    await expect(mintVkToken(baseCreds, deps)).rejects.toMatchObject({
      code: 'VK_BAD_TOKEN_RESPONSE',
    });
  });
});

describe('getVkAccessToken', () => {
  it('reuses a still-valid token from the credential record without any network call', async () => {
    const now = 1_700_000_000_000;
    const { deps, posts } = depsOf([], () => now);
    const ctx = ctxOf({
      clientId: 'cid',
      clientSecret: 'secret',
      accessToken: 'stored',
      expiresAt: new Date(now + 10 * 60 * 60 * 1000).toISOString(),
    });

    await expect(getVkAccessToken(ctx, {}, deps)).resolves.toBe('stored');
    expect(posts).toHaveLength(0);
  });

  it('mints, caches, persists and writes the token back into the context', async () => {
    const now = 1_700_000_000_000;
    const { deps, posts, saved } = depsOf(
      [{ status: 200, data: { access_token: 'minted', expires_in: VK_TOKEN_TTL_SEC } }],
      () => now,
    );
    const ctx = ctxOf({ clientId: 'cid', clientSecret: 'secret' });

    await expect(getVkAccessToken(ctx, {}, deps)).resolves.toBe('minted');
    expect(saved[0]?.accessToken).toBe('minted');
    expect(ctx.credentials['accessToken']).toBe('minted');

    // Второй вызов обслуживается кешем процесса.
    await expect(getVkAccessToken(ctx, {}, deps)).resolves.toBe('minted');
    expect(posts).toHaveLength(1);
  });

  it('collapses parallel refreshes into a single token request', async () => {
    const { deps, posts } = depsOf([
      { status: 200, data: { access_token: 'once', expires_in: VK_TOKEN_TTL_SEC } },
    ]);
    const ctx = ctxOf({ clientId: 'cid', clientSecret: 'secret' });

    const tokens = await Promise.all([
      getVkAccessToken(ctx, {}, deps),
      getVkAccessToken(ctx, {}, deps),
      getVkAccessToken(ctx, {}, deps),
    ]);

    expect(tokens).toEqual(['once', 'once', 'once']);
    expect(posts.filter((p) => p.url.endsWith('oauth2/token.json'))).toHaveLength(1);
  });

  it('forceRefresh bypasses the cache once the remint guard has expired', async () => {
    let clock = 1_700_000_000_000;
    const { deps, posts } = depsOf(
      [{ status: 200, data: { access_token: 'first', expires_in: VK_TOKEN_TTL_SEC } }],
      () => clock,
    );
    const ctx = ctxOf({ clientId: 'cid', clientSecret: 'secret' });

    await getVkAccessToken(ctx, {}, deps);
    clock += VK_MIN_REMINT_INTERVAL_MS + 1;
    await getVkAccessToken(ctx, { forceRefresh: true }, deps);

    const tokenRequests = posts.filter((p) => p.url.endsWith('oauth2/token.json'));
    expect(tokenRequests).toHaveLength(2);
  });

  it('does not remint a token that was issued a moment ago', async () => {
    let clock = 1_700_000_000_000;
    const { deps, posts } = depsOf(
      [{ status: 200, data: { access_token: 'T1', expires_in: VK_TOKEN_TTL_SEC } }],
      () => clock,
    );
    const ctx = ctxOf({ clientId: 'cid', clientSecret: 'secret', accessToken: 'T0' });

    // R1 словил 401 и обновил токен.
    await expect(getVkAccessToken(ctx, { forceRefresh: true }, deps)).resolves.toBe('T1');
    // R2 ушёл в сеть ещё с T0, получил свой 401 секундой позже и тоже просит refresh.
    clock += 1_000;
    await expect(getVkAccessToken(ctx, { forceRefresh: true }, deps)).resolves.toBe('T1');

    // Второй минт снёс бы T1 (mint начинается с token/delete) и уронил бы ретрай R1.
    expect(posts.filter((p) => p.url.endsWith('oauth2/token.json'))).toHaveLength(1);
    expect(posts.filter((p) => p.url.endsWith('oauth2/token/delete.json'))).toHaveLength(1);
  });

  it('does not turn a short expires_in into a mint-and-delete loop', async () => {
    let clock = 1_700_000_000_000;
    // TTL меньше окна обновления в 4 часа: с фиксированным запасом такой токен
    // «протухает» в момент выдачи, и каждый запрос минтит новый.
    const { deps, posts } = depsOf(
      [{ status: 200, data: { access_token: 'short', expires_in: 3600 } }],
      () => clock,
    );
    const ctx = ctxOf({ clientId: 'cid', clientSecret: 'secret' });

    for (let i = 0; i < 20; i++) {
      await expect(getVkAccessToken(ctx, {}, deps)).resolves.toBe('short');
      clock += 1_000;
    }

    expect(posts.filter((p) => p.url.endsWith('oauth2/token.json'))).toHaveLength(1);
    expect(posts.filter((p) => p.url.endsWith('oauth2/token/delete.json'))).toHaveLength(0);
  });

  it('re-mints once the half-life of a short token is spent', async () => {
    let clock = 1_700_000_000_000;
    const { deps, posts } = depsOf(
      [{ status: 200, data: { access_token: 'short', expires_in: 3600 } }],
      () => clock,
    );
    const ctx = ctxOf({ clientId: 'cid', clientSecret: 'secret' });

    await getVkAccessToken(ctx, {}, deps);
    clock += 1_800_001;
    await getVkAccessToken(ctx, {}, deps);

    expect(posts.filter((p) => p.url.endsWith('oauth2/token.json'))).toHaveLength(2);
  });

  it('survives a failing credential store — the token is already usable', async () => {
    const { deps } = depsOf([
      { status: 200, data: { access_token: 'ok', expires_in: VK_TOKEN_TTL_SEC } },
    ]);
    deps.save = vi.fn().mockRejectedValue(new Error('db down'));
    const ctx = ctxOf({ clientId: 'cid', clientSecret: 'secret' });

    await expect(getVkAccessToken(ctx, {}, deps)).resolves.toBe('ok');
  });
});
