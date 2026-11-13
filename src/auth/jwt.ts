import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';

/**
 * Short-lived access tokens (default 15 min), HS256.
 *
 *   sub  user id (tenant user or platform admin)
 *   sid  session id: checked against the sessions collection on every request, so logout and
 *        "log out everywhere" take effect immediately
 *   typ  'tenant' | 'platform'
 *   tid  gym id (tenant tokens only): must equal the gym resolved from the request host
 *   role owner | staff | member | super_admin
 */
export type AccessClaims =
  | { typ: 'tenant'; sub: string; sid: string; tid: string; role: 'owner' | 'staff' | 'member' }
  | { typ: 'platform'; sub: string; sid: string; role: 'super_admin' };

const AUDIENCE = 'gym-saas';
const ALG = 'HS256';

export interface JwtConfig {
  secret: string;
  issuer: string;
  ttlSec: number;
}

const keys = new WeakMap<JwtConfig, Uint8Array>();
function keyFor(cfg: JwtConfig) {
  let k = keys.get(cfg);
  if (!k) {
    k = new TextEncoder().encode(cfg.secret);
    keys.set(cfg, k);
  }
  return k;
}

export async function signAccessToken(cfg: JwtConfig, claims: AccessClaims): Promise<string> {
  const { sub, ...rest } = claims;
  return new SignJWT(rest)
    .setProtectedHeader({ alg: ALG, typ: 'JWT' })
    .setSubject(sub)
    .setIssuer(cfg.issuer)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${cfg.ttlSec}s`)
    .sign(keyFor(cfg));
}

export class InvalidTokenError extends Error {
  constructor(readonly reason: 'expired' | 'invalid') {
    super(`Access token ${reason}`);
  }
}

export async function verifyAccessToken(cfg: JwtConfig, token: string): Promise<AccessClaims> {
  try {
    const { payload } = await jwtVerify(token, keyFor(cfg), {
      algorithms: [ALG], // never accept "none" or an attacker-chosen algorithm
      issuer: cfg.issuer,
      audience: AUDIENCE,
      clockTolerance: 5,
    });
    const { sub, sid, typ, tid, role } = payload as Record<string, unknown>;
    if (typeof sub !== 'string' || typeof sid !== 'string') throw new InvalidTokenError('invalid');
    if (
      typ === 'tenant' &&
      typeof tid === 'string' &&
      (role === 'owner' || role === 'staff' || role === 'member')
    ) {
      return { typ, sub, sid, tid, role };
    }
    if (typ === 'platform' && role === 'super_admin' && tid === undefined) {
      return { typ, sub, sid, role };
    }
    throw new InvalidTokenError('invalid');
  } catch (err) {
    if (err instanceof InvalidTokenError) throw err;
    if (err instanceof joseErrors.JWTExpired) throw new InvalidTokenError('expired');
    throw new InvalidTokenError('invalid');
  }
}
