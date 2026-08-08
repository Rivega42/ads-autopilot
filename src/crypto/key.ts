import { env } from '../env.js';

let cached: Buffer | null = null;

export function getEncryptionKey(): Buffer {
  if (cached) return cached;
  const raw = env.CREDENTIALS_ENCRYPTION_KEY;
  const buf = Buffer.from(raw, 'base64');
  if (buf.byteLength !== 32) {
    throw new Error(
      `CREDENTIALS_ENCRYPTION_KEY must be 32 bytes (base64-encoded). Got ${buf.byteLength} bytes.`,
    );
  }
  cached = buf;
  return cached;
}
