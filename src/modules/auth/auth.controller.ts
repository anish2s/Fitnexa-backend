import type { CookieOptions, Request, Response } from 'express';
import type { Env } from '../../config/env.js';
import { Errors } from '../../lib/errors.js';
import { noContent, ok } from '../../lib/response.js';
import { auditContextFrom, type AuditService } from '../audit/audit.service.js';
import type { AuthScope, AuthService, ClientMeta, IssuedSession } from './auth.service.js';

/**
 * HTTP in/out only. Business rules live in auth.service.ts.
 *
 * Refresh token: HttpOnly cookie, never in the response body, so page scripts (and any XSS) can't
 * read it. The access token is returned in the body; the frontend keeps it in memory.
 */
export function createAuthController(env: Env, auth: AuthService, audit: AuditService) {
  const cookieName = env.COOKIE_SECURE ? '__Host-gym_rt' : 'gym_rt';
  const cookieBase: CookieOptions = {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax',
    path: '/', // required by the __Host- prefix; no Domain attribute → host-only
  };

  const scopeOf = (req: Request): AuthScope =>
    req.tenant ? { kind: 'tenant', tenant: req.tenant } : { kind: 'platform' };
  const meta = (req: Request): ClientMeta => ({
    ip: req.ip,
    userAgent: req.get('user-agent'),
    requestId: req.id === undefined ? undefined : String(req.id),
  });

  function readRefreshCookie(req: Request): string | undefined {
    const raw = req.headers.cookie;
    if (!raw) return undefined;
    for (const part of raw.split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === cookieName) return part.slice(i + 1).trim();
    }
    return undefined;
  }

  function sendSession(res: Response, s: IssuedSession, status = 200) {
    res.cookie(cookieName, s.refreshToken, { ...cookieBase, expires: s.refreshExpiresAt });
    res.set('Cache-Control', 'no-store');
    return ok(
      res,
      { accessToken: s.accessToken, tokenType: 'Bearer', expiresIn: s.expiresIn, user: s.user },
      status,
    );
  }

  const clearCookie = (res: Response) => res.clearCookie(cookieName, cookieBase);

  /** Gym endpoints refuse to run for a suspended gym (except refresh/logout, which only end sessions). */
  function activeTenant(req: Request) {
    if (!req.tenant) throw Errors.tenantRequired();
    if (req.tenant.status !== 'active') throw Errors.tenantSuspended();
    return req.tenant;
  }

  return {
    async login(req: Request, res: Response) {
      if (req.tenant) activeTenant(req);
      const { identifier, password } = req.valid.body as { identifier: string; password: string };
      sendSession(res, await auth.loginWithPassword(scopeOf(req), identifier, password, meta(req)));
    },

    async requestMagicLink(req: Request, res: Response) {
      const tenant = activeTenant(req);
      const { email } = req.valid.body as { email: string };
      await auth.requestMagicLink(tenant, email, meta(req));
      ok(
        res,
        { message: 'If that email belongs to a member here, a sign-in link is on its way.' },
        202,
      );
    },

    async verifyMagicLink(req: Request, res: Response) {
      const tenant = activeTenant(req);
      const { token } = req.valid.body as { token: string };
      sendSession(res, await auth.verifyMagicLink(tenant, token, meta(req)));
    },

    async forgotPassword(req: Request, res: Response) {
      const tenant = activeTenant(req);
      const { email } = req.valid.body as { email: string };
      await auth.requestPasswordReset(tenant, email, meta(req));
      ok(
        res,
        { message: 'If that email belongs to an account here, a reset link is on its way.' },
        202,
      );
    },

    async resetPassword(req: Request, res: Response) {
      const tenant = activeTenant(req);
      const { token, password } = req.valid.body as { token: string; password: string };
      await auth.resetPassword(tenant, token, password, meta(req));
      noContent(res);
    },

    async refresh(req: Request, res: Response) {
      if (req.tenant) activeTenant(req);
      const token = readRefreshCookie(req);
      if (!token) throw Errors.invalidRefresh();
      try {
        sendSession(res, await auth.refresh(scopeOf(req), token, meta(req)));
      } catch (err) {
        // A dead refresh token should not linger in the browser; a race should keep it.
        if ((err as { code?: string }).code === 'INVALID_REFRESH') clearCookie(res);
        throw err;
      }
    },

    /** Role behind the refresh cookie, read-only (used by the web server's page guards). */
    async session(req: Request, res: Response) {
      const token = readRefreshCookie(req);
      const found = token ? await auth.sessionRole(scopeOf(req), token) : null;
      if (!found) throw Errors.invalidRefresh();
      res.set('Cache-Control', 'no-store');
      ok(res, found);
    },

    async logout(req: Request, res: Response) {
      const token = readRefreshCookie(req);
      if (token) await auth.logoutByRefreshToken(scopeOf(req), token);
      clearCookie(res);
      noContent(res);
    },

    async logoutAll(req: Request, res: Response) {
      await auth.logoutAll(scopeOf(req), req.auth!.userId);
      await audit.record(auditContextFrom(req), { action: 'auth.logout_all' });
      clearCookie(res);
      noContent(res);
    },

    async me(req: Request, res: Response) {
      const user = await auth.me(scopeOf(req), req.auth!.userId);
      res.set('Cache-Control', 'no-store');
      const a = req.auth!;
      ok(res, {
        user,
        scope: a.kind,
        gym: req.tenant ? { name: req.tenant.name, slug: req.tenant.slug } : null,
        // The dashboard shows a permanent banner while this is set.
        impersonatedBy: a.kind === 'tenant' && a.impersonator ? a.impersonator : null,
      });
    },

    async listSessions(req: Request, res: Response) {
      ok(res, await auth.listSessions(scopeOf(req), req.auth!.userId, req.auth!.sessionId));
    },

    async revokeSession(req: Request, res: Response) {
      const { id } = req.valid.params as { id: string };
      const found = await auth.logoutSession(scopeOf(req), req.auth!.userId, id);
      if (!found) throw Errors.notFound('Session');
      noContent(res);
    },

    async changePassword(req: Request, res: Response) {
      if (req.auth!.role === 'member') throw Errors.forbidden('Members sign in by email link');
      const { currentPassword, newPassword } = req.valid.body as {
        currentPassword: string;
        newPassword: string;
      };
      await auth.changePassword(
        scopeOf(req),
        req.auth!.userId,
        req.auth!.sessionId,
        currentPassword,
        newPassword,
      );
      await audit.record(auditContextFrom(req), { action: 'auth.password_change' });
      noContent(res);
    },

    async endImpersonation(req: Request, res: Response) {
      const a = req.auth!;
      if (a.kind !== 'tenant' || !a.impersonator) {
        throw Errors.badRequest('This session is not a platform sign-in');
      }
      await auth.endImpersonation(a.sessionId);
      await audit.record(auditContextFrom(req), {
        action: 'impersonation.end',
        target: { type: 'user', id: a.userId },
      });
      noContent(res);
    },
  };
}
