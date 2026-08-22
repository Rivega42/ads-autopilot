import 'dotenv/config';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '../../db/prisma.js';
import { ClientRepository } from '../ClientRepository.js';
import { CredentialRepository } from '../CredentialRepository.js';

/**
 * Инвариант хранения: открытого секрета в базе нет ни в одной колонке.
 *
 * До этого файла свойство держалось на юнит-тесте шифра и на том, что колонку
 * `encryptedPayload` никто не переименовал. Ни то, ни другое не поймало бы
 * добавления «удобного» поля рядом — например, `login` или `tokenHint`,
 * записанного как есть. Поэтому проверяется не колонка, а вся строка целиком:
 * `row::text` разворачивает любую колонку, включая ту, которой сегодня нет.
 */

const clients = new ClientRepository(prisma);
const credentials = new CredentialRepository(prisma);

/** Строка, которую нельзя спутать ни с чем: если она всплывёт — это наш токен. */
const TOKEN = 'y0_AgAAAAA-plaintext-canary-4f2a';
const REFRESH = '1:refresh-plaintext-canary:9b71';

async function reset(): Promise<void> {
  await prisma.auditLog.deleteMany({});
  await prisma.credential.deleteMany({});
  await prisma.client.deleteMany({});
}

async function newClient(): Promise<string> {
  const client = await clients.create({
    tgUserId: BigInt(Date.now() % 1_000_000),
    name: 'Клиент хранения',
  });
  return client.id;
}

/** Вся строка в текст — вместе с колонками, о которых этот тест не знает. */
async function rawRows(clientId: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ row: string }[]>`
    select c::text as row from "Credential" c where c."clientId" = ${clientId}
  `;
  return rows.map((r) => r.row);
}

/** Только байты шифротекста, в hex. */
async function cipherHex(): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ hex: string }[]>`
    select encode(c."encryptedPayload", 'hex') as hex from "Credential" c order by c.id
  `;
  return rows.map((r) => r.hex);
}

function encodings(secret: string): { name: string; needle: string }[] {
  // bytea печатается как \x…, поэтому «просто подстрока» поймала бы не всё:
  // токен, положенный в базу как есть, в этом выводе выглядит шестнадцатеричным.
  return [
    { name: 'открытым текстом', needle: secret },
    { name: 'в hex', needle: Buffer.from(secret, 'utf8').toString('hex') },
    { name: 'в base64', needle: Buffer.from(secret, 'utf8').toString('base64') },
  ];
}

beforeEach(reset);
afterAll(async () => {
  await reset();
  await prisma.$disconnect();
});

describe('Credential: что реально лежит в базе', () => {
  it('ни одна колонка строки не содержит секрета — ни текстом, ни в hex, ни в base64', async () => {
    const clientId = await newClient();
    await credentials.save(clientId, 'YANDEX_DIRECT', {
      accessToken: TOKEN,
      refreshToken: REFRESH,
      clientLogin: 'romashka-ads',
    });

    const rows = await rawRows(clientId);
    expect(rows).toHaveLength(1);
    const row = rows[0] ?? '';

    for (const secret of [TOKEN, REFRESH]) {
      for (const { name, needle } of encodings(secret)) {
        expect(row, `секрет найден ${name}`).not.toContain(needle);
      }
    }
  });

  it('секрет при этом читается обратно без потерь', async () => {
    const clientId = await newClient();
    const payload = { accessToken: TOKEN, refreshToken: REFRESH, useOperatorUnits: true };
    await credentials.save(clientId, 'YANDEX_DIRECT', payload);

    expect(await credentials.getPayload(clientId, 'YANDEX_DIRECT')).toEqual(payload);
  });

  it('два одинаковых секрета дают разный шифротекст: по базе не сравнить токены', async () => {
    const first = await newClient();
    const second = await newClient();
    await credentials.save(first, 'YANDEX_DIRECT', { accessToken: TOKEN });
    await credentials.save(second, 'YANDEX_DIRECT', { accessToken: TOKEN });

    // Сравниваются именно байты шифротекста: строка целиком различалась бы и
    // при хранении открытым текстом — из-за разных id, — то есть не доказывала бы
    // ничего.
    const [a, b] = await cipherHex();
    expect(a).toBeTruthy();
    expect(a).not.toEqual(b);
  });

  it('в журнале доступа секрета тоже нет — только кто, что и зачем', async () => {
    const clientId = await newClient();
    await credentials.save(
      clientId,
      'YANDEX_DIRECT',
      { accessToken: TOKEN },
      {
        actor: 'cli:credentials',
        reason: 'ручное заведение доступов',
      },
    );
    await credentials.getPayload(clientId, 'YANDEX_DIRECT', { actor: 'cli:credentials' });

    const rows = await prisma.$queryRaw<{ row: string }[]>`
      select a::text as row from "AuditLog" a
    `;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const { row } of rows) {
      for (const { needle } of encodings(TOKEN)) expect(row).not.toContain(needle);
    }
  });
});
