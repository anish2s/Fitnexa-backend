import mongoose, { Types } from 'mongoose';
import type { Env } from '../../config/env.js';
import { Errors } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import { escapeRegex, pageMeta, skipFor, type PageQuery } from '../../lib/pagination.js';
import { runInTenant } from '../../tenancy/context.js';
import type { ResolvedTenant } from '../../tenancy/resolver.middleware.js';
import type { AuditContext, AuditService } from '../audit/audit.service.js';
import type { AuthService, ClientMeta } from '../auth/auth.service.js';
import { SUBDOMAIN_PATTERN, Tenant, type TenantAttrs } from '../tenants/tenant.model.js';
import { getTenantView, patchTenant, toTenantView } from '../tenants/tenant.service.js';
import { User } from '../users/user.model.js';
import type { CreateTenantInput } from './platform.schemas.js';

type LeanTenant = TenantAttrs & { _id: Types.ObjectId; createdAt?: Date };

export type SlugProblem = 'invalid' | 'reserved' | 'taken';

/** Removes nulls (meaning "clear") from create input, where there is nothing to clear yet. */
function dropNulls<T>(obj: T): T {
  if (!obj || typeof obj !== 'object' || obj instanceof Date) return obj;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (v === null || v === undefined) continue;
    out[k] = dropNulls(v);
  }
  return out as T;
}

function toResolved(t: LeanTenant): ResolvedTenant {
  return {
    id: t._id,
    slug: t.slug,
    name: t.name,
    status: t.status as ResolvedTenant['status'],
    branding: (t.branding ?? {}) as Record<string, unknown>,
  };
}

/**
 * Super admin operations on gyms. Runs on the platform host, where there is NO tenant scope: every
 * touch of gym-owned data (users, sessions, audit log) goes through an explicit runInTenant(gymId).
 */
export function createPlatformService(deps: {
  env: Env;
  auth: AuthService;
  audit: AuditService;
  logger: Logger;
}) {
  const { env, auth, audit } = deps;
  const appUrl = (slug: string) => env.GYM_APP_URL_TEMPLATE.replace('{slug}', slug);

  async function loadTenant(id: string): Promise<LeanTenant> {
    const t = await Tenant.findById(id).lean<LeanTenant>();
    if (!t) throw Errors.notFound('Gym');
    return t;
  }

  /** Format, then reserved names (www, admin, api…), then existing gyms (archived ones too). */
  async function slugProblem(slug: string): Promise<SlugProblem | null> {
    // "--" is excluded too: it blocks punycode (xn--) look-alike subdomains.
    if (!SUBDOMAIN_PATTERN.test(slug) || slug.includes('--')) return 'invalid';
    if (env.RESERVED_SUBDOMAINS.includes(slug)) return 'reserved';
    if (await Tenant.exists({ slug })) return 'taken';
    return null;
  }

  async function slugAvailability(slug: string) {
    const problem = await slugProblem(slug);
    return { slug, available: problem === null, reason: problem };
  }

  async function listTenants(q: PageQuery & { q?: string; status?: string }) {
    const filter: Record<string, unknown> = {};
    if (q.status) filter.status = q.status;
    if (q.q) {
      const rx = new RegExp(escapeRegex(q.q), 'i');
      filter.$or = [{ name: rx }, { slug: rx }];
    }
    const [rows, total] = await Promise.all([
      Tenant.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip(skipFor(q))
        .limit(q.limit)
        .lean<LeanTenant[]>(),
      Tenant.countDocuments(filter),
    ]);
    const items = rows.map((t) => ({
      id: String(t._id),
      name: t.name,
      slug: t.slug,
      status: t.status,
      city: t.address?.city ?? null,
      subscriptionStatus: t.subscription?.status ?? 'trialing',
      createdAt: t.createdAt ?? null,
    }));
    return { items, meta: pageMeta(q, total) };
  }

  async function getTenant(id: string) {
    const tenant = await getTenantView(id);
    const { owners, counts } = await runInTenant(id, async () => {
      const [owners, grouped] = await Promise.all([
        User.find({ role: 'owner', archivedAt: null })
          .select('name email phone status lastLoginAt createdAt')
          .sort({ createdAt: 1 })
          .lean(),
        User.aggregate<{ _id: string; n: number }>([
          { $match: { archivedAt: null } },
          { $group: { _id: '$role', n: { $sum: 1 } } },
        ]),
      ]);
      const counts = { owner: 0, staff: 0, member: 0 };
      for (const g of grouped) if (g._id in counts) counts[g._id as keyof typeof counts] = g.n;
      return { owners, counts };
    });
    return {
      tenant,
      appUrl: appUrl(tenant.slug),
      owners: owners.map((o) => ({
        id: String(o._id),
        name: o.name,
        email: o.email ?? null,
        phone: o.phone ?? null,
        status: o.status,
        lastLoginAt: o.lastLoginAt ?? null,
      })),
      userCounts: counts,
    };
  }

  /**
   * Creates the gym and its owner (status `invited`, no password) in one transaction, then emails
   * the owner a set-password invite. The email is sent after commit: if it fails the gym still
   * exists and the invite can be resent.
   */
  async function createTenant(input: CreateTenantInput, ctx: AuditContext, meta: ClientMeta) {
    const problem = await slugProblem(input.slug);
    if (problem) {
      throw Errors.conflict(
        problem === 'invalid'
          ? 'Subdomain must be 3–40 lowercase letters, digits or single hyphens'
          : 'That subdomain is not available',
        { field: 'slug', reason: problem },
      );
    }

    const tenantId = new Types.ObjectId();
    const ownerId = new Types.ObjectId();
    const owner = dropNulls(input.owner);
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await Tenant.create(
          [
            {
              _id: tenantId,
              name: input.name,
              slug: input.slug,
              email: input.email ?? owner.email,
              phone: input.phone ?? owner.phone,
              address: { ...dropNulls(input.address ?? {}), country: 'IN' },
              settings: dropNulls(input.settings ?? {}),
              branding: dropNulls(input.branding ?? {}),
              subscription: dropNulls(input.subscription ?? {}),
            },
          ],
          { session },
        );
        await runInTenant(tenantId, () =>
          User.create(
            [{ _id: ownerId, ...owner, role: 'owner' as const, status: 'invited' as const }],
            { session },
          ),
        );
      });
    } finally {
      await session.endSession();
    }

    const created = await loadTenant(String(tenantId));
    await audit.record(
      ctx,
      {
        action: 'tenant.create',
        target: { type: 'tenant', id: String(tenantId) },
        metadata: { slug: created.slug, name: created.name, ownerId: String(ownerId) },
      },
      { tenantId },
    );
    const invite = await runInTenant(tenantId, () =>
      auth.sendInvite(toResolved(created), ownerId, meta),
    );
    return {
      tenant: toTenantView(created),
      appUrl: appUrl(created.slug),
      owner: { id: String(ownerId), name: owner.name, email: owner.email, status: 'invited' },
      inviteSent: invite.sent,
      /** Set when the invite wasn't sent; resend it from the console. */
      inviteError: invite.sent ? null : invite.reason,
    };
  }

  async function updateTenant(
    id: string,
    patch: Record<string, unknown>,
    ctx: AuditContext,
    kind: 'profile' | 'branding',
  ) {
    await loadTenant(id);
    const { tenant, changes } = await patchTenant(
      id,
      kind === 'branding' ? { branding: patch } : patch,
    );
    if (changes.length) {
      await audit.record(
        ctx,
        {
          action: kind === 'branding' ? 'tenant.branding_update' : 'tenant.update',
          target: { type: 'tenant', id },
          changes,
        },
        { tenantId: id },
      );
    }
    return tenant;
  }

  /**
   * Suspension takes effect on the gym's very next request: the tenant is re-read from the DB on
   * every request (no cache), and authentication refuses suspended gyms. Sessions are kept, so
   * reactivating restores access without forcing everyone to sign in again.
   */
  async function suspend(id: string, reason: string, ctx: AuditContext) {
    const t = await loadTenant(id);
    if (t.status !== 'active') throw Errors.conflict(`Gym is ${t.status}, not active`);
    const updated = await Tenant.findOneAndUpdate(
      { _id: id, status: 'active' },
      { $set: { status: 'suspended', suspendedAt: new Date(), suspendedReason: reason } },
      { returnDocument: 'after' },
    ).lean<LeanTenant>();
    if (!updated) throw Errors.conflict('Gym status changed, try again');
    await audit.record(
      ctx,
      { action: 'tenant.suspend', target: { type: 'tenant', id }, metadata: { reason } },
      { tenantId: id },
    );
    return toTenantView(updated);
  }

  async function activate(id: string, ctx: AuditContext) {
    const t = await loadTenant(id);
    if (t.status !== 'suspended') throw Errors.conflict(`Gym is ${t.status}, not suspended`);
    const updated = await Tenant.findOneAndUpdate(
      { _id: id, status: 'suspended' },
      { $set: { status: 'active' }, $unset: { suspendedAt: 1, suspendedReason: 1 } },
      { returnDocument: 'after' },
    ).lean<LeanTenant>();
    if (!updated) throw Errors.conflict('Gym status changed, try again');
    await audit.record(
      ctx,
      {
        action: 'tenant.activate',
        target: { type: 'tenant', id },
        metadata: { previousReason: t.suspendedReason ?? null },
      },
      { tenantId: id },
    );
    return toTenantView(updated);
  }

  /** Re-sends the set-password invite to an owner who hasn't accepted it yet. */
  async function resendOwnerInvite(id: string, ctx: AuditContext, meta: ClientMeta) {
    const t = await loadTenant(id);
    return runInTenant(t._id, async () => {
      const owner = await User.findOne({ role: 'owner', status: 'invited', archivedAt: null })
        .sort({ createdAt: 1 })
        .lean();
      if (!owner) throw Errors.conflict('No owner is waiting for an invite');
      const invite = await auth.sendInvite(toResolved(t), owner._id, meta);
      if (invite.sent) {
        await audit.record(ctx, {
          action: 'tenant.owner_invite',
          target: { type: 'user', id: String(owner._id) },
        });
      }
      return {
        sent: invite.sent,
        ownerId: String(owner._id),
        reason: invite.sent ? null : invite.reason,
      };
    });
  }

  /**
   * "Log in as owner". Writes the audit entry as part of the action: if it can't be recorded, the
   * session is revoked and the request fails, so there is never an unaudited impersonation.
   */
  async function impersonate(id: string, reason: string, ctx: AuditContext, meta: ClientMeta) {
    const t = await loadTenant(id);
    if (t.status !== 'active') throw Errors.conflict(`Gym is ${t.status}; activate it first`);
    const adminId = ctx.actor.id!;
    return runInTenant(t._id, async () => {
      const issued = await auth.startImpersonation(toResolved(t), adminId, meta);
      try {
        await audit.record(
          ctx,
          {
            action: 'impersonation.start',
            target: { type: 'user', id: issued.user.id },
            metadata: {
              reason,
              sessionId: issued.sessionId,
              expiresAt: issued.expiresAt.toISOString(),
            },
          },
          { required: true },
        );
      } catch (err) {
        await auth.endImpersonation(issued.sessionId);
        throw err;
      }
      return {
        accessToken: issued.accessToken,
        tokenType: issued.tokenType,
        expiresIn: issued.expiresIn,
        expiresAt: issued.expiresAt,
        user: issued.user,
        gym: { id: String(t._id), slug: t.slug, name: t.name },
        appUrl: appUrl(t.slug),
      };
    });
  }

  async function ensureExists(id: string) {
    if (!(await Tenant.exists({ _id: id }))) throw Errors.notFound('Gym');
    return new Types.ObjectId(id);
  }

  return {
    slugAvailability,
    listTenants,
    getTenant,
    createTenant,
    updateTenant,
    suspend,
    activate,
    resendOwnerInvite,
    impersonate,
    ensureExists,
  };
}

export type PlatformService = ReturnType<typeof createPlatformService>;
