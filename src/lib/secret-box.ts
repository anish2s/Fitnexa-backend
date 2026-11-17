import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM for small secrets at rest (gyms' Razorpay key secrets). Format:
 * `v1.<iv>.<tag>.<ciphertext>` (base64url). GCM authenticates, so a tampered value fails to open.
 * `aad` binds a ciphertext to its owner (the gym id): a secret copied to another gym won't decrypt.
 */
export function sealSecret(plaintext: string, key: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const b = (x: Buffer) => x.toString('base64url');
  return `v1.${b(iv)}.${b(cipher.getAuthTag())}.${b(ct)}`;
}

export function openSecret(sealed: string, key: Buffer, aad: string): string {
  const [v, iv, tag, ct] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || ct === undefined) throw new Error('Unsupported secret format');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}
