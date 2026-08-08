import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { seal, unseal } from '../aead.js';

const key = randomBytes(32);

describe('aead', () => {
  it('round-trip: seal then unseal returns original plaintext', () => {
    const plaintext = JSON.stringify({ token: 'ya29.secret', refreshToken: 'refresh-xyz' });
    const sealed = seal(plaintext, key);
    expect(sealed.ciphertext).toBeInstanceOf(Buffer);
    expect(sealed.iv.byteLength).toBe(12);
    expect(sealed.tag.byteLength).toBe(16);
    expect(unseal(sealed, key)).toBe(plaintext);
  });

  it('iv is random — two seals of same plaintext differ', () => {
    const a = seal('hello', key);
    const b = seal('hello', key);
    expect(a.iv.toString('hex')).not.toBe(b.iv.toString('hex'));
  });

  it('tampered ciphertext throws', () => {
    const sealed = seal('sensitive', key);
    sealed.ciphertext.writeUInt8(sealed.ciphertext.readUInt8(0) ^ 0xff, 0);
    expect(() => unseal(sealed, key)).toThrow();
  });

  it('tampered tag throws', () => {
    const sealed = seal('sensitive', key);
    sealed.tag.writeUInt8(sealed.tag.readUInt8(0) ^ 0xff, 0);
    expect(() => unseal(sealed, key)).toThrow();
  });

  it('wrong key throws', () => {
    const sealed = seal('sensitive', key);
    const wrongKey = randomBytes(32);
    expect(() => unseal(sealed, wrongKey)).toThrow();
  });
});
