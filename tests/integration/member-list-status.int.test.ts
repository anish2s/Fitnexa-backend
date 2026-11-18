import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { Member, Membership, Plan } from '../../src/db/models.js';
import {
  addDays,
  daysBetween,
  formatDateOnly,
  parseDateOnly,
  todayIn,
} from '../../src/lib/dates.js';
import { runInTenant } from '../../src/tenancy/context.js';
import { connectTestDb, describeWithDb, dropAndDisconnect } from '../helpers/db.js';
import { FZ, PH, gymId, intApp, resetDemo } from '../helpers/int.js';

const { mailer, call, tokenFor, memberToken } = intApp();

// Powerhouse seed: Arjun monthly from 25 days ago, ₹500 paid (expiring soon, owes money);
// Priya quarterly from 100 days ago, unpaid (expired, owes money); Vikram yearly from 30 days ago,
// paid; Suresh nothing. FitZone: Arjun quarterly, paid; Meera, Rohan, Anita nothing.
const ARJUN = '+919811111111';
const SURESH = '+919833333331';
const MEERA = '+919822222222';

const today = () => parseDateOnly(todayIn('Asia/Kolkata'))!;
const day = (offset: number) => formatDateOnly(addDays(today(), offset))!;

type Row = {
  id: string;
  name: string;
  balanceDuePaise: number;
  membership: {
    status: string;
    expiringSoon: boolean;
    plan: { id: string; name: string } | null;
    startDate: string | null;
    endDate: string | null;
    daysLeft: number | null;
    nextStartDate: string | null;
  };
};

async function memberId(slug: string, phone: string) {
  return runInTenant(await gymId(slug), async () =>
    String((await Member.findOne({ phone }).lean())!._id),
  );
}

describeWithDb('member list: membership status, expiry and dues (real MongoDB)', () => {
  let owner: string;
  let desk: string;

  beforeAll(async () => {
    await connectTestDb(`member_list_${Date.now()}`);
  });
  afterAll(dropAndDisconnect);
  beforeEach(async () => {
    await resetDemo(mailer);
    owner = await tokenFor(PH, 'owner@powerhouse.demo');
    desk = await tokenFor(PH, 'desk@powerhouse.demo');
  });

  const list = async (query: string, token = desk, host = PH) => {
    const res = await call('get', host, `/members?sort=name${query}`, token);
    expect(res.status).toBe(200);
    return res;
  };
  const names = async (query: string, token = desk, host = PH) =>
    (await list(query, token, host)).body.data.map((r: Row) => r.name);
  const byName = async (query = '') =>
    Object.fromEntries((await list(query)).body.data.map((r: Row) => [r.name, r])) as Record<
      string,
      Row
    >;

  it('each row carries plan, expiry, days left, status and balance due, matching the profile', async () => {
    const rows = await byName();
    expect(rows['Arjun Sharma']!.membership).toMatchObject({
      status: 'active',
      expiringSoon: true,
      plan: { name: 'Monthly' },
      startDate: day(-25),
      nextStartDate: null,
    });
    expect(rows['Arjun Sharma']!.balanceDuePaise).toBe(150000 - 50000);
    expect(rows['Priya Nair']!.membership).toMatchObject({
      status: 'expired',
      expiringSoon: false,
      plan: { name: 'Quarterly' },
      daysLeft: null,
    });
    expect(rows['Priya Nair']!.balanceDuePaise).toBeGreaterThan(0);
    expect(rows['Vikram Singh']!.membership).toMatchObject({
      status: 'active',
      expiringSoon: false,
    });
    expect(rows['Vikram Singh']!.balanceDuePaise).toBe(0);
    expect(rows['Suresh Kumar']).toMatchObject({
      balanceDuePaise: 0,
      membership: {
        status: 'none',
        expiringSoon: false,
        plan: null,
        startDate: null,
        endDate: null,
        daysLeft: null,
        nextStartDate: null,
      },
    });

    // Same answer as the member profile for every row.
    for (const r of Object.values(rows)) {
      const p = (await call('get', PH, `/members/${r.id}`, desk)).body.data.membership;
      expect(r.membership.status).toBe(p.status);
      expect(r.membership.endDate).toBe(p.current?.endDate ?? null);
      expect(r.membership.daysLeft).toBe(p.current?.daysLeft ?? null);
      expect(r.membership.plan?.id ?? null).toBe(p.current?.plan.id ?? null);
      expect(r.balanceDuePaise).toBe(Math.max(0, p.current?.balancePaise ?? 0));
    }
  });

  it('filters by status and dues, with correct totals and paging', async () => {
    expect(await names('&status=active')).toEqual(['Arjun Sharma', 'Vikram Singh']);
    expect(await names('&status=expiring')).toEqual(['Arjun Sharma']);
    expect(await names('&status=expired')).toEqual(['Priya Nair']);
    expect(await names('&status=none')).toEqual(['Suresh Kumar']);
    expect(await names('&status=upcoming')).toEqual([]);
    expect(await names('&due=true')).toEqual(['Arjun Sharma', 'Priya Nair']);
    expect(await names('&due=true&status=expired')).toEqual(['Priya Nair']);
    expect(await names('&status=active&q=vik')).toEqual(['Vikram Singh']);

    const page = await list('&status=active&limit=1&page=2');
    expect(page.body.data.map((r: Row) => r.name)).toEqual(['Vikram Singh']);
    expect(page.body.meta.total).toBe(2);

    expect((await call('get', PH, '/members?status=lapsed', desk)).status).toBe(422);
    expect((await call('get', PH, '/members?due=yes', desk)).status).toBe(422);
  });

  it('renewing takes a member off "expiring"; upcoming and cancelled memberships are handled', async () => {
    const arjun = await memberId('powerhouse', ARJUN);
    const renewed = await call('post', PH, `/members/${arjun}/memberships/renew`, desk).send({});
    expect(renewed.status).toBe(201);
    const a = (await byName())['Arjun Sharma']!;
    expect(a.membership).toMatchObject({
      status: 'active',
      expiringSoon: false,
      nextStartDate: renewed.body.data.startDate,
    });
    expect(a.balanceDuePaise).toBe(100000 + renewed.body.data.totalPaise);
    expect(await names('&status=expiring')).toEqual([]);

    const suresh = await memberId('powerhouse', SURESH);
    const plan = await runInTenant(await gymId('powerhouse'), async () =>
      String((await Plan.findOne({ name: 'Monthly' }).lean())!._id),
    );
    const sold = await call('post', PH, `/members/${suresh}/memberships`, desk).send({
      planId: plan,
      startDate: day(3),
    });
    expect(sold.status).toBe(201);
    expect((await byName())['Suresh Kumar']!.membership).toMatchObject({
      status: 'upcoming',
      startDate: day(3),
      daysLeft: 3,
    });
    expect(await names('&status=upcoming')).toEqual(['Suresh Kumar']);

    const cancel = await call('post', PH, `/memberships/${sold.body.data.id}/cancel`, owner).send({
      reason: 'Changed mind',
    });
    expect(cancel.status).toBe(200);
    expect((await byName())['Suresh Kumar']).toMatchObject({
      balanceDuePaise: 0,
      membership: { status: 'none' },
    });
  });

  it('days left counts today, like a membership', async () => {
    const vikram = (await byName())['Vikram Singh']!;
    expect(vikram.membership.daysLeft).toBe(
      daysBetween(today(), parseDateOnly(vikram.membership.endDate!)!) + 1,
    );
  });

  it('members cannot list members; signed-out requests are refused', async () => {
    const member = await memberToken(PH, 'arjun@member.demo');
    expect((await call('get', PH, '/members?status=active', member)).status).toBe(403);
    expect((await call('get', PH, '/members?status=active')).status).toBe(401);
  });

  it('another gym sees only its own members, and memberships never join across gyms', async () => {
    const fzOwner = await tokenFor(FZ, 'owner@fitzone.demo');
    // A Powerhouse membership pointing at a FitZone member's id must not show up for FitZone.
    const meera = await memberId('fitzone', MEERA);
    const ph = await gymId('powerhouse');
    await runInTenant(ph, async () => {
      const copy: Record<string, unknown> = { ...(await Membership.findOne().lean())! };
      delete copy._id;
      await Membership.create({
        ...copy,
        memberId: meera,
        startDate: addDays(today(), -1),
        endDate: addDays(today(), 2),
        paidPaise: 0,
      });
    });

    expect(await names('&status=active', fzOwner, FZ)).toEqual(['Arjun Sharma']);
    expect(await names('&status=expiring', fzOwner, FZ)).toEqual([]);
    expect(await names('&due=true', fzOwner, FZ)).toEqual([]);
    expect(await names('&status=none', fzOwner, FZ)).toEqual([
      'Anita Joshi',
      'Meera Iyer',
      'Rohan Das',
    ]);
    const fzActive = (await list('&status=active', fzOwner, FZ)).body.data[0] as Row;
    expect(fzActive.id).toBe(await memberId('fitzone', ARJUN));
    expect(fzActive.membership.plan?.name).toBe('Quarterly');

    // A Powerhouse token on the FitZone host is refused outright.
    expect((await call('get', FZ, '/members?status=active', owner)).status).toBe(401);
  });
});
