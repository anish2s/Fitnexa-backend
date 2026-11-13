import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import { hashPassword } from '../auth/password.js';
import { PlatformAdmin, Tenant, User } from '../db/models.js';
import { runInTenant } from '../tenancy/context.js';

/**
 * Demo data: one super admin and two gyms, each with an owner, a front-desk staff member and
 * three members. Used for local development, demos and the pilot sales mockup.
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
  owner: { name: string; email: string; phone: string };
  staff: { name: string; email: string; phone: string };
  members: { name: string; email: string; phone: string }[];
}

export const DEMO_GYMS: DemoGym[] = [
  {
    name: 'Powerhouse Fitness',
    slug: 'powerhouse',
    primaryColor: '#E11D48',
    defaultTheme: 'dark',
    city: 'Pune',
    owner: { name: 'Rahul Mehta', email: 'owner@powerhouse.demo', phone: '+919800000001' },
    staff: { name: 'Sneha Patil', email: 'desk@powerhouse.demo', phone: '+919800000002' },
    members: [
      { name: 'Arjun Sharma', email: 'arjun@member.demo', phone: '+919811111111' },
      { name: 'Priya Nair', email: 'priya@member.demo', phone: '+919811111112' },
      { name: 'Vikram Singh', email: 'vikram@member.demo', phone: '+919811111113' },
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
      { name: 'Arjun Sharma', email: 'arjun@member.demo', phone: '+919811111111' },
      { name: 'Meera Iyer', email: 'meera@member.demo', phone: '+919822222222' },
      { name: 'Rohan Das', email: 'rohan@member.demo', phone: '+919822222223' },
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
      branding: { primaryColor: g.primaryColor, defaultTheme: g.defaultTheme },
      subscription: { status: 'trialing', planCode: 'pilot', priceMonthlyPaise: 99_900 },
    });
    await runInTenant(tenant._id, async () => {
      await User.create([
        { ...g.owner, role: 'owner' as const, passwordHash },
        { ...g.staff, role: 'staff' as const, passwordHash },
        ...g.members.map((m) => ({ ...m, role: 'member' as const })),
      ]);
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
          `   members (email link): ${g.members.map((m) => m.email).join(', ')}`
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
