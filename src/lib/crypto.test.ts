import { describe, expect, it } from 'vitest';
import { decrypt, decryptJson, encrypt, encryptJson, safeEqual } from '@/lib/crypto.js';

describe('crypto', () => {
  it('расшифровывает то, что зашифровал', () => {
    const secret = 'y0_AgAAAABxxxxxxxxxxxxxxxxxxxxxxx';
    expect(decrypt(encrypt(secret))).toBe(secret);
  });

  it('переживает юникод и пустую строку', () => {
    for (const s of ['', 'токен с пробелами и ёмкостью', '🔐 emoji', 'a'.repeat(10_000)]) {
      expect(decrypt(encrypt(s))).toBe(s);
    }
  });

  it('даёт разный шифротекст для одного и того же входа', () => {
    // Случайный IV на каждое шифрование — иначе одинаковые токены
    // разных клиентов выглядели бы одинаково в дампе БД.
    expect(encrypt('same')).not.toBe(encrypt('same'));
  });

  it('пишет версию формата, чтобы можно было сменить алгоритм без миграции', () => {
    const parts = encrypt('x').split('.');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v1');
  });

  it('отвергает подделанный шифротекст, а не возвращает мусор', () => {
    const [v, iv, tag, ct] = encrypt('secret').split('.');
    // Меняем один байт данных: GCM обязан поймать это по тегу аутентификации.
    const tamperedCt = Buffer.from(ct!, 'base64url');
    tamperedCt[0] ^= 0xff;
    expect(() => decrypt([v, iv, tag, tamperedCt.toString('base64url')].join('.'))).toThrow();
  });

  it('отвергает битый формат', () => {
    for (const bad of ['', 'garbage', 'v1.only.three', 'v2.a.b.c']) {
      expect(() => decrypt(bad)).toThrow();
    }
  });

  it('round-trip для JSON сохраняет структуру', () => {
    const creds = { accessToken: 'a', refreshToken: 'b', expiresAt: 1234, scopes: ['read_ads'] };
    expect(decryptJson<typeof creds>(encryptJson(creds))).toEqual(creds);
  });

  describe('safeEqual', () => {
    it('сравнивает равные строки', () => {
      expect(safeEqual('abc', 'abc')).toBe(true);
    });

    it('различает разные строки и разные длины без исключения', () => {
      expect(safeEqual('abc', 'abd')).toBe(false);
      expect(safeEqual('abc', 'abcd')).toBe(false);
      expect(safeEqual('', 'a')).toBe(false);
    });
  });
});
