import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const _TAG_BYTES = 16; // exported for documentation; GCM tag is always 16 bytes

export interface SealedData {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

export function seal(plaintext: string, key: Buffer): SealedData {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: encrypted, iv, tag };
}

export function unseal(sealed: SealedData, key: Buffer): string {
  const decipher = createDecipheriv(ALGORITHM, key, sealed.iv);
  decipher.setAuthTag(sealed.tag);
  const decrypted = Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}
