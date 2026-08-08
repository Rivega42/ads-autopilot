import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  assertHashedContacts,
  countByKind,
  hashContact,
  hashContacts,
  hashEmail,
  hashPhone,
  normalizeEmail,
  normalizePhone,
  type VkContactKind,
  type VkHashedContact,
} from '@/clients/vk-ads/contacts.js';
import { ChannelError } from '@/lib/errors.js';

const RAW_EMAIL = 'test@example.com';
/** Опубликованный вектор SHA-256 для 'test@example.com'. */
const EMAIL_SHA256 = '973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b';
const RAW_PHONE = '+7 (900) 123-45-67';
const NORMALIZED_PHONE = '79001234567';

/** Всё, что уехало бы в лог или в ErrorLog по этой ошибке. */
function errorSurface(err: unknown): string {
  const e = err as ChannelError;
  return `${e.message} ${JSON.stringify(e.context)}`;
}

describe('normalizeEmail', () => {
  it('lowercases and trims so the same address gives the same hash', () => {
    expect(normalizeEmail('  Ivan.Petrov@EXAMPLE.COM ')).toBe('ivan.petrov@example.com');
    expect(normalizeEmail('\tTEST@Example.Com\n')).toBe(RAW_EMAIL);
  });

  it('rejects a string that is not an address', () => {
    expect(() => normalizeEmail('not-an-email')).toThrow(ChannelError);
    expect(() => normalizeEmail('   ')).toThrow(ChannelError);
    expect(() => normalizeEmail('a@b')).toThrow(ChannelError);
    expect(() => normalizeEmail('two words@example.com')).toThrow(ChannelError);
  });
});

describe('normalizePhone', () => {
  it('brings +7, 8 and bare national forms to one digits-only value', () => {
    // Формат площадки: [код страны][код региона][номер] без плюса и разделителей.
    for (const raw of [
      '+7 (900) 123-45-67',
      '8 900 123 45 67',
      '8-900-123-45-67',
      '79001234567',
      '9001234567',
      ' +7 900 1234567 ',
    ]) {
      expect(normalizePhone(raw)).toBe(NORMALIZED_PHONE);
    }
  });

  it('keeps a foreign country code as is', () => {
    expect(normalizePhone('+1 (415) 555-01-99')).toBe('14155550199');
  });

  it('rejects numbers that cannot be a phone', () => {
    expect(() => normalizePhone('12345')).toThrow(ChannelError);
    expect(() => normalizePhone('no digits here')).toThrow(ChannelError);
    expect(() => normalizePhone('7900123456789012345')).toThrow(ChannelError);
  });
});

describe('hashing', () => {
  it('matches the published SHA-256 vector for a normalised email', () => {
    expect(hashEmail(RAW_EMAIL)).toEqual({ kind: 'email', hash: EMAIL_SHA256 });
    // Нормализация обязана происходить ДО хеширования, иначе мэтч не сойдётся.
    expect(hashEmail('  TEST@Example.COM ').hash).toBe(EMAIL_SHA256);
  });

  it('hashes the normalised phone, not the raw string', () => {
    const expected = createHash('sha256').update(NORMALIZED_PHONE, 'utf8').digest('hex');
    expect(hashPhone(RAW_PHONE).hash).toBe(expected);
    expect(hashPhone('8 900 123 45 67').hash).toBe(expected);
    // Хеш от сырой строки — другое значение; если бы он совпал, тест был бы бесполезен.
    expect(createHash('sha256').update(RAW_PHONE, 'utf8').digest('hex')).not.toBe(expected);
  });

  it('never puts the raw contact into the error it throws', () => {
    const cases: Array<{ kind: VkContactKind; raw: string; fragment: string }> = [
      { kind: 'email', raw: 'roman.gudkov@example.com и мусор', fragment: 'roman.gudkov' },
      { kind: 'phone', raw: '+7 (900) 123-45-67-89-01-23', fragment: '900' },
    ];

    for (const { kind, raw, fragment } of cases) {
      const err = (() => {
        try {
          hashContact(kind, raw);
          return null;
        } catch (e) {
          return e;
        }
      })();

      expect(err).toBeInstanceOf(ChannelError);
      expect((err as ChannelError).code).toBe('VK_INVALID_CONTACT');
      const surface = errorSurface(err);
      expect(surface).not.toContain(raw);
      expect(surface).not.toContain(fragment);
    }
  });
});

describe('hashContacts', () => {
  it('skips junk and deduplicates instead of failing the whole list', () => {
    const batch = hashContacts({
      emails: ['A@example.com', 'a@example.com', 'broken', ''],
      phones: ['+79001234567', '89001234567', '123'],
    });

    expect(batch.contacts).toHaveLength(2);
    expect(batch.skipped).toBe(3);
    expect(batch.duplicates).toBe(2);
    expect(countByKind(batch.contacts)).toEqual({ email: 1, phone: 1 });
  });

  it('produces only 64-char lowercase hex', () => {
    const batch = hashContacts({ emails: ['User+Tag@Example.COM'], phones: ['89990001122'] });
    for (const contact of batch.contacts) expect(contact.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('assertHashedContacts', () => {
  it('rejects a raw contact smuggled past the type system', () => {
    const smuggled = ['roman.gudkov@example.com'] as unknown as VkHashedContact[];
    const err = (() => {
      try {
        assertHashedContacts(smuggled);
        return null;
      } catch (e) {
        return e;
      }
    })();

    expect((err as ChannelError).code).toBe('VK_RAW_CONTACT');
    expect(errorSurface(err)).not.toContain('roman.gudkov@example.com');
  });

  it('rejects a hand-made object whose hash is not SHA-256', () => {
    const faked = [{ kind: 'phone', hash: '79001234567' }] as unknown as VkHashedContact[];
    expect(() => assertHashedContacts(faked)).toThrow(ChannelError);
    expect(() => assertHashedContacts([{ kind: 'sms' } as unknown as VkHashedContact])).toThrow(
      ChannelError,
    );
  });

  it('passes real hashes through', () => {
    expect(() => assertHashedContacts([hashEmail(RAW_EMAIL), hashPhone(RAW_PHONE)])).not.toThrow();
  });
});
