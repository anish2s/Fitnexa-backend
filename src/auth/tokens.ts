import { createHash, randomBytes } from 'node:crypto';

/** 256-bit random token, URL-safe. Used for refresh tokens and email links. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Only hashes of tokens are stored. A database leak therefore can't be replayed as sessions or
 * login links. SHA-256 (not scrypt) is right here: the input is 256 random bits, not a password.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Cheap shape check so garbage never reaches the database. */
export function isWellFormedToken(token: unknown): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
}
