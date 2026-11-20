import { Types } from 'mongoose';
import type { Env } from '../../config/env.js';
import { addDays, daysBetween, formatDateOnly, parseDateOnly, todayIn } from '../../lib/dates.js';
import { Errors } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import type { Mailer } from '../../lib/mailer.js';
import { pageMeta, skipFor, type PageQuery } from '../../lib/pagination.js';
import { requireTenantId } from '../../tenancy/context.js';
import type { AuditContext, AuditService } from '../audit/audit.service.js';
import { Member } from '../members/member.model.js';
import { Membership } from '../memberships/membership.model.js';
import { unrenewedEnding } from '../memberships/renewal-status.js';
import { Tenant } from '../tenants/tenant.model.js';
import { Notification, type LeanNotification } from './notification.model.js';

/** Delays after the 1st, 2nd, 3rd, 4th failed attempt; the 5th failure is final. */
export const RETRY_DELAYS_MS = [5 * 60_000, 30 * 60_000, 2 * 3_600_000, 12 * 3_600_000];
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
/** Members get email between 09:00 and 20:00 gym time, never at night. */
export const SEND_HOURS = { from: 9, to: 20 };
/** "Expired" reminders go out within this many days after the end date, once. */
const EXPIRED_WINDOW_DAYS = 3;
const BATCH = 50;
/** A send that has been "sending" this long was interrupted (crash); put it back in the queue. */
const STUCK_MS = 15 * 60_000;

async function gymSettings() {
  const t = await Tenant.findById(requireTenantId())
    .select(
      'name slug settings.timezone settings.renewalReminderDays settings.renewalRemindersEnabled',
    )
    .lean();
  return {
    name: t?.name ?? 'Your gym',
    slug: t?.slug ?? '',
    tz: t?.settings?.timezone ?? 'Asia/Kolkata',
    days: t?.settings?.renewalReminderDays ?? 7,
    enabled: t?.settings?.renewalRemindersEnabled ?? true,
  };
}

const localHour = (tz: string, at: Date) =>
  Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(
      at,
    ),
  );
const prettyDate = (d: Date) =>
  new Intl.DateTimeFormat('en-IN', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(d);

export function createNotificationService(deps: {
  env: Env;
  mailer: Mailer;
  logger: Logger;
  audit: AuditService;
}) {
  const { env, mailer, logger, audit } = deps;
  const appUrl = (slug: string) => env.GYM_APP_URL_TEMPLATE.replace('{slug}', slug);

  /**
   * Queues reminders for the current gym (run by the hourly job). Idempotent: each membership gets
   * at most one "expiring" and one "expired" reminder, however often this runs.
   */
  async function enqueueRenewalReminders(now = new Date()) {
    const g = await gymSettings();
    if (!g.enabled) return { queued: 0, disabled: true };
    const today = todayIn(g.tz, now);
    const shift = (n: number) => formatDateOnly(addDays(parseDateOnly(today)!, n))!;
    const [expiring, expired] = await Promise.all([
      unrenewedEnding(today, shift(g.days)),
      unrenewedEnding(shift(-EXPIRED_WINDOW_DAYS), shift(-1)),
    ]);
    let queued = 0;
    const add = async (
      m: { _id: Types.ObjectId; memberId: Types.ObjectId },
      kind: LeanNotification['kind'],
    ) => {
      const res = await Notification.updateOne(
        { dedupeKey: `${kind}:${m._id}` },
        {
          $setOnInsert: {
            memberId: m.memberId,
            membershipId: m._id,
            kind,
            channel: 'email',
            status: 'queued',
            attempts: 0,
            nextAttemptAt: now,
          },
        },
        { upsert: true },
      );
      queued += res.upsertedCount;
    };
    // Only memberships that have started: an upcoming one "ending soon" isn't a renewal moment.
    for (const m of expiring)
      if (m.startDate <= parseDateOnly(today)!) await add(m, 'renewal_expiring');
    for (const m of expired) await add(m, 'renewal_expired');
    return { queued };
  }

  function message(
    kind: LeanNotification['kind'],
    gym: { name: string; slug: string },
    name: string,
    plan: string,
    end: Date,
    today: Date,
  ) {
    const left = daysBetween(today, end) + 1;
    const link = appUrl(gym.slug);
    if (kind === 'renewal_expiring') {
      return {
        subject: `Your ${gym.name} membership ends on ${prettyDate(end)}`,
        text:
          `Hi ${name},\n\nYour ${plan} membership at ${gym.name} ends on ${prettyDate(end)}` +
          ` (${left === 1 ? 'today is the last day' : `${left} days left`}).\n\n` +
          `Renew at the front desk so your workouts don't stop. Your pass and plan:\n${link}\n\nSee you at the gym!`,
      };
    }
    return {
      subject: `Your ${gym.name} membership has ended`,
      text:
        `Hi ${name},\n\nYour ${plan} membership at ${gym.name} ended on ${prettyDate(end)}.\n\n` +
        `We'd love to have you back. Renew at the front desk. Your pass and plan:\n${link}`,
    };
  }

  /**
   * Sends due reminders for the current gym (run every few minutes). Each one is claimed atomically
   * (queued → sending) so two dispatchers never send the same message. Conditions are re-checked
   * at send time: a member who renewed, was archived or has no email is not emailed.
   */
  async function dispatch(now = new Date()) {
    const g = await gymSettings();
    const hour = localHour(g.tz, now);
    if (hour < SEND_HOURS.from || hour >= SEND_HOURS.to)
      return { sent: 0, deferred: 'outside_send_hours' };
    await Notification.updateMany(
      { status: 'sending', claimedAt: { $lt: new Date(now.getTime() - STUCK_MS) } },
      { $set: { status: 'queued' } },
    );
    const today = parseDateOnly(todayIn(g.tz, now))!;
    const counts = { sent: 0, failed: 0, retrying: 0, skipped: 0, cancelled: 0 };

    for (let i = 0; i < BATCH; i++) {
      const n = await Notification.findOneAndUpdate(
        { status: 'queued', nextAttemptAt: { $lte: now } },
        { $set: { status: 'sending', claimedAt: now } },
        { sort: { nextAttemptAt: 1 }, returnDocument: 'after' },
      ).lean<LeanNotification>();
      if (!n) break;
      const close = (status: 'skipped' | 'cancelled', reason: string) =>
        Notification.updateOne({ _id: n._id }, { $set: { status, reason } });

      const [member, ms, later] = await Promise.all([
        Member.findById(n.memberId).select('name email archivedAt').lean(),
        Membership.findById(n.membershipId).select('plan.name endDate cancelledAt').lean(),
        Membership.exists({ memberId: n.memberId, cancelledAt: null, startDate: { $gt: today } }),
      ]);
      if (!member || member.archivedAt) {
        await close('cancelled', 'archived');
        counts.cancelled++;
        continue;
      }
      if (!ms || ms.cancelledAt || (n.kind === 'renewal_expiring' && later)) {
        await close('cancelled', 'renewed');
        counts.cancelled++;
        continue;
      }
      // An "expired" reminder is moot if they renewed since (any membership starting after the end).
      if (
        n.kind === 'renewal_expired' &&
        (await Membership.exists({
          memberId: n.memberId,
          cancelledAt: null,
          startDate: { $gt: ms.endDate },
        }))
      ) {
        await close('cancelled', 'renewed');
        counts.cancelled++;
        continue;
      }
      if (!member.email) {
        await close('skipped', 'no_email');
        counts.skipped++;
        continue;
      }

      const { subject, text } = message(
        n.kind,
        g,
        member.name,
        ms.plan?.name ?? 'membership',
        ms.endDate,
        today,
      );
      try {
        const result = await mailer.send({
          to: member.email,
          subject,
          text,
          kind: 'renewal_reminder',
          fromName: g.name,
        });
        if (result.status === 'skipped') {
          // Config says this email must not go out (kind not enabled, or a dev allow-list): record
          // that rather than "sent", and don't retry.
          await close('skipped', result.reason);
          counts.skipped++;
          continue;
        }
        await Notification.updateOne(
          { _id: n._id },
          { $set: { status: 'sent', sentAt: now }, $inc: { attempts: 1 }, $unset: { reason: 1 } },
        );
        counts.sent++;
      } catch (err) {
        const attempts = n.attempts + 1;
        const final = attempts >= MAX_ATTEMPTS;
        await Notification.updateOne(
          { _id: n._id },
          {
            $set: {
              status: final ? 'failed' : 'queued',
              attempts,
              reason: String((err as Error)?.message ?? 'send failed').slice(0, 300),
              nextAttemptAt: final ? now : new Date(now.getTime() + RETRY_DELAYS_MS[attempts - 1]!),
            },
          },
        );
        if (final) counts.failed++;
        else counts.retrying++;
        logger.warn({ notificationId: String(n._id), attempts, final }, 'Reminder email failed');
      }
    }
    return counts;
  }

  // ---------------------------------------------------------------- owner endpoints

  async function list(q: PageQuery & { status?: string; kind?: string }) {
    const filter: Record<string, unknown> = {};
    if (q.status) filter.status = q.status;
    if (q.kind) filter.kind = q.kind;
    const [rows, total] = await Promise.all([
      Notification.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip(skipFor(q))
        .limit(q.limit)
        .lean<LeanNotification[]>(),
      Notification.countDocuments(filter),
    ]);
    const members = await Member.find({ _id: { $in: rows.map((r) => r.memberId) } })
      .select('name memberCode phone')
      .lean();
    const byId = new Map(members.map((m) => [String(m._id), m]));
    return {
      items: rows.map((n) => {
        const m = byId.get(String(n.memberId));
        return {
          id: String(n._id),
          kind: n.kind,
          channel: n.channel,
          status: n.status,
          attempts: n.attempts,
          nextAttemptAt: n.status === 'queued' ? n.nextAttemptAt : null,
          sentAt: n.sentAt ?? null,
          reason: n.reason ?? null,
          createdAt: n.createdAt ?? null,
          membershipId: String(n.membershipId),
          member: m
            ? { id: String(m._id), name: m.name, memberCode: m.memberCode, phone: m.phone ?? null }
            : null,
        };
      }),
      meta: pageMeta(q, total),
    };
  }

  async function retry(id: string, ctx: AuditContext) {
    const res = await Notification.updateOne(
      { _id: id, status: { $in: ['failed', 'skipped'] } },
      { $set: { status: 'queued', attempts: 0, nextAttemptAt: new Date() }, $unset: { reason: 1 } },
    );
    if (!res.matchedCount) {
      if (!(await Notification.exists({ _id: id }))) throw Errors.notFound('Notification');
      throw Errors.conflict('Only failed or skipped notifications can be retried');
    }
    await audit.record(ctx, { action: 'notification.retry', target: { type: 'notification', id } });
    return { id, status: 'queued' };
  }

  async function cancel(id: string, ctx: AuditContext) {
    const res = await Notification.updateOne(
      { _id: id, status: 'queued' },
      { $set: { status: 'cancelled', reason: 'cancelled by staff' } },
    );
    if (!res.matchedCount) {
      if (!(await Notification.exists({ _id: id }))) throw Errors.notFound('Notification');
      throw Errors.conflict('Only queued notifications can be cancelled');
    }
    await audit.record(ctx, {
      action: 'notification.cancel',
      target: { type: 'notification', id },
    });
    return { id, status: 'cancelled' };
  }

  return { enqueueRenewalReminders, dispatch, list, retry, cancel };
}

export type NotificationService = ReturnType<typeof createNotificationService>;
