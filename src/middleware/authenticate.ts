import type { RequestHandler } from 'express';
import { InvalidTokenError, verifyAccessToken, type JwtConfig } from '../auth/jwt.js';
import { effectivePermissions, type Permission, type TenantRole } from '../auth/permissions.js';
import { Errors } from '../lib/errors.js';
import { PlatformSession, Session } from '../modules/auth/session.model.js';
import { PlatformAdmin } from '../modules/platform/platform-admin.model.js';
import { User } from '../modules/users/user.model.js';

export type AuthContext =
  | {
      kind: 'tenant';
      userId: string;
      sessionId: string;
      role: TenantRole;
      permissions: Set<Permission>;
      tenantId: string;
    }
  | { kind: 'platform'; userId: string; sessionId: string; role: 'super_admin' };

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

/**
 * Verifies the Bearer access token and binds it to the request:
 *
 *  1. Signature, algorithm, issuer, audience, expiry (jose).
 *  2. A gym token is only valid on THAT gym's host (token.tid === resolved host tenant).
 *     A platform token is only valid on the platform host. This blocks replaying a Gym B token
 *     against Gym A, and super-admin tokens on gym hosts.
 *  3. The session must still exist and not be revoked (logout takes effect immediately).
 *  4. The user must still be active; role and permissions come from the DATABASE, not the token,
 *     so demoting or disabling someone applies on their next request.
 */
export function authenticate(jwt: JwtConfig): RequestHandler {
  return async (req, _res, next) => {
    const header = req.get('authorization');
    const match = header ? /^Bearer ([A-Za-z0-9._-]+)$/.exec(header) : null;
    if (!match) throw Errors.unauthorized();

    let claims;
    try {
      claims = await verifyAccessToken(jwt, match[1]!);
    } catch (err) {
      if (err instanceof InvalidTokenError && err.reason === 'expired') throw Errors.tokenExpired();
      throw Errors.unauthorized();
    }

    const now = new Date();
    if (claims.typ === 'tenant') {
      if (!req.tenant || req.tenant.id.toHexString() !== claims.tid) {
        req.log?.warn(
          { tokenTenant: claims.tid, hostTenant: req.tenant?.slug ?? null },
          'Token used on wrong host',
        );
        throw Errors.unauthorized();
      }
      if (req.tenant.status !== 'active') throw Errors.tenantSuspended();

      const [session, user] = await Promise.all([
        Session.exists({
          _id: claims.sid,
          userId: claims.sub,
          revokedAt: null,
          expiresAt: { $gt: now },
        }),
        User.findOne({ _id: claims.sub, status: 'active', archivedAt: null })
          .select('role permissions')
          .lean(),
      ]);
      if (!session || !user) throw Errors.unauthorized();

      req.auth = {
        kind: 'tenant',
        userId: claims.sub,
        sessionId: claims.sid,
        role: user.role as TenantRole,
        permissions: effectivePermissions(user.role as TenantRole, user.permissions ?? []),
        tenantId: claims.tid,
      };
      return next();
    }

    // platform token
    if (req.tenant) {
      req.log?.warn({ hostTenant: req.tenant.slug }, 'Platform token used on a gym host');
      throw Errors.unauthorized();
    }
    const [session, admin] = await Promise.all([
      PlatformSession.exists({
        _id: claims.sid,
        userId: claims.sub,
        revokedAt: null,
        expiresAt: { $gt: now },
      }),
      PlatformAdmin.exists({ _id: claims.sub, status: 'active' }),
    ]);
    if (!session || !admin) throw Errors.unauthorized();
    req.auth = { kind: 'platform', userId: claims.sub, sessionId: claims.sid, role: 'super_admin' };
    next();
  };
}

/** Requires a gym user holding ALL the given permissions. */
export function authorize(...required: Permission[]): RequestHandler {
  return (req, _res, next) => {
    const auth = req.auth;
    if (!auth) throw Errors.unauthorized();
    if (auth.kind !== 'tenant') throw Errors.forbidden();
    for (const p of required) if (!auth.permissions.has(p)) throw Errors.forbidden();
    next();
  };
}

/** Requires a super admin (platform host). */
export const requirePlatformAdmin: RequestHandler = (req, _res, next) => {
  if (!req.auth) throw Errors.unauthorized();
  if (req.auth.kind !== 'platform') throw Errors.forbidden();
  next();
};
