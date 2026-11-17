import { Types } from 'mongoose';
import { effectivePermissions } from '../../auth/permissions.js';
import { Errors } from '../../lib/errors.js';
import { escapeRegex, pageMeta, skipFor } from '../../lib/pagination.js';
import type { ResolvedTenant } from '../../tenancy/resolver.middleware.js';
import { diffChanges, type AuditContext, type AuditService } from '../audit/audit.service.js';
import type { AuthService, ClientMeta } from '../auth/auth.service.js';
import { Session } from '../auth/session.model.js';
import { User } from '../users/user.model.js';
import type { CreateStaffInput, StaffListQuery, UpdateStaffInput } from './staff.schemas.js';

const FIELDS = 'name email phone role status permissions lastLoginAt createdAt updatedAt';

type StaffRow = {
  _id: Types.ObjectId;
  name: string;
  email?: string | null;
  phone?: string | null;
  role: string;
  status?: string | null;
  permissions?: string[];
  lastLoginAt?: Date | null;
  createdAt?: Date;
};

function toView(u: StaffRow) {
  return {
    id: String(u._id),
    name: u.name,
    email: u.email ?? null,
    phone: u.phone ?? null,
    role: u.role,
    status: u.status ?? 'active',
    /** Extra grants set by the owner (staff only). */
    grants: u.role === 'staff' ? (u.permissions ?? []) : [],
    /** Everything this person can do, for showing the effective access in the team screen. */
    permissions: [...effectivePermissions(u.role as 'owner' | 'staff', u.permissions ?? [])],
    lastLoginAt: u.lastLoginAt ?? null,
    createdAt: u.createdAt ?? null,
  };
}
export type StaffView = ReturnType<typeof toView>;

/**
 * The gym's team. Runs inside the host gym's tenant scope, so every query is already limited to
 * this gym; ids from the path are additionally pinned to role=staff so an owner (or a member)
 * can never be edited through these endpoints.
 */
export function createStaffService(deps: { auth: AuthService; audit: AuditService }) {
  const { auth, audit } = deps;

  async function loadStaff(id: string) {
    const u = await User.findOne({ _id: id, role: 'staff', archivedAt: null })
      .select(FIELDS)
      .lean<StaffRow>();
    if (!u) throw Errors.notFound('Staff member');
    return u;
  }

  async function list(q: StaffListQuery) {
    const filter: Record<string, unknown> = {
      role: q.role ?? { $in: ['owner', 'staff'] },
      archivedAt: null,
    };
    if (q.status) filter.status = q.status;
    if (q.q) {
      const rx = new RegExp(escapeRegex(q.q), 'i');
      filter.$or = [{ name: rx }, { email: rx }, { phone: rx }];
    }
    const [rows, total] = await Promise.all([
      User.find(filter)
        .select(FIELDS)
        .sort({ role: 1, name: 1, _id: 1 })
        .skip(skipFor(q))
        .limit(q.limit)
        .lean<StaffRow[]>(),
      User.countDocuments(filter),
    ]);
    return { items: rows.map(toView), meta: pageMeta(q, total) };
  }

  async function get(id: string) {
    // Owners are visible in the team view but not editable here.
    const u = await User.findOne({ _id: id, role: { $in: ['owner', 'staff'] }, archivedAt: null })
      .select(FIELDS)
      .lean<StaffRow>();
    if (!u) throw Errors.notFound('Staff member');
    return toView(u);
  }

  async function create(
    tenant: ResolvedTenant,
    input: CreateStaffInput,
    ctx: AuditContext,
    meta: ClientMeta,
  ) {
    const id = new Types.ObjectId();
    await User.create({
      _id: id,
      name: input.name,
      email: input.email,
      phone: input.phone,
      role: 'staff',
      status: 'invited',
      permissions: input.permissions,
    });
    await audit.record(ctx, {
      action: 'staff.create',
      target: { type: 'user', id: String(id) },
      metadata: { grants: input.permissions },
    });
    const invite = await auth.sendInvite(tenant, id, meta);
    return {
      staff: toView(await loadStaff(String(id))),
      inviteSent: invite.sent,
      inviteError: invite.sent ? null : invite.reason,
    };
  }

  async function update(id: string, input: UpdateStaffInput, ctx: AuditContext) {
    const before = await loadStaff(id);
    const set: Record<string, unknown> = {};
    const unset: Record<string, 1> = {};
    for (const [k, v] of Object.entries(input)) {
      if (v === undefined) continue;
      if (v === null) unset[k] = 1;
      else set[k] = v;
    }
    if (input.phone === null && !(input.email ?? before.email)) {
      throw Errors.validation([{ path: 'phone', message: 'Staff need an email or phone' }]);
    }
    const after = await User.findOneAndUpdate(
      { _id: id, role: 'staff', archivedAt: null },
      {
        ...(Object.keys(set).length ? { $set: set } : {}),
        ...(Object.keys(unset).length ? { $unset: unset } : {}),
      },
      { returnDocument: 'after', runValidators: true },
    )
      .select(FIELDS)
      .lean<StaffRow>();
    if (!after) throw Errors.notFound('Staff member');
    const changes = diffChanges(
      before,
      after,
      Object.keys(input).filter((k) => k in set || k in unset),
    );
    if (changes.length) {
      await audit.record(ctx, {
        action: changes.some((c) => c.field === 'permissions')
          ? 'staff.permissions_update'
          : 'staff.update',
        target: { type: 'user', id },
        changes,
      });
    }
    return toView(after);
  }

  /** Immediate: authenticate() re-reads status on every request, and all sessions are ended too. */
  async function deactivate(id: string, ctx: AuditContext) {
    const u = await loadStaff(id);
    if (u.status === 'disabled') throw Errors.conflict('Staff member is already deactivated');
    await User.updateOne({ _id: id, role: 'staff' }, { $set: { status: 'disabled' } });
    const ended = await Session.updateMany(
      { userId: id, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedReason: 'user_disabled' } },
    );
    await audit.record(ctx, {
      action: 'staff.deactivate',
      target: { type: 'user', id },
      metadata: { sessionsEnded: ended.modifiedCount },
    });
    return toView(await loadStaff(id));
  }

  /** Back to `active` if they had set a password, otherwise back to `invited`. */
  async function activate(id: string, ctx: AuditContext) {
    const u = await loadStaff(id);
    if (u.status !== 'disabled') throw Errors.conflict('Staff member is not deactivated');
    const hasPassword = await User.exists({ _id: id, passwordHash: { $type: 'string' } });
    await User.updateOne(
      { _id: id, role: 'staff' },
      { $set: { status: hasPassword ? 'active' : 'invited' }, $unset: { lockedUntil: 1 } },
    );
    await audit.record(ctx, { action: 'staff.activate', target: { type: 'user', id } });
    return toView(await loadStaff(id));
  }

  async function resendInvite(
    tenant: ResolvedTenant,
    id: string,
    ctx: AuditContext,
    meta: ClientMeta,
  ) {
    const u = await loadStaff(id);
    if (u.status !== 'invited')
      throw Errors.conflict('Staff member has already accepted the invite');
    const invite = await auth.sendInvite(tenant, u._id, meta);
    if (invite.sent) {
      await audit.record(ctx, { action: 'staff.invite', target: { type: 'user', id } });
    }
    return { sent: invite.sent, reason: invite.sent ? null : invite.reason };
  }

  return { list, get, create, update, deactivate, activate, resendInvite };
}

export type StaffService = ReturnType<typeof createStaffService>;
