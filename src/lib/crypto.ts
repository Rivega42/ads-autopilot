import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '@/config/index.js';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12; // рекомендованный размер nonce для GCM
const TAG_LEN = 16;

function key(): Buffer {
  return Buffer.from(env.ENCRYPTION_KEY, 'hex');
}

/**
 * Шифрует строку в формат `v1.<iv>.<tag>.<ciphertext>` (все части base64url).
 * Префикс версии оставляет возможность ротации ключа/алгоритма без миграции данных.
 */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join(
    '.',
  );
}

export function decrypt(payload: string): string {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Malformed ciphertext: expected v1.<iv>.<tag>.<data>');
  }
  const iv = Buffer.from(parts[1]!, 'base64url');
  const tag = Buffer.from(parts[2]!, 'base64url');
  const ct = Buffer.from(parts[3]!, 'base64url');
  if (iv.length !== IV_LEN || tag.length !== TAG_LEN) {
    throw new Error('Malformed ciphertext: bad iv/tag length');
  }
  const decipher = createDecipheriv(ALGO, key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** Удобные обёртки: секреты кабинетов хранятся как JSON-объект. */
export function encryptJson(value: unknown): string {
  return encrypt(JSON.stringify(value));
}

export function decryptJson<T>(payload: string): T {
  return JSON.parse(decrypt(payload)) as T;
}

/** Сравнение секретов без утечки времени — для вебхуков и callback-подписей. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
