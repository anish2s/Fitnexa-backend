import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { Attendance, Member, Plan } from '../../src/db/models.js';
import { addDays, formatDateOnly, parseDateOnly, todayIn } from '../../src/lib/dates.js';
import { createPassSigner, qrMasterSecret } from '../../src/modules/attendance/qr-pass.js';
import { runInTenant } from '../../src/tenancy/context.js';
import { testEnv } from '../helpers/app.js';
import { connectTestDb, describeWithDb, dropAndDisconnect } from '../helpers/db.js';
import { FZ, PH, gymId, intApp, resetDemo } from '../helpers/int.js';

const { mailer, call, tokenFor, memberToken } = intApp();
// Same master secret as the app under test, to mint passes at chosen times.
const signer = createPassSigner(qrMasterSecret(testEnv()));

const ARJUN = '+919811111111'; // active, visited yesterday
const PRIYA = '+919811111112'; // expired
const VIKRAM = '+919811111113'; // active, visited today, yesterday, day before
const SURESH = '+919833333331'; // no membership

const today = () => todayIn('Asia/Kolkata');
const day = (offset: number) => formatDateOnly(addDays(parseDateOnly(today())!, offset))!;
async function memberId(phone: string, slug = 'powerhouse') {
  return runInTenant(await gymId(slug), async () =>
    String((await Member.findOne({ phone }).lean())!._id),
  );
}

describeWithDb('attendance (real MongoDB)', () => {
  let owner: string;
  let desk: string;

  beforeAll(async () => {
    await connectTestDb(`attendance_${Date.now()}`);
  });
  afterAll(dropAndDisconnect);
  beforeEach(async () => {
    await resetDemo(mailer);
    owner = await tokenFor(PH, 'owner@powerhouse.demo');
    desk = await tokenFor(PH, 'desk@powerhouse.demo');
  });

  const scan = (token: string, as = desk, host = PH) =>
    call('post', host, '/attendance/scan', as).send({ token });
  const manual = (mid: string, as = desk, host = PH) =>
    call('post', host, '/attendance/manual', as).send({ memberId: mid });

  // ---------------------------------------------------------------- QR flow
  it('member shows the pass, desk scans: checked in with photo, plan and dues; a second scan is a no-op', async () => {
    const me = await memberToken(PH, 'arjun@member.demo');
    const before = Date.now();
    const pass = await call('get', PH, '/members/me/pass', me);
    expect(pass.status).toBe(200);
    // The server's clock, so the app can correct for a phone clock that is fast or slow.
    const serverTime = Date.parse(pass.body.data.serverTime);
    expect(serverTime).toBeGreaterThanOrEqual(before);
    expect(serverTime).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(pass.body.data.refreshAt)).toBeGreaterThan(serverTime);
    expect(Date.parse(pass.body.data.validUntil)).toBeGreaterThan(
      Date.parse(pass.body.data.refreshAt),
    );
    expect(pass.headers['cache-control']).toBe('no-store');
    expect(pass.body.data).toMatchObject({
      member: { name: 'Arjun Sharma', memberCode: 'M0001' },
      membershipStatus: 'active',
      checkedInToday: null,
    });

    const first = await scan(pass.body.data.token);
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({
      status: 'checked_in',
      checkIn: { day: today(), method: 'qr' },
      member: { name: 'Arjun Sharma', memberCode: 'M0001', photoUrl: null },
      membership: { plan: 'Monthly', balancePaise: 100000, paymentStatus: 'partial' },
    });
    const again = await scan(pass.body.data.token);
    expect(again.status).toBe(200);
    expect(again.body.data.status).toBe('already_checked_in');
    expect(again.body.data.checkIn.id).toBe(first.body.data.checkIn.id);

    const passAfter = await call('get', PH, '/members/me/pass', me);
    expect(passAfter.body.data.checkedInToday).toBeTruthy();
  });

  it('parallel scans of one pass create exactly one check-in', async () => {
    const { token } = signer.issue(await gymId('powerhouse'), await memberId(ARJUN));
    const results = await Promise.all(Array.from({ length: 6 }, () => scan(token)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(5);
    const n = await runInTenant(await gymId('powerhouse'), async () =>
      Attendance.countDocuments({ memberId: await memberId(ARJUN), day: today() }),
    );
    expect(n).toBe(1);
  });

  it('expired, forged, malformed and other-gym passes are refused', async () => {
    const ph = await gymId('powerhouse');
    const arjun = await memberId(ARJUN);
    const old = signer.issue(ph, arjun, Date.now() - 5 * 60_000).token;
    const expired = await scan(old);
    expect(expired.status).toBe(400);
    expect(expired.body.error.code).toBe('PASS_EXPIRED');

    const { token } = signer.issue(ph, arjun);
    const forged = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA');
    expect((await scan(forged)).body.error.code).toBe('PASS_INVALID');
    expect((await scan('https://evil.example/qr-code')).body.error.code).toBe('PASS_INVALID');
    expect((await call('post', PH, '/attendance/scan', desk).send({})).status).toBe(422);

    // A FitZone pass at Powerhouse: same person even, different gym key.
    const fzPass = signer.issue(await gymId('fitzone'), await memberId(ARJUN, 'fitzone')).token;
    expect((await scan(fzPass)).body.error.code).toBe('PASS_INVALID');
    expect(await runInTenant(ph, () => Attendance.countDocuments({ day: today() }))).toBe(1); // only Vikram's seed
  });

  // ---------------------------------------------------------------- admission rules
  it('no active membership: says why (expired on / starts on / none); archived members refused', async () => {
    const expired = await manual(await memberId(PRIYA));
    expect(expired.status).toBe(409);
    expect(expired.body.error).toMatchObject({
      code: 'NO_ACTIVE_MEMBERSHIP',
      details: { reason: 'expired' },
    });
    expect(expired.body.error.message).toMatch(/^Membership expired on \d{4}-\d{2}-\d{2}$/);

    const suresh = await memberId(SURESH);
    expect((await manual(suresh)).body.error.details).toEqual({ reason: 'none', date: null });
    const plan = await runInTenant(await gymId('powerhouse'), async () =>
      String((await Plan.findOne({ name: 'Monthly' }).lean())!._id),
    );
    await call('post', PH, `/members/${suresh}/memberships`, desk).send({
      planId: plan,
      startDate: day(5),
    });
    expect((await manual(suresh)).body.error.details).toEqual({ reason: 'upcoming', date: day(5) });

    const arjun = await memberId(ARJUN);
    await call('post', PH, `/members/${arjun}/archive`, owner);
    expect((await manual(arjun)).status).toBe(409);
    // Unknown member id.
    expect((await manual('64b0000000000000000000ff')).status).toBe(404);
  });

  it('manual check-in works like a scan and is recorded as manual', async () => {
    const res = await manual(await memberId(ARJUN));
    expect(res.status).toBe(201);
    expect(res.body.data.checkIn.method).toBe('manual');
    expect((await manual(await memberId(VIKRAM))).body.data.status).toBe('already_checked_in');
  });

  // ---------------------------------------------------------------- lists & report
  it("today's list, a past day, a member's history and the member's own history", async () => {
    await manual(await memberId(ARJUN));
    const todayList = await call('get', PH, '/attendance', desk);
    expect(todayList.body.meta).toMatchObject({ date: today(), total: 2 });
    expect(
      todayList.body.data.map((r: { member: { name: string } }) => r.member.name).sort(),
    ).toEqual(['Arjun Sharma', 'Vikram Singh']);
    const yesterday = await call('get', PH, `/attendance?date=${day(-1)}`, desk);
    expect(yesterday.body.meta.total).toBe(2);

    const vikram = await memberId(VIKRAM);
    const hist = await call('get', PH, `/members/${vikram}/attendance`, desk);
    expect(hist.body.data.map((r: { day: string }) => r.day)).toEqual([day(0), day(-1), day(-2)]);
    const ranged = await call(
      'get',
      PH,
      `/members/${vikram}/attendance?from=${day(-1)}&to=${day(-1)}`,
      desk,
    );
    expect(ranged.body.meta.total).toBe(1);

    const me = await memberToken(PH, 'vikram@member.demo');
    const mine = await call('get', PH, '/members/me/attendance', me);
    expect(mine.body.meta.total).toBe(3);
  });

  it('daily report: totals, QR vs manual, busy hours, share of active members', async () => {
    await manual(await memberId(ARJUN));
    const res = await call('get', PH, '/attendance/report', owner);
    expect(res.status).toBe(200);
    const r = res.body.data;
    expect(r).toMatchObject({
      date: today(),
      total: 2,
      byMethod: { qr: 1, manual: 1 },
      activeMembers: 2,
      attendanceRate: 1,
    });
    expect(r.byHour).toHaveLength(24);
    expect(r.byHour[7].count).toBeGreaterThanOrEqual(1); // Vikram's seeded 7 am visit
    expect(r.byHour.reduce((a: number, h: { count: number }) => a + h.count, 0)).toBe(2);

    const past = await call('get', PH, `/attendance/report?date=${day(-2)}`, owner);
    expect(past.body.data).toMatchObject({ total: 1, busiestHour: 7 });
    expect((await call('get', PH, '/attendance/report?date=17-11-2026', owner)).status).toBe(422);
  });

  // ---------------------------------------------------------------- authorization
  it('members get a pass and their own history only; staff have no pass; anonymous nothing', async () => {
    const me = await memberToken(PH, 'arjun@member.demo');
    const { token } = signer.issue(await gymId('powerhouse'), await memberId(ARJUN));
    expect((await scan(token, me)).status).toBe(403); // can't check themselves in
    expect((await manual(await memberId(ARJUN), me)).status).toBe(403);
    expect((await call('get', PH, '/attendance', me)).status).toBe(403);
    expect((await call('get', PH, '/attendance/report', me)).status).toBe(403);
    expect(
      (await call('get', PH, `/members/${await memberId(VIKRAM)}/attendance`, me)).status,
    ).toBe(403);
    expect((await call('get', PH, '/members/me/pass', desk)).status).toBe(403);
    expect((await call('get', PH, '/members/me/pass')).status).toBe(401);
    expect((await call('post', PH, '/attendance/scan').send({ token })).status).toBe(401);
  });

  // ---------------------------------------------------------------- cross-tenant
  it("cross-tenant: FitZone can't check in, list or read Powerhouse attendance", async () => {
    const fzDesk = await tokenFor(FZ, 'desk@fitzone.demo');
    const phArjun = await memberId(ARJUN);
    expect((await manual(phArjun, fzDesk, FZ)).status).toBe(404);
    // A valid Powerhouse pass scanned at FitZone's desk.
    const phPass = signer.issue(await gymId('powerhouse'), phArjun).token;
    expect((await scan(phPass, fzDesk, FZ)).body.error.code).toBe('PASS_INVALID');
    const fzToday = await call('get', FZ, '/attendance', fzDesk);
    expect(fzToday.body.data.map((r: { member: { name: string } }) => r.member.name)).toEqual([
      'Arjun Sharma',
    ]);
    expect((await call('get', FZ, `/members/${phArjun}/attendance`, fzDesk)).status).toBe(404);
    expect((await call('get', PH, '/attendance', fzDesk)).status).toBe(401);
    expect(
      await runInTenant(await gymId('powerhouse'), () =>
        Attendance.countDocuments({ day: today() }),
      ),
    ).toBe(1);
  });
});
