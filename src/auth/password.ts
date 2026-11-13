import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Password hashing with scrypt (memory-hard, built into Node, no native addon).
 *
 * Stored format:  scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>
 * Parameters live in the hash, so they can be raised later without breaking old hashes;
 * needsRehash() tells the login flow to upgrade a user's hash after a successful login.
 */
const PARAMS = { N: 2 ** 15, r: 8, p: 1 } as const;
const KEY_LEN = 64;
const SALT_LEN = 16;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128; // bound the work an attacker can make us do

function scrypt(password: string, salt: Buffer, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(
      password.normalize('NFKC'),
      salt,
      KEY_LEN,
      { ...opts, maxmem: 128 * 1024 * 1024 },
      (e, k) => (e ? reject(e) : resolve(k)),
    ),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await scrypt(password, salt, PARAMS);
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
}

function parse(stored: string) {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [, n, r, p, salt, hash] = parts;
  const N = Number(n);
  const R = Number(r);
  const P = Number(p);
  if (![N, R, P].every(Number.isInteger)) return null;
  return { N, r: R, p: P, salt: Buffer.from(salt!, 'base64'), hash: Buffer.from(hash!, 'base64') };
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  if (!parsed || password.length > PASSWORD_MAX) return false;
  const key = await scrypt(password, parsed.salt, { N: parsed.N, r: parsed.r, p: parsed.p });
  return key.length === parsed.hash.length && timingSafeEqual(key, parsed.hash);
}

export function needsRehash(stored: string): boolean {
  const parsed = parse(stored);
  return !parsed || parsed.N < PARAMS.N || parsed.r !== PARAMS.r || parsed.p !== PARAMS.p;
}

/**
 * A real hash of a random password, computed once. Used when a login names a user that doesn't
 * exist, so the response takes the same time as a wrong password (no user enumeration by timing).
 */
let dummy: Promise<string> | undefined;
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(16).toString('hex'));
  return dummy;
}
