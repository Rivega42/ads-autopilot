import type { Provider } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runCredentialsCommand, type CredentialsCommandDeps } from './command.js';

import type { CredentialAccess } from '@/repos/CredentialRepository.js';

const TOKEN = 'y0__xCq1234567890abcdef';
const CODE = '7654321';

interface SaveCall {
  clientId: string;
  provider: Provider;
  payload: unknown;
  access: CredentialAccess;
}

let saves: SaveCall[];
let revokes: SaveCall[];
let lines: string[];

function deps(patch: Partial<CredentialsCommandDeps> = {}): CredentialsCommandDeps {
  return {
    repo: {
      save: async (clientId, provider, payload, access = {}) => {
        saves.push({ clientId, provider, payload, access });
        return { id: 'cred-1' };
      },
      deactivate: async (clientId, provider, access = {}) => {
        revokes.push({ clientId, provider, payload: null, access });
      },
      listForClient: async () => [
        {
          provider: 'YANDEX_DIRECT' as Provider,
          rotatedAt: new Date('2026-08-20T10:00:00Z'),
          expiresAt: null,
        },
      ],
    },
    lookupClient: async (id) =>
      id === 'c1' ? { id: 'c1', name: 'Ромашка', status: 'ACTIVE' } : null,
    readSecret: async () => ({ kind: 'stdin', value: TOKEN }),
    exchangeCode: async () => ({ accessToken: TOKEN, refreshToken: '1:r:zz' }),
    authorizeUrl: () => 'https://oauth.yandex.ru/authorize?response_type=code&client_id=app',
    out: (line) => lines.push(line),
    ...patch,
  };
}

const printed = (): string => lines.join('\n');

beforeEach(() => {
  saves = [];
  revokes = [];
  lines = [];
});

describe('credentials set', () => {
  it('кладёт секрет через репозиторий — единственный путь записи', async () => {
    await runCredentialsCommand(
      { action: 'set', clientId: 'c1', provider: 'yandex', apply: true },
      deps(),
    );
    expect(saves).toHaveLength(1);
    expect(saves[0]?.clientId).toBe('c1');
    expect(saves[0]?.provider).toBe('YANDEX_DIRECT');
    expect(saves[0]?.payload).toEqual({ accessToken: TOKEN });
  });

  it('называет себя в журнале доступа и говорит, откуда взялся секрет', async () => {
    await runCredentialsCommand(
      { action: 'set', clientId: 'c1', provider: 'yandex', apply: true },
      deps(),
    );
    expect(saves[0]?.access.actor).toBe('cli:credentials');
    expect(saves[0]?.access.reason).toMatch(/stdin/);
    expect(saves[0]?.access.reason).not.toContain(TOKEN);
  });

  it('без --apply ничего не пишет и говорит, чего не хватает', async () => {
    await runCredentialsCommand({ action: 'set', clientId: 'c1', provider: 'yandex' }, deps());
    expect(saves).toHaveLength(0);
    expect(printed()).toMatch(/--apply/);
  });

  it('в выводе только последние 4 символа токена (CLAUDE.md §6)', async () => {
    await runCredentialsCommand(
      { action: 'set', clientId: 'c1', provider: 'yandex', apply: true },
      deps(),
    );
    expect(printed()).not.toContain(TOKEN);
    expect(printed()).toContain('cdef');
  });

  it('незнакомый клиент — отказ до чтения секрета', async () => {
    const readSecret = vi.fn(async () => ({ kind: 'stdin' as const, value: TOKEN }));
    await expect(
      runCredentialsCommand(
        { action: 'set', clientId: 'нет-такого', provider: 'yandex', apply: true },
        deps({ readSecret }),
      ),
    ).rejects.toThrow(/нет-такого/);
    expect(readSecret).not.toHaveBeenCalled();
    expect(saves).toHaveLength(0);
  });

  it('предупреждает про неактивного клиента: крон загрузки его пропустит', async () => {
    await runCredentialsCommand(
      { action: 'set', clientId: 'c1', provider: 'yandex', apply: true },
      deps({ lookupClient: async () => ({ id: 'c1', name: 'Ромашка', status: 'PAUSED' }) }),
    );
    expect(saves).toHaveLength(1);
    expect(printed()).toMatch(/PAUSED/);
  });

  it('требует --client и --provider явно', async () => {
    await expect(
      runCredentialsCommand({ action: 'set', provider: 'yandex' }, deps()),
    ).rejects.toThrow(/--client/);
    await expect(runCredentialsCommand({ action: 'set', clientId: 'c1' }, deps())).rejects.toThrow(
      /--provider/,
    );
  });
});

describe('credentials exchange', () => {
  it('меняет код на токен и сохраняет результат', async () => {
    const exchangeCode = vi.fn(async () => ({ accessToken: TOKEN, refreshToken: '1:r:zz' }));
    await runCredentialsCommand(
      { action: 'exchange', clientId: 'c1', provider: 'yandex', apply: true },
      deps({ readSecret: async () => ({ kind: 'stdin', value: CODE }), exchangeCode }),
    );
    expect(exchangeCode).toHaveBeenCalledWith(CODE, {});
    expect(saves[0]?.payload).toEqual({ accessToken: TOKEN, refreshToken: '1:r:zz' });
    expect(printed()).not.toContain(TOKEN);
  });

  it('без --apply код не тратится: он одноразовый', async () => {
    const exchangeCode = vi.fn(async () => ({ accessToken: TOKEN }));
    await runCredentialsCommand(
      { action: 'exchange', clientId: 'c1', provider: 'yandex' },
      deps({ readSecret: async () => ({ kind: 'stdin', value: CODE }), exchangeCode }),
    );
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(saves).toHaveLength(0);
  });

  it('переносит агентские поля из JSON в сохранённые секреты', async () => {
    const exchangeCode = vi.fn(async () => ({ accessToken: TOKEN, clientLogin: 'romashka-ads' }));
    await runCredentialsCommand(
      { action: 'exchange', clientId: 'c1', provider: 'yandex', apply: true },
      deps({
        readSecret: async () => ({
          kind: 'stdin',
          value: JSON.stringify({ code: CODE, clientLogin: 'romashka-ads' }),
        }),
        exchangeCode,
      }),
    );
    expect(exchangeCode).toHaveBeenCalledWith(CODE, { clientLogin: 'romashka-ads' });
  });

  it('у VK своего обмена кода нет — отказ, а не молчаливый Директ', async () => {
    await expect(
      runCredentialsCommand(
        { action: 'exchange', clientId: 'c1', provider: 'vk', apply: true },
        deps(),
      ),
    ).rejects.toThrow(/VK_ADS/);
  });
});

describe('credentials list / revoke / link', () => {
  it('list показывает каналы клиента и ни одного секрета', async () => {
    await runCredentialsCommand({ action: 'list', clientId: 'c1' }, deps());
    expect(printed()).toContain('YANDEX_DIRECT');
    expect(printed()).not.toContain(TOKEN);
  });

  it('revoke без --apply не удаляет', async () => {
    await runCredentialsCommand({ action: 'revoke', clientId: 'c1', provider: 'yandex' }, deps());
    expect(revokes).toHaveLength(0);
  });

  it('revoke --apply отзывает доступ и подписывается в журнале', async () => {
    await runCredentialsCommand(
      { action: 'revoke', clientId: 'c1', provider: 'yandex', apply: true },
      deps(),
    );
    expect(revokes).toHaveLength(1);
    expect(revokes[0]?.access.actor).toBe('cli:credentials');
    expect(revokes[0]?.access.reason).toBeTruthy();
  });

  it('link печатает ссылку авторизации и ничего не пишет в базу', async () => {
    await runCredentialsCommand({ action: 'link', provider: 'yandex' }, deps());
    expect(printed()).toContain('https://oauth.yandex.ru/authorize');
    expect(saves).toHaveLength(0);
  });

  it('неизвестное действие — отказ с перечнем известных', async () => {
    await expect(runCredentialsCommand({ action: 'кекс', clientId: 'c1' }, deps())).rejects.toThrow(
      /set/,
    );
  });
});
