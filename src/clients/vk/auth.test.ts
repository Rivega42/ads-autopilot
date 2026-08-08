import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelContext } from '@/channels/types.js';
import { AuthError } from '@/lib/errors.js';
import {
  clearVkTokenCache,
  getVkAccessToken,
  grantTypeFor,
  isTokenFresh,
  mintVkToken,
  readVkCredentials,
  VK_REFRESH_MARGIN_MS,
  VK_TOKEN_TTL_SEC,
  type VkAuthDeps,
  type VkCredentials,
} from '@/clients/vk/auth.js';

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

  it('forceRefresh bypasses the cache', async () => {
    const { deps, posts } = depsOf([
      { status: 200, data: { access_token: 'first', expires_in: VK_TOKEN_TTL_SEC } },
    ]);
    const ctx = ctxOf({ clientId: 'cid', clientSecret: 'secret' });

    await getVkAccessToken(ctx, {}, deps);
    await getVkAccessToken(ctx, { forceRefresh: true }, deps);

    const tokenRequests = posts.filter((p) => p.url.endsWith('oauth2/token.json'));
    expect(tokenRequests).toHaveLength(2);
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
