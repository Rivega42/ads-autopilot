import 'dotenv/config';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '../../db/prisma.js';
import { ClientRepository } from '../ClientRepository.js';
import { CredentialRepository } from '../CredentialRepository.js';

/**
 * Журнал доступа к секретам кабинетов (CLAUDE.md §6).
 *
 * Проверяется на живой базе, а не на подставном клиенте: смысл журнала в том,
 * что строка действительно лежит в `AuditLog` и переживёт процесс. Тест,
 * который убеждается лишь в вызове метода, доказывал бы, что код написан, —
 * а не что запись есть.
 */

const clients = new ClientRepository(prisma);
const credentials = new CredentialRepository(prisma);

const YANDEX = { accessToken: 'y0_secret', refreshToken: 'r0_secret' };

async function reset() {
  await prisma.auditLog.deleteMany({});
  await prisma.credential.deleteMany({});
  await prisma.client.deleteMany({});
}

async function newClient() {
  const client = await clients.create({ tgUserId: BigInt(Date.now() % 1_000_000), name: 'Клиент' });
  return client.id;
}

async function auditRows() {
  return prisma.auditLog.findMany({
    orderBy: { id: 'asc' },
    select: { actor: true, action: true, resource: true, metadata: true },
  });
}

describe('CredentialRepository: журнал доступа', () => {
  beforeEach(reset);
  afterAll(async () => {
    await reset();
    await prisma.$disconnect();
  });

  it('чтение секрета оставляет запись', async () => {
    // Главный дефект, ради которого журнал и заводился: расшифровка шла мимо
    // аудита, и ответить «кто и когда доставал токен клиента» было нечем.
    const clientId = await newClient();
    await credentials.save(clientId, 'YANDEX_DIRECT', YANDEX);

    const before = await auditRows();
    await credentials.getPayload(clientId, 'YANDEX_DIRECT');
    const after = await auditRows();

    expect(after.length).toBe(before.length + 1);
    expect(after.at(-1)).toMatchObject({
      action: 'credential.read',
      resource: `credential:YANDEX_DIRECT:${clientId}`,
      metadata: { found: true },
    });
  });

  it('запись секрета оставляет запись', async () => {
    const clientId = await newClient();
    await credentials.save(clientId, 'YANDEX_DIRECT', YANDEX);

    expect(await auditRows()).toEqual([
      expect.objectContaining({
        action: 'credential.save',
        resource: `credential:YANDEX_DIRECT:${clientId}`,
      }),
    ]);
  });

  it('отзыв секрета оставляет запись', async () => {
    const clientId = await newClient();
    await credentials.save(clientId, 'YANDEX_DIRECT', YANDEX);
    await credentials.deactivate(clientId, 'YANDEX_DIRECT');

    const actions = (await auditRows()).map((row) => row.action);
    expect(actions).toEqual(['credential.save', 'credential.revoke']);
  });

  it('промах тоже виден: перебор клиентов не должен быть бесшумным', async () => {
    const clientId = await newClient();

    const payload = await credentials.getPayload(clientId, 'VK_ADS');

    expect(payload).toBeNull();
    expect((await auditRows()).at(-1)).toMatchObject({
      action: 'credential.read',
      metadata: { found: false },
    });
  });

  it('по умолчанию действующее лицо — система, а не клиент', async () => {
    // Клиент свой токен не читает: его читает наш воркер. Ставить в actor
    // clientId значило бы записывать в журнал заведомую неправду.
    const clientId = await newClient();
    await credentials.save(clientId, 'YANDEX_DIRECT', YANDEX);

    expect((await auditRows())[0]?.actor).toBe('system');
  });

  it('вызывающий может назвать себя', async () => {
    const clientId = await newClient();
    await credentials.save(clientId, 'YANDEX_DIRECT', YANDEX, { actor: 'onboarding' });
    await credentials.getPayload(clientId, 'YANDEX_DIRECT', {
      actor: 'ingestion',
      reason: 'плановый прогон',
    });

    const rows = await auditRows();
    expect(rows.map((row) => row.actor)).toEqual(['onboarding', 'ingestion']);
    expect(rows.at(-1)?.metadata).toMatchObject({ reason: 'плановый прогон' });
  });

  it('секрет не попадает в журнал', async () => {
    const clientId = await newClient();
    await credentials.save(clientId, 'YANDEX_DIRECT', YANDEX);
    await credentials.getPayload(clientId, 'YANDEX_DIRECT');

    const dump = JSON.stringify(await auditRows());
    expect(dump).not.toContain(YANDEX.accessToken);
    expect(dump).not.toContain(YANDEX.refreshToken);
  });

  it('несохранённый журнал не отдаёт секрет наружу', async () => {
    // Отказ закрытый, а не тихий: если записать факт выдачи не удалось,
    // выдавать нечего. `AuditLog` лежит в той же базе, что и `Credential`,
    // поэтому недоступность журнала на практике означает недоступность базы —
    // цена отказа закрытым близка к нулю.
    const clientId = await newClient();
    await credentials.save(clientId, 'YANDEX_DIRECT', YANDEX);

    const boom = new Error('audit log down');
    const broken = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop === 'auditLog') {
          return {
            create: () => Promise.reject(boom),
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });

    const repo = new CredentialRepository(broken);
    await expect(repo.getPayload(clientId, 'YANDEX_DIRECT')).rejects.toThrow('audit log down');
  });
});
