import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import mongoose, { Types } from 'mongoose';
import { hashPassword } from '../auth/password.js';
import {
  Attendance,
  Member,
  Membership,
  Payment,
  Plan,
  PlatformAdmin,
  Tenant,
  User,
} from '../db/models.js';
import {
  addDays,
  financialYear,
  formatDateOnly,
  parseDateOnly,
  periodEnd,
  startOfDayIn,
  todayIn,
} from '../lib/dates.js';
import { PLAN_DURATIONS, type PlanDuration } from '../modules/plans/plan.model.js';
import { priceBreakdown } from '../lib/money.js';
import { nextSequence } from '../modules/counters/counter.model.js';
import { MEMBER_CONSENT_VERSION } from '../modules/members/member.model.js';
import { formatMemberCode } from '../modules/members/member.service.js';
import { runInTenant } from '../tenancy/context.js';

/**
 * Demo data: one super admin and two gyms, each with an owner, a front-desk staff member and
 * four members (three with email for the member app, one walk-in without). Used for local development, demos and the pilot sales mockup.
 *
 * - Refuses to run with NODE_ENV=production.
 * - Never deletes anything: a gym whose slug already exists is left untouched.
 * - No passwords are hard-coded: SEED_PASSWORD or a freshly generated one, printed once.
 * - Member 1 has the SAME phone number in both gyms to demonstrate per-gym uniqueness.
 */
interface DemoGym {
  name: string;
  slug: string;
  primaryColor: string;
  defaultTheme: 'dark' | 'light';
  city: string;
  /** Sample GSTIN (from GST documentation), so one demo gym charges GST and one doesn't. */
  gstin?: string;
  owner: { name: string; email: string; phone: string };
  staff: { name: string; email: string; phone: string };
  members: {
    name: string;
    email?: string;
    phone: string;
    membership?: {
      plan: string;
      startedDaysAgo: number;
      /** Paid so far: 'full', a rupee amount, or nothing (unpaid). */
      paid?: 'full' | number;
      /** Check-ins, as days before today (0 = today), at 7 am gym time. */
      visits?: number[];
      method?: 'cash' | 'upi';
    };
  }[];
}

/** name, length, price in rupees (incl. GST where the gym charges it). */
export const DEMO_PLANS: [string, PlanDuration, number][] = [
  ['Monthly', 'monthly', 1500],
  ['Quarterly', 'quarterly', 4000],
  ['Half-yearly', 'half_yearly', 7500],
  ['Annual', 'yearly', 12000],
];

export const DEMO_GYMS: DemoGym[] = [
  {
    name: 'Powerhouse Fitness',
    slug: 'powerhouse',
    primaryColor: '#E11D48',
    defaultTheme: 'dark',
    city: 'Pune',
    gstin: '27AAPFU0939F1ZV',
    owner: { name: 'Rahul Mehta', email: 'owner@powerhouse.demo', phone: '+919800000001' },
    staff: { name: 'Sneha Patil', email: 'desk@powerhouse.demo', phone: '+919800000002' },
    members: [
      // Monthly, started 25 days ago: ends within the week (expiring soon).
      {
        name: 'Arjun Sharma',
        email: 'arjun@member.demo',
        phone: '+919811111111',
        membership: { plan: 'Monthly', startedDaysAgo: 25, paid: 500, method: 'cash', visits: [1] },
      },
      // Quarterly, started 100 days ago: expired about 10 days ago.
      {
        name: 'Priya Nair',
        email: 'priya@member.demo',
        phone: '+919811111112',
        membership: { plan: 'Quarterly', startedDaysAgo: 100 },
      },
      // Annual, plenty left.
      {
        name: 'Vikram Singh',
        email: 'vikram@member.demo',
        phone: '+919811111113',
        membership: {
          plan: 'Annual',
          startedDaysAgo: 30,
          paid: 'full',
          method: 'cash',
          visits: [0, 1, 2],
        },
      },
      // No email: managed by the front desk, no member-app access.
      { name: 'Suresh Kumar', phone: '+919833333331' },
    ],
  },
  {
    name: 'FitZone',
    slug: 'fitzone',
    primaryColor: '#0EA5E9',
    defaultTheme: 'light',
    city: 'Bengaluru',
    owner: { name: 'Kavya Reddy', email: 'owner@fitzone.demo', phone: '+919800000101' },
    staff: { name: 'Imran Khan', email: 'desk@fitzone.demo', phone: '+919800000102' },
    members: [
      {
        name: 'Arjun Sharma',
        email: 'arjun@member.demo',
        phone: '+919811111111',
        membership: {
          plan: 'Quarterly',
          startedDaysAgo: 10,
          paid: 'full',
          method: 'upi',
          visits: [0],
        },
      },
      { name: 'Meera Iyer', email: 'meera@member.demo', phone: '+919822222222' },
      { name: 'Rohan Das', email: 'rohan@member.demo', phone: '+919822222223' },
      { name: 'Anita Joshi', phone: '+919833333341' },
    ],
  },
];

export interface SeedResult {
  password: string;
  admin: { email: string; created: boolean };
  gyms: { slug: string; created: boolean }[];
}

export async function seedDemo(
  opts: { password?: string; adminEmail?: string } = {},
): Promise<SeedResult> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed demo data with NODE_ENV=production');
  }
  const password = opts.password ?? randomBytes(9).toString('base64url');
  const passwordHash = await hashPassword(password);
  const adminEmail = (opts.adminEmail ?? 'admin@platform.demo').toLowerCase();

  const result: SeedResult = { password, admin: { email: adminEmail, created: false }, gyms: [] };

  if (!(await PlatformAdmin.exists({ email: adminEmail }))) {
    await PlatformAdmin.create({ name: 'Platform Admin', email: adminEmail, passwordHash });
    result.admin.created = true;
  }

  for (const g of DEMO_GYMS) {
    if (await Tenant.exists({ slug: g.slug })) {
      result.gyms.push({ slug: g.slug, created: false });
      continue;
    }
    const tenant = await Tenant.create({
      name: g.name,
      slug: g.slug,
      email: g.owner.email,
      phone: g.owner.phone,
      address: { city: g.city, country: 'IN' },
      settings: g.gstin ? { gstin: g.gstin } : {},
      branding: { primaryColor: g.primaryColor, defaultTheme: g.defaultTheme },
      subscription: { status: 'trialing', planCode: 'pilot', priceMonthlyPaise: 99_900 },
    });
    await runInTenant(tenant._id, async () => {
      await User.create([
        { ...g.owner, role: 'owner' as const, passwordHash },
        { ...g.staff, role: 'staff' as const, passwordHash },
      ]);
      const tax = g.gstin
        ? { taxMode: 'inclusive' as const, gstRate: 18 as const }
        : { taxMode: 'none' as const, gstRate: 0 as const };
      const plans = new Map<string, InstanceType<typeof Plan>>();
      for (const [name, duration, rupees] of DEMO_PLANS) {
        plans.set(
          name,
          await Plan.create({
            name,
            nameKey: name.toLowerCase(),
            duration,
            months: PLAN_DURATIONS[duration],
            pricePaise: rupees * 100,
            ...tax,
          }),
        );
      }
      // Member record + (with an email) a linked member login, as the members API creates them.
      for (const m of g.members) {
        const memberId = new Types.ObjectId();
        const userId = m.email ? new Types.ObjectId() : undefined;
        await Member.create({
          _id: memberId,
          memberCode: formatMemberCode(await nextSequence('memberCode')),
          name: m.name,
          phone: m.phone,
          email: m.email,
          joinDate: new Date(Date.UTC(2026, 0, 15)),
          consent: { at: new Date(), version: MEMBER_CONSENT_VERSION },
          userId,
        });
        if (userId) {
          await User.create({ _id: userId, ...m, role: 'member' as const, memberId });
        }
        // Memberships relative to today, so "expiring soon" and "expired" have something to show.
        const sold = m.membership;
        if (sold) {
          const plan = plans.get(sold.plan)!;
          const today = parseDateOnly(todayIn('Asia/Kolkata'))!;
          const startDate = addDays(today, -sold.startedDaysAgo);
          const breakdown = priceBreakdown(plan.pricePaise, plan.taxMode, plan.gstRate);
          const paidPaise =
            sold.paid === 'full' ? breakdown.totalPaise : sold.paid ? sold.paid * 100 : 0;
          const membership = await Membership.create({
            memberId,
            plan: {
              planId: plan._id,
              name: plan.name,
              duration: plan.duration,
              months: plan.months,
              pricePaise: plan.pricePaise,
              taxMode: plan.taxMode,
              gstRate: plan.gstRate,
            },
            discountPaise: 0,
            ...breakdown,
            startDate,
            endDate: periodEnd(startDate, plan.months),
            kind: 'new',
            paidPaise,
          });
          for (const daysAgo of sold.visits ?? []) {
            const day = formatDateOnly(addDays(today, -daysAgo))!;
            await Attendance.create({
              memberId,
              membershipId: membership._id,
              day,
              hour: 7,
              checkedInAt: new Date(startOfDayIn(day, 'Asia/Kolkata').getTime() + 7 * 3_600_000),
              method: 'qr',
            });
          }
          if (paidPaise) {
            // Same numbering as the payments API: per gym, per financial year.
            const receivedAt = new Date(startDate.getTime() + 11 * 3_600_000);
            const fy = financialYear(todayIn('Asia/Kolkata', receivedAt));
            const seq = await nextSequence(`receipt:${fy}`);
            await Payment.create({
              memberId,
              membershipId: membership._id,
              amountPaise: paidPaise,
              method: sold.method ?? 'cash',
              receiptNumber: `RCPT/${fy}/${String(seq).padStart(4, '0')}`,
              financialYear: fy,
              receivedAt,
            });
          }
        }
      }
    });
    result.gyms.push({ slug: g.slug, created: true });
  }
  return result;
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');
  await mongoose.connect(uri);
  try {
    await Promise.all(Object.values(mongoose.models).map((m) => m.createIndexes()));
    const r = await seedDemo({
      password: process.env.SEED_PASSWORD,
      adminEmail: process.env.SEED_ADMIN_EMAIL,
    });
    const anyCreated = r.admin.created || r.gyms.some((g) => g.created);
    const lines = [
      '',
      'Demo data',
      '---------',
      `Super admin  ${r.admin.email}  (${r.admin.created ? 'created' : 'already existed'})  → http://admin.localhost:4000`,
      ...DEMO_GYMS.map((g) => {
        const status = r.gyms.find((x) => x.slug === g.slug)?.created
          ? 'created'
          : 'already existed, untouched';
        return (
          `${g.name.padEnd(19)} http://${g.slug}.localhost:4000  (${status})\n` +
          `   owner  ${g.owner.email} / ${g.owner.phone}\n` +
          `   staff  ${g.staff.email} / ${g.staff.phone}\n` +
          `   members (email link): ${g.members.flatMap((m) => (m.email ? [m.email] : [])).join(', ')}`
        );
      }),
      '',
      anyCreated
        ? `Password for the accounts created now: ${r.password}`
        : 'Nothing created; existing passwords unchanged.',
      '',
    ];
    process.stdout.write(lines.join('\n') + '\n');
  } finally {
    await mongoose.disconnect();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    process.stderr.write(`Seed failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
