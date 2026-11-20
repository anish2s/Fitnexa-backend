import type { RequestHandler } from 'express';
import { InvalidTokenError, verifyAccessToken, type JwtConfig } from '../auth/jwt.js';
import { effectivePermissions, type Permission, type TenantRole } from '../auth/permissions.js';
import { Errors } from '../lib/errors.js';
import type { SiteKind } from '../tenancy/host.js';
import { tag } from '../lib/route-meta.js';
import { PlatformSession, Session } from '../modules/auth/session.model.js';
import { PlatformAdmin } from '../modules/platform/platform-admin.model.js';
import { User } from '../modules/users/user.model.js';

/**
 * Members belong to the member app, owners and staff (and "log in as owner" sessions) to the staff
 * dashboard. With no staff address configured (`any`) everyone belongs everywhere.
 */
export function assertRoleOnSite(site: SiteKind | undefined, role: string): void {
  if (site === 'member' && role !== 'member') throw Errors.wrongSite('member');
  if (site === 'staff' && role === 'member') throw Errors.wrongSite('staff');
}

export type AuthContext =
  | {
      kind: 'tenant';
      userId: string;
      name: string;
      sessionId: string;
      role: TenantRole;
      permissions: Set<Permission>;
      tenantId: string;
      /** Present only on a super admin's "log in as owner" session. */
      impersonator?: { id: string; name: string };
    }
  | { kind: 'platform'; userId: string; name: string; sessionId: string; role: 'super_admin' };

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
  return tag(
    async (req, _res, next) => {
      const header = req.get('authorization');
      const match = header ? /^Bearer ([A-Za-z0-9._-]+)$/.exec(header) : null;
      if (!match) throw Errors.unauthorized();

      let claims;
      try {
        claims = await verifyAccessToken(jwt, match[1]!);
      } catch (err) {
        if (err instanceof InvalidTokenError && err.reason === 'expired')
          throw Errors.tokenExpired();
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
          Session.findOne({
            _id: claims.sid,
            userId: claims.sub,
            revokedAt: null,
            expiresAt: { $gt: now },
          })
            .select('impersonatorId')
            .lean(),
          User.findOne({ _id: claims.sub, status: 'active', archivedAt: null })
            .select('name role permissions')
            .lean(),
        ]);
        if (!session || !user) throw Errors.unauthorized();
        assertRoleOnSite(req.site, user.role);

        let impersonator: { id: string; name: string } | undefined;
        const sessionImp = session.impersonatorId ? String(session.impersonatorId) : undefined;
        if (sessionImp !== claims.imp) throw Errors.unauthorized();
        if (sessionImp) {
          const admin = await PlatformAdmin.findOne({ _id: sessionImp, status: 'active' })
            .select('name')
            .lean();
          if (!admin) throw Errors.unauthorized();
          impersonator = { id: sessionImp, name: admin.name };
        }

        req.auth = {
          kind: 'tenant',
          userId: claims.sub,
          name: user.name,
          sessionId: claims.sid,
          role: user.role as TenantRole,
          permissions: effectivePermissions(user.role as TenantRole, user.permissions ?? []),
          tenantId: claims.tid,
          ...(impersonator ? { impersonator } : {}),
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
        PlatformAdmin.findOne({ _id: claims.sub, status: 'active' }).select('name').lean(),
      ]);
      if (!session || !admin) throw Errors.unauthorized();
      req.auth = {
        kind: 'platform',
        userId: claims.sub,
        name: admin.name,
        sessionId: claims.sid,
        role: 'super_admin',
      };
      next();
    },
    { kind: 'authenticate' },
  );
}

/**
 * For actions a super admin must not take while signed in as an owner: they would change the
 * owner's own credentials or end the owner's real sessions.
 */
export const notWhileImpersonating: RequestHandler = tag(
  (req, _res, next) => {
    if (req.auth?.kind === 'tenant' && req.auth.impersonator) {
      throw Errors.forbidden('Not available while signed in as the owner from the platform');
    }
    next();
  },
  { kind: 'notWhileImpersonating' },
);

/** Requires a gym user holding AT LEAST ONE of the given permissions (e.g. desk OR the member). */
export function authorizeAny(...anyOf: Permission[]): RequestHandler {
  return tag(
    (req, _res, next) => {
      const a = req.auth;
      if (!a) throw Errors.unauthorized();
      if (a.kind !== 'tenant' || !anyOf.some((p) => a.permissions.has(p))) throw Errors.forbidden();
      next();
    },
    { kind: 'authorizeAny', any: anyOf },
  );
}

/** Requires a gym user holding ALL the given permissions. */
export function authorize(...required: Permission[]): RequestHandler {
  return tag(
    (req, _res, next) => {
      const auth = req.auth;
      if (!auth) throw Errors.unauthorized();
      if (auth.kind !== 'tenant') throw Errors.forbidden();
      for (const p of required) if (!auth.permissions.has(p)) throw Errors.forbidden();
      next();
    },
    { kind: 'authorize', all: required },
  );
}

/** Requires a super admin (platform host). */
export const requirePlatformAdmin: RequestHandler = tag(
  (req, _res, next) => {
    if (!req.auth) throw Errors.unauthorized();
    if (req.auth.kind !== 'platform') throw Errors.forbidden();
    next();
  },
  { kind: 'platformAdmin' },
);
