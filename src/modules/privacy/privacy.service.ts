import mongoose, { Types } from 'mongoose';
import { formatDateOnly } from '../../lib/dates.js';
import { Errors } from '../../lib/errors.js';
import type { ImageStore } from '../../lib/image-store.js';
import type { Logger } from '../../lib/logger.js';
import { requireTenantId } from '../../tenancy/context.js';
import { Attendance } from '../attendance/attendance.model.js';
import type { AuditContext, AuditService } from '../audit/audit.service.js';
import { AuthToken } from '../auth/auth-token.model.js';
import { Session } from '../auth/session.model.js';
import { Member } from '../members/member.model.js';
import { Membership } from '../memberships/membership.model.js';
import {
  gymCalendar,
  toMembershipView,
  type LeanMembership,
} from '../memberships/membership.service.js';
import { Notification } from '../notifications/notification.model.js';
import { Payment } from '../payments/payment.model.js';
import { toPaymentView, type LeanPayment } from '../payments/payment.view.js';
import { Tenant } from '../tenants/tenant.model.js';
import { User } from '../users/user.model.js';

/** What erasure removes, and what it keeps (and why), returned to the owner and documented. */
export const ERASE_POLICY = {
  removed: [
    'name (replaced by "Erased member <code>")',
    'phone',
    'email',
    'date of birth',
    'gender',
    'emergency contact',
    'staff notes on the member, their memberships and payments',
    'photo (also deleted from image storage)',
    'member-app login, sessions and sign-in links',
    'queued and past reminder emails',
  ],
  retained: [
    'member code and join date (to keep financial records linked)',
    'memberships, payments, refunds and receipt numbers (tax and accounting records)',
    'attendance dates (no personal details)',
    'consent record (when and which wording was agreed)',
  ],
};

/**
 * DPDP Act data-principal rights inside one gym: access (export) and erasure. Everything runs in
 * the host gym's tenant scope; nothing here can reach another gym's member.
 */
export function createPrivacyService(deps: {
  audit: AuditService;
  images: ImageStore | null;
  logger: Logger;
}) {
  const { audit, images, logger } = deps;

  async function collect(memberId: Types.ObjectId, forMember: boolean) {
    const { today } = await gymCalendar();
    const [gym, m, login, memberships, payments, visits, notifications] = await Promise.all([
      Tenant.findById(requireTenantId()).select('name').lean(),
      Member.findById(memberId).lean(),
      User.findOne({ memberId, role: 'member' })
        .select('email status lastLoginAt createdAt')
        .lean(),
      Membership.find({ memberId }).sort({ startDate: -1 }).lean<LeanMembership[]>(),
      Payment.find({ memberId }).sort({ receivedAt: -1 }).lean<LeanPayment[]>(),
      Attendance.find({ memberId }).sort({ day: -1 }).select('day checkedInAt method').lean(),
      Notification.find({ memberId })
        .sort({ createdAt: -1 })
        .select('kind channel status sentAt createdAt')
        .lean(),
    ]);
    if (!m) throw Errors.notFound('Member');
    /** The member's own copy leaves out staff-internal fields. */
    const strip = <T extends Record<string, unknown>>(o: T) =>
      forMember
        ? Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'notes' && k !== 'soldBy'))
        : o;
    return {
      exportedAt: new Date(),
      gym: gym?.name ?? null,
      member: {
        memberCode: m.memberCode,
        name: m.name,
        phone: m.phone ?? null,
        email: m.email ?? null,
        gender: m.gender ?? null,
        dateOfBirth: formatDateOnly(m.dateOfBirth),
        joinDate: formatDateOnly(m.joinDate),
        emergencyContact: m.emergencyContact?.name ? m.emergencyContact : null,
        photoUrl: m.photoUrl ?? null,
        consent: m.consent ? { at: m.consent.at, version: m.consent.version } : null,
        ...(forMember ? {} : { notes: m.notes ?? null }),
        archivedAt: m.archivedAt ?? null,
        erasedAt: (m as { erasedAt?: Date }).erasedAt ?? null,
        createdAt: m.createdAt,
      },
      login: login
        ? {
            email: login.email ?? null,
            status: login.status,
            lastLoginAt: login.lastLoginAt ?? null,
            createdAt: login.createdAt,
          }
        : null,
      memberships: memberships.map((x) => strip(toMembershipView(x, today))),
      payments: payments.map((p) => toPaymentView(p, { forMember })),
      attendance: visits.map((v) => ({ day: v.day, checkedInAt: v.checkedInAt, method: v.method })),
      notifications: notifications.map((n) => ({
        kind: n.kind,
        channel: n.channel,
        status: n.status,
        sentAt: n.sentAt ?? null,
        createdAt: n.createdAt,
      })),
    };
  }

  async function exportMember(memberId: string, ctx: AuditContext) {
    if (!(await Member.exists({ _id: memberId }))) throw Errors.notFound('Member');
    const data = await collect(new Types.ObjectId(memberId), false);
    await audit.record(ctx, { action: 'member.export', target: { type: 'member', id: memberId } });
    return data;
  }

  async function exportSelf(userId: string, ctx: AuditContext) {
    const u = await User.findOne({ _id: userId, role: 'member' }).select('memberId').lean();
    if (!u?.memberId) throw Errors.notFound('Member profile');
    const data = await collect(u.memberId, true);
    await audit.record(ctx, {
      action: 'member.self_export',
      target: { type: 'member', id: String(u.memberId) },
    });
    return data;
  }

  /**
   * Irreversible. Personal data goes; financial and attendance records stay, anonymised (they
   * reference only the member id/code). Runs in one transaction so it can't half-happen.
   */
  async function erase(
    memberId: string,
    input: { confirmMemberCode: string; reason: string },
    ctx: AuditContext,
  ) {
    const m = await Member.findById(memberId).lean();
    if (!m) throw Errors.notFound('Member');
    if ((m as { erasedAt?: Date }).erasedAt)
      throw Errors.conflict('This member was already erased');
    if (input.confirmMemberCode.trim().toUpperCase() !== m.memberCode) {
      throw Errors.validation([
        { path: 'confirmMemberCode', message: `Type the member code (${m.memberCode}) to confirm` },
      ]);
    }
    const now = new Date();
    const userId =
      m.userId ??
      (await User.findOne({ memberId: m._id, role: 'member' }).select('_id').lean())?._id;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await Member.updateOne(
          { _id: m._id },
          {
            $set: {
              name: `Erased member ${m.memberCode}`,
              erasedAt: now,
              archivedAt: m.archivedAt ?? now,
            },
            $unset: {
              phone: 1,
              email: 1,
              gender: 1,
              dateOfBirth: 1,
              emergencyContact: 1,
              notes: 1,
              photoUrl: 1,
              photoPublicId: 1,
              userId: 1,
            },
          },
          { session },
        );
        if (userId) {
          await User.deleteOne({ _id: userId, role: 'member' }, { session });
          await Session.deleteMany({ userId }, { session });
          await AuthToken.deleteMany({ userId }, { session });
        }
        await Membership.updateMany({ memberId: m._id }, { $unset: { notes: 1 } }, { session });
        await Payment.updateMany({ memberId: m._id }, { $unset: { notes: 1 } }, { session });
        await Notification.deleteMany({ memberId: m._id }, { session });
      });
    } finally {
      await session.endSession();
    }
    if (m.photoPublicId) {
      if (images) await images.destroy(m.photoPublicId);
      else
        logger.warn({ memberId }, 'Erased member had a photo but image storage is not configured');
    }
    await audit.record(ctx, {
      action: 'member.erase',
      target: { type: 'member', id: memberId },
      // The reason and code only: the log must not keep what was just erased.
      metadata: { memberCode: m.memberCode, reason: input.reason },
    });
    return { memberCode: m.memberCode, erasedAt: now, ...ERASE_POLICY };
  }

  return { exportMember, exportSelf, erase };
}

export type PrivacyService = ReturnType<typeof createPrivacyService>;
