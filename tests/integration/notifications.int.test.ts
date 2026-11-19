import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { Member, Membership, Notification, Plan, Tenant } from '../../src/db/models.js';
import { createJobs } from '../../src/jobs/index.js';
import {
  addDays,
  formatDateOnly,
  parseDateOnly,
  startOfDayIn,
  todayIn,
} from '../../src/lib/dates.js';
import { createLogger } from '../../src/lib/logger.js';
import { memoryMailer, type Mailer } from '../../src/lib/mailer.js';
import { createAuditService } from '../../src/modules/audit/audit.service.js';
import {
  MAX_ATTEMPTS,
  RETRY_DELAYS_MS,
  createNotificationService,
} from '../../src/modules/notifications/notification.service.js';
import { runAsPlatform, runInTenant } from '../../src/tenancy/context.js';
import { testEnv } from '../helpers/app.js';
import { connectTestDb, describeWithDb, dropAndDisconnect } from '../helpers/db.js';
import { FZ, PH, gymId, intApp, resetDemo } from '../helpers/int.js';

const logger = createLogger('silent');
const env = testEnv();
const audit = createAuditService({ logger });
const outbox = memoryMailer();
let failSends = false;
let skipSends = false;
const flakyMailer: Mailer = {
  async send(m) {
    if (failSends) throw new Error('Resend rejected the email (500)');
    if (skipSends) return { status: 'skipped', reason: 'kind_not_enabled' };
    return outbox.send(m);
  },
};
const svc = createNotificationService({ env, mailer: flakyMailer, logger, audit });
const { mailer: appMailer, call, tokenFor } = intApp();

const today = () => todayIn('Asia/Kolkata');
/** An instant at hh:00 gym time today. */
const at = (hh: number) =>
  new Date(startOfDayIn(today(), 'Asia/Kolkata').getTime() + hh * 3_600_000);
const dayShift = (n: number) => addDays(parseDateOnly(today())!, n);
const IST_MS = 330 * 60_000;
/** If `t` falls outside 09:00–20:00 IST, the next 09:00 IST (when the dispatcher would send). */
function withinSendHours(t: number) {
  const local = new Date(t + IST_MS);
  const h = local.getUTCHours();
  if (h >= 9 && h < 20) return t;
  const next = new Date(
    Date.UTC(
      local.getUTCFullYear(),
      local.getUTCMonth(),
      local.getUTCDate() + (h >= 20 ? 1 : 0),
      9,
    ),
  );
  return next.getTime() - IST_MS;
}

async function inPH<T>(fn: () => Promise<T>) {
  return runInTenant(await gymId('powerhouse'), fn);
}
async function membershipOf(phone: string) {
  return inPH(async () => {
    const m = await Member.findOne({ phone }).lean();
    return (await Membership.findOne({ memberId: m!._id }).sort({ startDate: -1 }).lean())!;
  });
}

describeWithDb('renewal reminders (real MongoDB)', () => {
  beforeAll(async () => {
    await connectTestDb(`notifications_${Date.now()}`);
  });
  afterAll(dropAndDisconnect);
  beforeEach(async () => {
    await resetDemo(appMailer);
    outbox.clear();
    failSends = false;
    skipSends = false;
  });

  it('the scan queues one "expiring" reminder per membership, however often it runs', async () => {
    expect(await inPH(() => svc.enqueueRenewalReminders(at(10)))).toEqual({ queued: 1 }); // Arjun
    expect(await inPH(() => svc.enqueueRenewalReminders(at(11)))).toEqual({ queued: 0 });
    const rows = await inPH(() => Notification.find().lean());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'renewal_expiring', status: 'queued', attempts: 0 });
    // FitZone has nothing ending soon.
    expect(
      await runInTenant(await gymId('fitzone'), () => svc.enqueueRenewalReminders(at(10))),
    ).toEqual({ queued: 0 });
  });

  it('sends during gym hours with the right content; nothing twice; nothing at night', async () => {
    await inPH(() => svc.enqueueRenewalReminders(at(10)));
    expect(await inPH(() => svc.dispatch(at(23)))).toEqual({
      sent: 0,
      deferred: 'outside_send_hours',
    });
    expect(await inPH(() => svc.dispatch(at(6)))).toMatchObject({ deferred: 'outside_send_hours' });
    expect(outbox.outbox).toHaveLength(0);

    expect(await inPH(() => svc.dispatch(at(10)))).toMatchObject({ sent: 1 });
    const mail = outbox.outbox[0]!;
    expect(mail).toMatchObject({
      to: 'arjun@member.demo',
      kind: 'renewal_reminder',
      fromName: 'Powerhouse Fitness',
    });
    expect(JSON.stringify(mail)).not.toMatch(/fitexaa/i);
    expect(mail.subject).toMatch(/^Your Powerhouse Fitness membership ends on \d{1,2} \w+ \d{4}$/);
    expect(mail.text).toContain('Hi Arjun Sharma');
    expect(mail.text).toContain('Monthly membership');
    expect(mail.text).toContain('http://powerhouse.localhost:3000');
    expect(await inPH(() => svc.dispatch(at(11)))).toMatchObject({ sent: 0 });
    expect((await inPH(() => Notification.findOne().lean()))!.status).toBe('sent');
  });

  it('a reminder the mail policy skips is recorded as skipped (not sent) and not retried', async () => {
    skipSends = true;
    await inPH(() => svc.enqueueRenewalReminders(at(10)));
    expect(await inPH(() => svc.dispatch(at(10)))).toMatchObject({ sent: 0, skipped: 1 });
    const row = (await inPH(() => Notification.findOne().lean()))!;
    expect(row).toMatchObject({ status: 'skipped', reason: 'kind_not_enabled' });
    expect(row.sentAt ?? null).toBeNull();
    skipSends = false;
    expect(await inPH(() => svc.dispatch(at(11)))).toMatchObject({ sent: 0 });
    expect(outbox.outbox).toHaveLength(0);
  });

  it('retries with growing delays, then gives up; the owner can retry', async () => {
    await inPH(() => svc.enqueueRenewalReminders(at(10)));
    failSends = true;
    let t = at(10).getTime();
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await inPH(() => svc.dispatch(new Date(t)));
      const n = (await inPH(() => Notification.findOne().lean()))!;
      expect(n.attempts).toBe(attempt);
      if (attempt < MAX_ATTEMPTS) {
        expect(n.status).toBe('queued');
        expect(n.nextAttemptAt.getTime() - t).toBe(RETRY_DELAYS_MS[attempt - 1]);
        // Not due yet: nothing happens.
        await inPH(() => svc.dispatch(new Date(t + 1000)));
        expect((await inPH(() => Notification.findOne().lean()))!.attempts).toBe(attempt);
        t = withinSendHours(n.nextAttemptAt.getTime());
      } else {
        expect(n.status).toBe('failed');
        expect(n.reason).toMatch(/Resend rejected/);
      }
    }
    // The 12 h retry lands after midnight; it waited for 09:00, as members never get mail at night.

    const owner = await tokenFor(PH, 'owner@powerhouse.demo');
    const id = String((await inPH(() => Notification.findOne().lean()))!._id);
    expect((await call('post', PH, `/notifications/${id}/retry`, owner)).body.data.status).toBe(
      'queued',
    );
    failSends = false;
    // Retry queues it for "now" (the real clock): dispatch at the next allowed moment after that.
    const later = new Date(withinSendHours(Date.now() + 1000));
    expect(await inPH(() => svc.dispatch(later))).toMatchObject({ sent: 1 });
  });

  it('re-checks at send time: renewed → cancelled, archived → cancelled, no email → skipped', async () => {
    await inPH(() => svc.enqueueRenewalReminders(at(10)));
    const owner = await tokenFor(PH, 'owner@powerhouse.demo');
    const desk = await tokenFor(PH, 'desk@powerhouse.demo');
    const arjun = await membershipOf('+919811111111');
    await call('post', PH, `/members/${arjun.memberId}/memberships/renew`, desk).send({});
    expect(await inPH(() => svc.dispatch(at(10)))).toMatchObject({ sent: 0, cancelled: 1 });
    expect(await inPH(() => Notification.findOne().lean())).toMatchObject({
      status: 'cancelled',
      reason: 'renewed',
    });

    // Suresh: no email, membership ending in 2 days.
    const suresh = await inPH(
      async () => (await Member.findOne({ phone: '+919833333331' }).lean())!,
    );
    const plan = await inPH(async () => (await Plan.findOne({ name: 'Monthly' }).lean())!);
    const sale = await call('post', PH, `/members/${suresh._id}/memberships`, desk).send({
      planId: String(plan._id),
    });
    await inPH(() => Membership.updateOne({ _id: sale.body.data.id }, { endDate: dayShift(2) }));
    // Vikram: archive after queueing.
    const vikram = await membershipOf('+919811111113');
    await inPH(() => Membership.updateOne({ _id: vikram._id }, { endDate: dayShift(3) }));
    expect(await inPH(() => svc.enqueueRenewalReminders(at(10)))).toEqual({ queued: 2 });
    await call('post', PH, `/members/${vikram.memberId}/archive`, owner);
    expect(await inPH(() => svc.dispatch(at(10)))).toMatchObject({
      sent: 0,
      skipped: 1,
      cancelled: 1,
    });
    expect(outbox.outbox).toHaveLength(0);
  });

  it('an "expired" reminder goes out once, just after the end date', async () => {
    const priya = await membershipOf('+919811111112');
    await inPH(() => Membership.updateOne({ _id: priya._id }, { endDate: dayShift(-1) }));
    expect(await inPH(() => svc.enqueueRenewalReminders(at(10)))).toEqual({ queued: 2 }); // Arjun expiring + Priya expired
    await inPH(() => svc.dispatch(at(10)));
    const subjects = outbox.outbox.map((m) => m.subject).sort();
    expect(subjects[0]).toBe(
      'Your Powerhouse Fitness membership ends on ' + subjects[0]!.split(' on ')[1],
    );
    expect(subjects[1]).toBe('Your Powerhouse Fitness membership has ended');
  });

  it('gyms can switch reminders off', async () => {
    const owner = await tokenFor(PH, 'owner@powerhouse.demo');
    const res = await call('patch', PH, '/gym', owner).send({
      settings: { renewalRemindersEnabled: false },
    });
    expect(res.body.data.settings.renewalRemindersEnabled).toBe(false);
    expect(await inPH(() => svc.enqueueRenewalReminders(at(10)))).toEqual({
      queued: 0,
      disabled: true,
    });
  });

  it('the hourly job scans every active gym (and skips suspended ones)', async () => {
    const [scan] = createJobs({ env, logger, mailer: flakyMailer });
    expect(scan!.name).toBe('renewal-reminders-scan');
    const r = (await scan!.run()) as { gyms: number; results: { queued: number }[] };
    expect(r.gyms).toBe(2);
    expect(r.results.reduce((a, x) => a + x.queued, 0)).toBe(1);
    await runAsPlatform('test', () =>
      Tenant.updateOne({ slug: 'powerhouse' }, { status: 'suspended' }),
    );
    expect(((await scan!.run()) as { gyms: number }).gyms).toBe(1);
  });

  // ---------------------------------------------------------------- endpoints
  it('owner sees and manages the queue; desk cannot; other gyms cannot', async () => {
    await inPH(() => svc.enqueueRenewalReminders(at(10)));
    const owner = await tokenFor(PH, 'owner@powerhouse.demo');
    const list = await call('get', PH, '/notifications?status=queued', owner);
    expect(list.status).toBe(200);
    expect(list.body.data[0]).toMatchObject({
      kind: 'renewal_expiring',
      status: 'queued',
      member: { name: 'Arjun Sharma' },
    });
    const id = list.body.data[0].id;
    expect((await call('post', PH, `/notifications/${id}/retry`, owner)).status).toBe(409);
    expect((await call('post', PH, `/notifications/${id}/cancel`, owner)).body.data.status).toBe(
      'cancelled',
    );
    expect((await call('post', PH, `/notifications/${id}/cancel`, owner)).status).toBe(409);

    const desk = await tokenFor(PH, 'desk@powerhouse.demo');
    expect((await call('get', PH, '/notifications', desk)).status).toBe(403);
    const fz = await tokenFor(FZ, 'owner@fitzone.demo');
    expect((await call('post', FZ, `/notifications/${id}/retry`, fz)).status).toBe(404);
    expect((await call('get', FZ, '/notifications', fz)).body.meta.total).toBe(0);
    expect(formatDateOnly(dayShift(0))).toBe(today());
  });
});
