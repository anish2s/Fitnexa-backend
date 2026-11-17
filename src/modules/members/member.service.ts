import mongoose, { Types, type ClientSession } from 'mongoose';
import { Errors } from '../../lib/errors.js';
import type { ImageStore } from '../../lib/image-store.js';
import { formatDateOnly, parseDateOnly, todayIn } from '../../lib/dates.js';
import { escapeRegex, pageMeta, skipFor } from '../../lib/pagination.js';
import { requireTenantId } from '../../tenancy/context.js';
import { diffChanges, type AuditContext, type AuditService } from '../audit/audit.service.js';
import { Session } from '../auth/session.model.js';
import { nextSequence } from '../counters/counter.model.js';
import { Tenant } from '../tenants/tenant.model.js';
import { User } from '../users/user.model.js';
import { MEMBER_CONSENT_VERSION, Member } from './member.model.js';
import type {
  CreateMemberInput,
  MemberListQuery,
  SelfUpdateInput,
  UpdateMemberInput,
} from './member.schemas.js';

/** Member names and emergency contacts are personal; the audit log records only that they changed. */
const MASK = ['name', 'emergencyContact.name', 'emergencyContact.relation'];
const EDITABLE = [
  'name',
  'phone',
  'email',
  'gender',
  'dateOfBirth',
  'joinDate',
  'emergencyContact',
  'notes',
] as const;

type LeanMember = {
  _id: Types.ObjectId;
  memberCode: string;
  name: string;
  phone: string;
  email?: string | null;
  gender?: string | null;
  dateOfBirth?: Date | null;
  joinDate: Date;
  emergencyContact?: { name?: string; phone?: string; relation?: string } | null;
  notes?: string | null;
  photoUrl?: string | null;
  photoPublicId?: string | null;
  consent?: { at: Date; version: string } | null;
  userId?: Types.ObjectId | null;
  archivedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
};

export const formatMemberCode = (n: number) => `M${String(n).padStart(4, '0')}`;

const hasApp = (m: LeanMember) => Boolean(m.userId && m.email && !m.archivedAt);

function toListItem(m: LeanMember) {
  return {
    id: String(m._id),
    memberCode: m.memberCode,
    name: m.name,
    phone: m.phone,
    email: m.email ?? null,
    photoUrl: m.photoUrl ?? null,
    joinDate: formatDateOnly(m.joinDate),
    appAccess: hasApp(m),
    archivedAt: m.archivedAt ?? null,
  };
}

function emergencyView(e: LeanMember['emergencyContact']) {
  return e?.name ? { name: e.name, phone: e.phone ?? null, relation: e.relation ?? null } : null;
}

/** What the member sees about themselves (no staff notes, no internal ids). */
function toSelfView(m: LeanMember) {
  return {
    memberCode: m.memberCode,
    name: m.name,
    phone: m.phone,
    email: m.email ?? null,
    gender: m.gender ?? null,
    dateOfBirth: formatDateOnly(m.dateOfBirth),
    joinDate: formatDateOnly(m.joinDate),
    emergencyContact: emergencyView(m.emergencyContact),
    photoUrl: m.photoUrl ?? null,
  };
}

/**
 * Members of the host gym. Every query runs in the request's tenant scope. The linked login
 * (`users`, role member) is kept in step with the member record inside the same transaction.
 */
export function createMemberService(deps: { audit: AuditService; images: ImageStore | null }) {
  const { audit, images } = deps;

  async function gymToday(): Promise<Date> {
    const t = await Tenant.findById(requireTenantId()).select('settings.timezone').lean();
    return parseDateOnly(todayIn(t?.settings?.timezone ?? 'Asia/Kolkata'))!;
  }

  async function load(id: string): Promise<LeanMember> {
    const m = await Member.findById(id).lean<LeanMember>();
    if (!m) throw Errors.notFound('Member');
    return m;
  }

  async function toDetail(m: LeanMember) {
    const login = m.userId
      ? await User.findOne({ _id: m.userId, role: 'member' }).select('status lastLoginAt').lean()
      : null;
    return {
      id: String(m._id),
      ...toSelfView(m),
      notes: m.notes ?? null,
      consent: m.consent ? { at: m.consent.at, version: m.consent.version } : null,
      appAccess: {
        enabled: hasApp(m) && login?.status === 'active',
        /** Why not, for the front desk: no email on file, or the member is archived. */
        reason: !m.email ? 'no_email' : m.archivedAt ? 'archived' : null,
        lastLoginAt: login?.lastLoginAt ?? null,
      },
      archivedAt: m.archivedAt ?? null,
      createdAt: m.createdAt ?? null,
      updatedAt: m.updatedAt ?? null,
    };
  }

  /**
   * Makes the member's login match the member record: a login exists and is active exactly when
   * the member has an email and isn't archived. Losing access ends every session at once.
   */
  async function syncLogin(m: LeanMember, session: ClientSession) {
    const usable = Boolean(m.email) && !m.archivedAt;
    if (!m.userId) {
      if (!usable) return;
      const userId = new Types.ObjectId();
      await User.create(
        [{ _id: userId, name: m.name, email: m.email, role: 'member', memberId: m._id }],
        { session },
      );
      await Member.updateOne({ _id: m._id }, { $set: { userId } }, { session });
      // Callers build the response from `m`; keep it in step with what was just written.
      m.userId = userId;
      return;
    }
    const update: Record<string, unknown> = {
      $set: {
        name: m.name,
        status: usable ? 'active' : 'disabled',
        ...(m.email ? { email: m.email } : {}),
      },
      ...(m.email ? {} : { $unset: { email: 1 } }),
    };
    await User.updateOne({ _id: m.userId, role: 'member' }, update, { session });
    if (!usable) {
      await Session.updateMany(
        { userId: m.userId, revokedAt: null },
        { $set: { revokedAt: new Date(), revokedReason: 'user_disabled' } },
        { session },
      );
    }
  }

  async function inTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = await mongoose.startSession();
    try {
      let result: T;
      await session.withTransaction(async () => {
        result = await fn(session);
      });
      return result!;
    } finally {
      await session.endSession();
    }
  }

  async function list(q: MemberListQuery) {
    const filter: Record<string, unknown> = { archivedAt: q.archived ? { $ne: null } : null };
    if (q.joinedFrom || q.joinedTo) {
      filter.joinDate = {
        ...(q.joinedFrom ? { $gte: q.joinedFrom } : {}),
        ...(q.joinedTo ? { $lte: q.joinedTo } : {}),
      };
    }
    if (q.q) {
      const rx = new RegExp(escapeRegex(q.q), 'i');
      const or: Record<string, unknown>[] = [
        { name: rx },
        { email: rx },
        { memberCode: new RegExp(`^${escapeRegex(q.q)}`, 'i') },
      ];
      const digits = q.q.replace(/\D/g, '');
      if (digits.length >= 3) or.push({ phone: new RegExp(digits) });
      filter.$or = or;
    }
    const sort: Record<string, 1 | -1> = {
      '-joinDate': { joinDate: -1 as const, _id: -1 as const },
      joinDate: { joinDate: 1 as const, _id: 1 as const },
      name: { name: 1 as const, _id: 1 as const },
      memberCode: { memberCode: 1 as const },
    }[q.sort];
    const [rows, total] = await Promise.all([
      Member.find(filter)
        .select('memberCode name phone email photoUrl joinDate userId archivedAt')
        .sort(sort)
        .skip(skipFor(q))
        .limit(q.limit)
        .lean<LeanMember[]>(),
      Member.countDocuments(filter),
    ]);
    return { items: rows.map(toListItem), meta: pageMeta(q, total) };
  }

  async function get(id: string) {
    return toDetail(await load(id));
  }

  async function create(input: CreateMemberInput, ctx: AuditContext) {
    const memberId = new Types.ObjectId();
    const joinDate = input.joinDate ?? (await gymToday());
    const created = await inTransaction(async (session) => {
      const seq = await nextSequence('memberCode', session);
      const [doc] = await Member.create(
        [
          {
            _id: memberId,
            memberCode: formatMemberCode(seq),
            name: input.name,
            phone: input.phone,
            email: input.email,
            gender: input.gender,
            dateOfBirth: input.dateOfBirth,
            joinDate,
            emergencyContact: input.emergencyContact,
            notes: input.notes,
            consent: {
              at: new Date(),
              version: MEMBER_CONSENT_VERSION,
              recordedBy: ctx.actor.id ? new Types.ObjectId(ctx.actor.id) : undefined,
            },
          },
        ],
        { session },
      );
      const lean = doc!.toObject() as unknown as LeanMember;
      await syncLogin(lean, session);
      return lean;
    });
    await audit.record(ctx, {
      action: 'member.create',
      target: { type: 'member', id: String(memberId) },
      metadata: { memberCode: created.memberCode, appAccess: Boolean(input.email) },
    });
    return get(String(memberId));
  }

  /** Builds $set/$unset from a validated patch; sub-objects are replaced whole. */
  function toUpdate(input: Record<string, unknown>) {
    const set: Record<string, unknown> = {};
    const unset: Record<string, 1> = {};
    for (const [k, v] of Object.entries(input)) {
      if (v === undefined) continue;
      if (v === null) unset[k] = 1;
      else set[k] = v;
    }
    const update = {
      ...(Object.keys(set).length ? { $set: set } : {}),
      ...(Object.keys(unset).length ? { $unset: unset } : {}),
    };
    return { update, touched: [...Object.keys(set), ...Object.keys(unset)] };
  }

  /** Paths to compare for the audit log; emergencyContact is diffed field by field. */
  const diffPaths = (touched: string[]) =>
    touched.flatMap((k) =>
      k === 'emergencyContact'
        ? ['emergencyContact.name', 'emergencyContact.phone', 'emergencyContact.relation']
        : [k],
    );

  async function applyPatch(
    filter: Record<string, unknown>,
    input: Record<string, unknown>,
    ctx: AuditContext,
    action: 'member.update' | 'member.self_update',
  ) {
    const before = await Member.findOne(filter).lean<LeanMember>();
    if (!before) throw Errors.notFound('Member');
    if (before.archivedAt) throw Errors.conflict('Member is archived; restore them first');
    const { update, touched } = toUpdate(input);
    const after = await inTransaction(async (session) => {
      const m = await Member.findOneAndUpdate({ _id: before._id }, update, {
        returnDocument: 'after',
        runValidators: true,
        session,
      }).lean<LeanMember>();
      if (!m) throw Errors.notFound('Member');
      if (touched.includes('email') || touched.includes('name')) await syncLogin(m, session);
      return m;
    });
    const changes = diffChanges(before, after, diffPaths(touched), MASK);
    if (changes.length) {
      await audit.record(ctx, {
        action,
        target: { type: 'member', id: String(before._id) },
        changes,
      });
    }
    return after;
  }

  async function update(id: string, input: UpdateMemberInput, ctx: AuditContext) {
    const picked = Object.fromEntries(EDITABLE.map((k) => [k, input[k]]));
    return toDetail(await applyPatch({ _id: id }, picked, ctx, 'member.update'));
  }

  /**
   * Sets (publicId) or removes (null) the member's photo. Only ids under this gym's folder for this
   * member are accepted: those are the only paths /uploads/signature will sign for them.
   */
  async function setPhoto(id: string, publicId: string | null, ctx: AuditContext) {
    if (!images) throw Errors.uploadsNotConfigured();
    const before = await load(id);
    if (before.archivedAt) throw Errors.conflict('Member is archived; restore them first');
    if (publicId !== null) {
      const prefix = `${images.gymPrefix(requireTenantId().toHexString())}/members/${id}/`;
      if (
        !publicId.startsWith(prefix) ||
        !/^[A-Za-z0-9]{16}$/.test(publicId.slice(prefix.length))
      ) {
        throw Errors.validation([
          { path: 'publicId', message: 'Not an upload issued for this member' },
        ]);
      }
    }
    const after = await Member.findOneAndUpdate(
      { _id: id },
      publicId === null
        ? { $unset: { photoUrl: 1, photoPublicId: 1 } }
        : {
            $set: {
              photoPublicId: publicId,
              photoUrl: images.deliveryUrl(publicId, 'member_photo'),
            },
          },
      { returnDocument: 'after' },
    ).lean<LeanMember>();
    const old = before.photoPublicId;
    if (old && old !== publicId) await images.destroy(old);
    await audit.record(ctx, {
      action: publicId === null ? 'member.photo_remove' : 'member.photo_update',
      target: { type: 'member', id },
    });
    return toDetail(after!);
  }

  async function setArchived(id: string, archive: boolean, ctx: AuditContext) {
    const before = await load(id);
    if (Boolean(before.archivedAt) === archive) {
      throw Errors.conflict(archive ? 'Member is already archived' : 'Member is not archived');
    }
    const after = await inTransaction(async (session) => {
      const m = await Member.findOneAndUpdate(
        { _id: id },
        archive ? { $set: { archivedAt: new Date() } } : { $unset: { archivedAt: 1 } },
        { returnDocument: 'after', session },
      ).lean<LeanMember>();
      await syncLogin(m!, session);
      return m!;
    });
    await audit.record(ctx, {
      action: archive ? 'member.archive' : 'member.restore',
      target: { type: 'member', id },
    });
    return toDetail(after);
  }

  // ---------------------------------------------------------------- the member themselves

  async function selfFilter(userId: string) {
    const user = await User.findOne({ _id: userId, role: 'member' }).select('memberId').lean();
    if (!user?.memberId) throw Errors.notFound('Member profile');
    return { _id: user.memberId, userId: new Types.ObjectId(userId), archivedAt: null };
  }

  async function getSelf(userId: string) {
    const m = await Member.findOne(await selfFilter(userId)).lean<LeanMember>();
    if (!m) throw Errors.notFound('Member profile');
    return toSelfView(m);
  }

  async function updateSelf(userId: string, input: SelfUpdateInput, ctx: AuditContext) {
    const picked = {
      gender: input.gender,
      dateOfBirth: input.dateOfBirth,
      emergencyContact: input.emergencyContact,
    };
    return toSelfView(
      await applyPatch(await selfFilter(userId), picked, ctx, 'member.self_update'),
    );
  }

  return {
    list,
    get,
    create,
    update,
    archive: (id: string, ctx: AuditContext) => setArchived(id, true, ctx),
    restore: (id: string, ctx: AuditContext) => setArchived(id, false, ctx),
    getSelf,
    updateSelf,
    setPhoto,
  };
}

export type MemberService = ReturnType<typeof createMemberService>;
