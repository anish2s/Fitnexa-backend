import type { Types } from 'mongoose';
import type { Env } from '../../config/env.js';
import { signAccessToken, type JwtConfig } from '../../auth/jwt.js';
import { effectivePermissions, type TenantRole } from '../../auth/permissions.js';
import { dummyHash, hashPassword, needsRehash, verifyPassword } from '../../auth/password.js';
import { hashToken, isWellFormedToken, randomToken } from '../../auth/tokens.js';
import { Errors } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import type { MailMessage, Mailer, SkipReason } from '../../lib/mailer.js';
import { normalizePhone } from '../../lib/phone.js';
import type { ResolvedTenant } from '../../tenancy/resolver.middleware.js';
import type { AuditContext, AuditService } from '../audit/audit.service.js';
import { PlatformAdmin } from '../platform/platform-admin.model.js';
import { User, toPublicUser } from '../users/user.model.js';
import { AuthToken, type AuthTokenType } from './auth-token.model.js';
import { PlatformSession, Session } from './session.model.js';

/**
 * Authentication service. Every function receives the scope it runs in:
 *   { kind: 'tenant', tenant }  — a gym host; runs inside that gym's tenant context
 *   { kind: 'platform' }        — the platform host; super admins only
 *
 * Tenant-scoped models (User, Session, AuthToken) are filtered by the tenant plugin, so a lookup on
 * Gym A's host can never find a Gym B user, session or link, whatever the client sends.
 */
export type AuthScope = { kind: 'tenant'; tenant: ResolvedTenant } | { kind: 'platform' };
export interface ClientMeta {
  ip?: string;
  userAgent?: string;
  requestId?: string;
}

export type InviteResult =
  { sent: true } | { sent: false; reason: 'no_email' | 'throttled' | 'send_failed' | SkipReason };

export interface IssuedSession {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: Date;
  sessionId: string;
  user: ReturnType<typeof toPublicUser> & { permissions: string[] };
}

const REFRESH_RACE_GRACE_MS = 20_000;
const EMAIL_LINKS_PER_15_MIN = 3;

export function createAuthService(deps: {
  env: Env;
  mailer: Mailer;
  logger: Logger;
  audit: AuditService;
}) {
  const { env, mailer, logger, audit } = deps;
  const jwt: JwtConfig = {
    secret: env.JWT_ACCESS_SECRET,
    issuer: env.JWT_ISSUER,
    ttlSec: env.ACCESS_TOKEN_TTL_SEC,
  };

  const sessionModel = (scope: AuthScope) => (scope.kind === 'tenant' ? Session : PlatformSession);
  /** Member app (email-link sign-in) and staff dashboard (password reset, invites) addresses. */
  const appUrl = (tenant: ResolvedTenant, path: string) =>
    env.GYM_APP_URL_TEMPLATE.replace('{slug}', tenant.slug) + path;
  const staffUrl = (tenant: ResolvedTenant, path: string) =>
    (env.STAFF_APP_URL_TEMPLATE ?? env.GYM_APP_URL_TEMPLATE).replace('{slug}', tenant.slug) + path;
  const clip = (s: string | undefined, n: number) => (s ? s.slice(0, n) : undefined);

  /** Audit context for actions performed by the principal themselves (sign-in, reset). */
  function selfContext(scope: AuthScope, p: Principal, meta: ClientMeta): AuditContext {
    return {
      actor:
        scope.kind === 'tenant'
          ? { type: 'user', id: String(p._id), name: p.name, role: p.role }
          : { type: 'platform_admin', id: String(p._id), name: p.name },
      ip: clip(meta.ip, 64),
      userAgent: clip(meta.userAgent, 300),
      requestId: clip(meta.requestId, 64),
    };
  }

  /**
   * Sends and reports success instead of throwing. Magic-link and forgot-password must answer 202
   * whether or not the account exists; if a provider failure became a 500 only for real accounts,
   * the endpoints would reveal who is registered. The failure is logged for the operator instead
   * (MailSendError carries no recipient, content or link).
   */
  async function safeSend(message: MailMessage): Promise<'sent' | 'send_failed' | SkipReason> {
    try {
      const result = await mailer.send(message);
      return result.status === 'sent' ? 'sent' : result.reason;
    } catch (err) {
      logger.error({ err, mail: { kind: message.kind } }, 'Email could not be sent');
      return 'send_failed';
    }
  }

  // ---------------------------------------------------------------- sessions

  type Principal = {
    _id: Types.ObjectId;
    name: string;
    email?: string | null;
    phone?: string | null;
    role: string;
    status?: string | null;
    permissions?: string[] | null;
  };

  function publicPrincipal(scope: AuthScope, p: Principal) {
    const permissions =
      scope.kind === 'tenant'
        ? [...effectivePermissions(p.role as TenantRole, p.permissions ?? [])]
        : [];
    return { ...toPublicUser(p), permissions };
  }

  async function accessTokenFor(scope: AuthScope, p: Principal, sid: string) {
    return scope.kind === 'tenant'
      ? signAccessToken(jwt, {
          typ: 'tenant',
          sub: String(p._id),
          sid,
          tid: scope.tenant.id.toHexString(),
          role: p.role as TenantRole,
        })
      : signAccessToken(jwt, { typ: 'platform', sub: String(p._id), sid, role: 'super_admin' });
  }

  async function issueSession(
    scope: AuthScope,
    p: Principal,
    meta: ClientMeta,
  ): Promise<IssuedSession> {
    const refreshToken = randomToken();
    const refreshExpiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
    const session = await sessionModel(scope).create({
      userId: p._id,
      refreshTokenHash: hashToken(refreshToken),
      expiresAt: refreshExpiresAt,
      lastUsedAt: new Date(),
      ip: clip(meta.ip, 64),
      userAgent: clip(meta.userAgent, 300),
    });
    const sid = String(session._id);
    return {
      accessToken: await accessTokenFor(scope, p, sid),
      expiresIn: env.ACCESS_TOKEN_TTL_SEC,
      refreshToken,
      refreshExpiresAt,
      sessionId: sid,
      user: publicPrincipal(scope, p),
    };
  }

  async function revokeUserSessions(
    scope: AuthScope,
    userId: Types.ObjectId | string,
    reason: 'logout_all' | 'password_changed' | 'user_disabled' | 'admin',
    exceptSessionId?: string,
  ) {
    const filter: Record<string, unknown> = { userId, revokedAt: null };
    if (exceptSessionId) filter._id = { $ne: exceptSessionId };
    await sessionModel(scope).updateMany(filter, {
      $set: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  /** Loads a principal that may hold a session right now (active, not archived). */
  async function loadActivePrincipal(scope: AuthScope, userId: unknown): Promise<Principal | null> {
    if (scope.kind === 'tenant') {
      return User.findOne({ _id: userId, status: 'active', archivedAt: null }).lean<Principal>();
    }
    return PlatformAdmin.findOne({ _id: userId, status: 'active' }).lean<Principal>();
  }

  // ---------------------------------------------------------------- password login

  async function findPasswordAccount(scope: AuthScope, identifier: string) {
    const id = identifier.trim().toLowerCase();
    const fields = '+passwordHash +failedLogins +lockedUntil';
    if (scope.kind === 'platform') {
      return {
        model: PlatformAdmin,
        doc: await PlatformAdmin.findOne({ email: id }).select(fields),
      };
    }
    let filter: Record<string, unknown>;
    if (id.includes('@')) filter = { email: id };
    else {
      const phone = normalizePhone(id);
      if (!phone) return { model: User, doc: null };
      filter = { phone };
    }
    // Members never have passwords; they can't be found by this route.
    const doc = await User.findOne({
      ...filter,
      role: { $in: ['owner', 'staff'] },
      archivedAt: null,
    }).select(fields);
    return { model: User, doc };
  }

  async function loginWithPassword(
    scope: AuthScope,
    identifier: string,
    password: string,
    meta: ClientMeta,
  ): Promise<IssuedSession> {
    const { model, doc } = await findPasswordAccount(scope, identifier);
    const now = new Date();

    if (!doc || !doc.get('passwordHash')) {
      await verifyPassword(password, await dummyHash()); // equalise timing
      throw Errors.invalidCredentials();
    }
    const lockedUntil = doc.get('lockedUntil') as Date | undefined;
    if (lockedUntil && lockedUntil > now) {
      throw Errors.loginLocked(Math.ceil((lockedUntil.getTime() - now.getTime()) / 60_000));
    }

    const ok = await verifyPassword(password, doc.get('passwordHash') as string);
    if (!ok) {
      // Atomic increment, so parallel guesses can't skip the lock.
      const updated = await (model as typeof User)
        .findOneAndUpdate(
          { _id: doc._id },
          { $inc: { failedLogins: 1 } },
          { returnDocument: 'after' },
        )
        .select('+failedLogins');
      if ((updated?.get('failedLogins') as number) >= env.LOGIN_MAX_ATTEMPTS) {
        await (model as typeof User).updateOne(
          { _id: doc._id },
          {
            $set: {
              failedLogins: 0,
              lockedUntil: new Date(now.getTime() + env.LOGIN_LOCK_MIN * 60_000),
            },
          },
        );
        logger.warn(
          { userId: String(doc._id), scope: scope.kind },
          'Account locked after failed logins',
        );
        await audit.record(
          { ...selfContext(scope, doc.toObject() as Principal, meta), actor: { type: 'system' } },
          {
            action: 'auth.account_locked',
            target: {
              type: scope.kind === 'tenant' ? 'user' : 'platform_admin',
              id: String(doc._id),
            },
            metadata: { minutes: env.LOGIN_LOCK_MIN },
          },
        );
      }
      throw Errors.invalidCredentials();
    }

    // Password correct from here on, so it is safe to say why login can't proceed.
    if (doc.get('status') === 'disabled') throw Errors.accountDisabled();
    if (doc.get('status') !== 'active') throw Errors.invalidCredentials();

    const set: Record<string, unknown> = { failedLogins: 0, lastLoginAt: now };
    if (needsRehash(doc.get('passwordHash') as string))
      set.passwordHash = await hashPassword(password);
    await (model as typeof User).updateOne(
      { _id: doc._id },
      { $set: set, $unset: { lockedUntil: 1 } },
    );

    const principal = doc.toObject() as Principal;
    const issued = await issueSession(scope, principal, meta);
    await audit.record(selfContext(scope, principal, meta), {
      action: 'auth.login',
      metadata: { sessionId: issued.sessionId },
    });
    return issued;
  }

  // ---------------------------------------------------------------- one-time email links

  async function issueLink(
    tenant: ResolvedTenant,
    type: AuthTokenType,
    userId: Types.ObjectId,
    ttlMs: number,
    meta: ClientMeta,
  ): Promise<string | null> {
    const recent = await AuthToken.countDocuments({
      userId,
      type,
      createdAt: { $gt: new Date(Date.now() - 15 * 60_000) },
    });
    if (recent >= EMAIL_LINKS_PER_15_MIN) {
      logger.info({ userId: String(userId), type }, 'Email link throttled');
      return null;
    }
    const token = randomToken();
    await AuthToken.create({
      type,
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + ttlMs),
      requestedIp: clip(meta.ip, 64),
    });
    return token;
  }

  async function consumeLink(types: AuthTokenType[], token: string) {
    if (!isWellFormedToken(token)) throw Errors.invalidLink();
    // Single atomic step: find an unused, unexpired link AND mark it used.
    const record = await AuthToken.findOneAndUpdate(
      {
        tokenHash: hashToken(token),
        type: { $in: types },
        usedAt: null,
        expiresAt: { $gt: new Date() },
      },
      { $set: { usedAt: new Date() } },
      { returnDocument: 'after' },
    ).lean();
    if (!record) throw Errors.invalidLink();
    return record;
  }

  /** Members: request a sign-in link. Always succeeds from the caller's point of view. */
  async function requestMagicLink(tenant: ResolvedTenant, email: string, meta: ClientMeta) {
    const user = await User.findOne({
      email: email.trim().toLowerCase(),
      role: 'member',
      status: 'active',
      archivedAt: null,
    }).lean();
    if (!user) return;
    const token = await issueLink(
      tenant,
      'magic_link',
      user._id,
      env.MAGIC_LINK_TTL_MIN * 60_000,
      meta,
    );
    if (!token) return;
    const link = appUrl(tenant, `/login/verify?token=${token}`);
    await safeSend({
      kind: 'magic_link',
      fromName: tenant.name,
      to: user.email!,
      subject: `Your sign-in link for ${tenant.name}`,
      text:
        `Hi ${user.name},\n\nTap the link below to sign in to ${tenant.name}. ` +
        `It works once and expires in ${env.MAGIC_LINK_TTL_MIN} minutes.\n\n${link}\n\n` +
        `If you didn't ask for this, you can ignore this email.`,
    });
  }

  async function verifyMagicLink(tenant: ResolvedTenant, token: string, meta: ClientMeta) {
    const record = await consumeLink(['magic_link'], token);
    const user = await User.findOne({ _id: record.userId, role: 'member' });
    if (!user || user.status !== 'active' || user.archivedAt) throw Errors.invalidLink();
    user.lastLoginAt = new Date();
    await user.save();
    return issueSession({ kind: 'tenant', tenant }, user.toObject() as Principal, meta);
  }

  /** Owners/staff: forgot password. Always succeeds from the caller's point of view. */
  async function requestPasswordReset(tenant: ResolvedTenant, email: string, meta: ClientMeta) {
    const user = await User.findOne({
      email: email.trim().toLowerCase(),
      role: { $in: ['owner', 'staff'] },
      status: 'active',
      archivedAt: null,
    }).lean();
    if (!user) return;
    const token = await issueLink(
      tenant,
      'password_reset',
      user._id,
      env.PASSWORD_RESET_TTL_MIN * 60_000,
      meta,
    );
    if (!token) return;
    await safeSend({
      kind: 'password_reset',
      fromName: tenant.name,
      to: user.email!,
      subject: `Reset your ${tenant.name} password`,
      text:
        `Hi ${user.name},\n\nUse this link to set a new password. It works once and expires in ` +
        `${env.PASSWORD_RESET_TTL_MIN} minutes.\n\n${staffUrl(tenant, `/reset-password?token=${token}`)}\n\n` +
        `If you didn't ask for this, ignore this email. Your password won't change.`,
    });
  }

  /**
   * Sends an invite so a new owner/staff member can set their first password (used from M3/M4).
   * Returns why it wasn't sent, so the console can say "try again later" vs "email failed".
   */
  async function sendInvite(
    tenant: ResolvedTenant,
    userId: Types.ObjectId,
    meta: ClientMeta = {},
  ): Promise<InviteResult> {
    const user = await User.findOne({ _id: userId, role: { $in: ['owner', 'staff'] } }).lean();
    if (!user?.email) return { sent: false, reason: 'no_email' };
    const token = await issueLink(
      tenant,
      'invite',
      user._id,
      env.INVITE_TTL_HOURS * 3_600_000,
      meta,
    );
    if (!token) return { sent: false, reason: 'throttled' };
    const outcome = await safeSend({
      kind: 'invite',
      fromName: tenant.name,
      to: user.email,
      subject: `You've been invited to ${tenant.name}`,
      text:
        `Hi ${user.name},\n\nYou've been given access to ${tenant.name}. Set your password here ` +
        `(valid for ${env.INVITE_TTL_HOURS} hours):\n\n${staffUrl(tenant, `/reset-password?token=${token}`)}`,
    });
    // Unlike sign-in links, the inviter is told the outcome: they know the address already.
    return outcome === 'sent' ? { sent: true } : { sent: false, reason: outcome };
  }

  /** Completes a password reset OR an invite. All existing sessions are revoked. */
  async function resetPassword(
    tenant: ResolvedTenant,
    token: string,
    newPassword: string,
    meta: ClientMeta = {},
  ) {
    const record = await consumeLink(['password_reset', 'invite'], token);
    const user = await User.findOne({ _id: record.userId, role: { $in: ['owner', 'staff'] } });
    if (!user || user.status === 'disabled' || user.archivedAt) throw Errors.invalidLink();
    user.set({
      passwordHash: await hashPassword(newPassword),
      passwordChangedAt: new Date(),
      status: 'active',
      failedLogins: 0,
      lockedUntil: undefined,
    });
    await user.save();
    await revokeUserSessions({ kind: 'tenant', tenant }, user._id, 'password_changed');
    // Any other outstanding reset/invite links for this user die too.
    await AuthToken.updateMany(
      { userId: user._id, type: { $in: ['password_reset', 'invite'] }, usedAt: null },
      { $set: { usedAt: new Date() } },
    );
    await audit.record(
      selfContext({ kind: 'tenant', tenant }, user.toObject() as Principal, meta),
      {
        action: record.type === 'invite' ? 'auth.invite_accepted' : 'auth.password_reset',
      },
    );
  }

  async function changePassword(
    scope: AuthScope,
    userId: string,
    currentSessionId: string,
    currentPassword: string,
    newPassword: string,
  ) {
    const model = scope.kind === 'tenant' ? User : PlatformAdmin;
    const doc = await (model as typeof User).findOne({ _id: userId }).select('+passwordHash');
    if (!doc || !doc.get('passwordHash')) throw Errors.forbidden('This account has no password');
    if (!(await verifyPassword(currentPassword, doc.get('passwordHash') as string))) {
      throw Errors.invalidCredentials();
    }
    await (model as typeof User).updateOne(
      { _id: doc._id },
      { $set: { passwordHash: await hashPassword(newPassword), passwordChangedAt: new Date() } },
    );
    // Sign out every other device; keep the one making the change.
    await revokeUserSessions(scope, doc._id, 'password_changed', currentSessionId);
  }

  // ---------------------------------------------------------------- refresh / logout

  async function refresh(
    scope: AuthScope,
    refreshToken: string,
    meta: ClientMeta,
  ): Promise<IssuedSession> {
    if (!isWellFormedToken(refreshToken)) throw Errors.invalidRefresh();
    const Model = sessionModel(scope);
    const presented = hashToken(refreshToken);
    const now = new Date();
    const nextToken = randomToken();

    const session = await Model.findOneAndUpdate(
      { refreshTokenHash: presented, revokedAt: null, expiresAt: { $gt: now } },
      {
        $set: {
          refreshTokenHash: hashToken(nextToken),
          rotatedAt: now,
          lastUsedAt: now,
          ip: clip(meta.ip, 64),
          userAgent: clip(meta.userAgent, 300),
        },
        $push: { previousRefreshHashes: { $each: [presented], $slice: -5 } },
      },
      { returnDocument: 'after' },
    );

    if (!session) {
      const stale = await Model.findOne({ previousRefreshHashes: presented });
      if (stale && !stale.revokedAt) {
        const sinceRotation = stale.rotatedAt
          ? now.getTime() - stale.rotatedAt.getTime()
          : Infinity;
        if (sinceRotation < REFRESH_RACE_GRACE_MS) throw Errors.refreshRace();
        // An old refresh token came back after rotation: it was copied. Kill the session.
        await Model.updateOne(
          { _id: stale._id },
          { $set: { revokedAt: now, revokedReason: 'token_reuse' } },
        );
        logger.warn(
          { sessionId: String(stale._id), scope: scope.kind },
          'Refresh token reuse: session revoked',
        );
      }
      throw Errors.invalidRefresh();
    }

    const principal = await loadActivePrincipal(scope, session.userId);
    if (!principal) {
      await Model.updateOne(
        { _id: session._id },
        { $set: { revokedAt: now, revokedReason: 'user_disabled' } },
      );
      throw Errors.invalidRefresh();
    }
    const sid = String(session._id);
    return {
      accessToken: await accessTokenFor(scope, principal, sid),
      expiresIn: env.ACCESS_TOKEN_TTL_SEC,
      refreshToken: nextToken,
      refreshExpiresAt: session.expiresAt,
      sessionId: sid,
      user: publicPrincipal(scope, principal),
    };
  }

  /**
   * Who holds this refresh cookie, without using it: no rotation, no side effects. Lets the web
   * server decide whether to render an owner-only or platform page before any data is fetched.
   * A token rotated moments ago (another tab refreshed while this page loaded) still counts.
   */
  async function sessionRole(
    scope: AuthScope,
    refreshToken: string,
  ): Promise<{ scope: AuthScope['kind']; role: TenantRole | 'super_admin' } | null> {
    if (!isWellFormedToken(refreshToken)) return null;
    const presented = hashToken(refreshToken);
    const now = new Date();
    const live = { revokedAt: null, expiresAt: { $gt: now } };
    const Model = sessionModel(scope);
    const session =
      (await Model.findOne({ ...live, refreshTokenHash: presented }).lean()) ??
      (await Model.findOne({
        ...live,
        previousRefreshHashes: presented,
        rotatedAt: { $gt: new Date(now.getTime() - REFRESH_RACE_GRACE_MS) },
      }).lean());
    if (!session) return null;
    const principal = await loadActivePrincipal(scope, session.userId);
    if (!principal) return null;
    return scope.kind === 'tenant'
      ? { scope: 'tenant', role: principal.role as TenantRole }
      : { scope: 'platform', role: 'super_admin' };
  }

  /** Logout by refresh cookie (works even with an expired access token). Idempotent. */
  /**
   * Ends the session the refresh token belongs to. With `everywhere`, a live, non-impersonated session also
   * ends every other session of its user: the member app's sign-out that was tapped offline completes with
   * this call alone, without first signing in again (the token already proves the session). Returns the
   * user whose sessions all ended, for the audit log; null otherwise.
   */
  async function logoutByRefreshToken(
    scope: AuthScope,
    refreshToken: string,
    opts: { everywhere?: boolean } = {},
  ): Promise<{ userId: string } | null> {
    if (!isWellFormedToken(refreshToken)) return null;
    const session = await sessionModel(scope)
      .findOneAndUpdate(
        { refreshTokenHash: hashToken(refreshToken), revokedAt: null },
        { $set: { revokedAt: new Date(), revokedReason: 'logout' } },
      )
      .lean<{ userId: Types.ObjectId; expiresAt: Date; impersonatorId?: Types.ObjectId | null }>();
    if (!opts.everywhere || !session || session.impersonatorId || session.expiresAt <= new Date()) {
      return null;
    }
    await revokeUserSessions(scope, session.userId, 'logout_all');
    return { userId: String(session.userId) };
  }

  async function logoutSession(scope: AuthScope, userId: string, sessionId: string) {
    const res = await sessionModel(scope).updateOne(
      { _id: sessionId, userId, revokedAt: null }, // userId: you can only end your own sessions
      { $set: { revokedAt: new Date(), revokedReason: 'logout' } },
    );
    return res.matchedCount > 0;
  }

  async function listSessions(scope: AuthScope, userId: string, currentSessionId: string) {
    const rows = await sessionModel(scope)
      .find({ userId, revokedAt: null, expiresAt: { $gt: new Date() } })
      .sort({ lastUsedAt: -1 })
      .limit(50)
      .lean();
    return rows.map((s) => ({
      id: String(s._id),
      current: String(s._id) === currentSessionId,
      /** A super admin's "log in as owner" session; the owner can end it here. */
      impersonated: Boolean(s.impersonatorId),
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt ?? s.createdAt,
      userAgent: s.userAgent ?? null,
      ip: s.ip ?? null,
    }));
  }

  // ---------------------------------------------------------------- "log in as owner"

  /**
   * Issues a short-lived owner session for a super admin. Must run inside the gym's tenant scope.
   *
   * Only an access token is returned: the session's refresh hash is random and never revealed, so
   * the session can't be extended and ends when the access token expires (ACCESS_TOKEN_TTL_SEC).
   * The token carries `imp` and only works while that super admin is still active.
   */
  async function startImpersonation(tenant: ResolvedTenant, adminId: string, meta: ClientMeta) {
    const owner = await User.findOne({ role: 'owner', status: 'active', archivedAt: null })
      .sort({ createdAt: 1 })
      .lean<Principal>();
    if (!owner) throw Errors.conflict('This gym has no active owner to sign in as');

    const expiresAt = new Date(Date.now() + env.ACCESS_TOKEN_TTL_SEC * 1000);
    const session = await Session.create({
      userId: owner._id,
      refreshTokenHash: hashToken(randomToken()),
      expiresAt,
      lastUsedAt: new Date(),
      impersonatorId: adminId,
      ip: clip(meta.ip, 64),
      userAgent: clip(meta.userAgent, 300),
    });
    const sid = String(session._id);
    const accessToken = await signAccessToken(jwt, {
      typ: 'tenant',
      sub: String(owner._id),
      sid,
      tid: tenant.id.toHexString(),
      role: 'owner',
      imp: adminId,
    });
    return {
      accessToken,
      tokenType: 'Bearer' as const,
      expiresIn: env.ACCESS_TOKEN_TTL_SEC,
      expiresAt,
      sessionId: sid,
      user: publicPrincipal({ kind: 'tenant', tenant }, owner),
    };
  }

  /** Ends the caller's own impersonation session (gym host). */
  async function endImpersonation(sessionId: string) {
    await Session.updateOne(
      { _id: sessionId, impersonatorId: { $ne: null }, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedReason: 'impersonation_end' } },
    );
  }

  async function me(scope: AuthScope, userId: string) {
    const p = await loadActivePrincipal(scope, userId);
    if (!p) throw Errors.unauthorized();
    return publicPrincipal(scope, p);
  }

  return {
    loginWithPassword,
    requestMagicLink,
    verifyMagicLink,
    requestPasswordReset,
    resetPassword,
    sendInvite,
    changePassword,
    refresh,
    sessionRole,
    logoutByRefreshToken,
    logoutSession,
    logoutAll: (scope: AuthScope, userId: string) =>
      revokeUserSessions(scope, userId, 'logout_all'),
    revokeUserSessions,
    listSessions,
    startImpersonation,
    endImpersonation,
    me,
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
