import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { Member } from '../../src/db/models.js';
import { runInTenant } from '../../src/tenancy/context.js';
import { connectTestDb, describeWithDb, dropAndDisconnect } from '../helpers/db.js';
import { FZ, PH, gymId, intApp, resetDemo } from '../helpers/int.js';

const { mailer, call, tokenFor, memberToken } = intApp();
async function memberId(phone: string) {
  return runInTenant(await gymId('powerhouse'), async () =>
    String((await Member.findOne({ phone }).lean())!._id),
  );
}
const textOf = (url: string) => new URL(url).searchParams.get('text')!;

describeWithDb('WhatsApp links (real MongoDB)', () => {
  let desk: string;
  beforeAll(async () => {
    await connectTestDb(`whatsapp_${Date.now()}`);
  });
  afterAll(dropAndDisconnect);
  beforeEach(async () => {
    await resetDemo(mailer);
    desk = await tokenFor(PH, 'desk@powerhouse.demo');
  });
  const link = (id: string, qs: string, token = desk, host = PH) =>
    call('get', host, `/members/${id}/whatsapp${qs}`, token);

  it('renewal, payment due and welcome messages for a member, as wa.me links', async () => {
    const arjun = await memberId('+919811111111');
    const r = await link(arjun, '?template=renewal');
    expect(r.status).toBe(200);
    expect(r.body.data.url.startsWith('https://wa.me/919811111111?text=')).toBe(true);
    expect(textOf(r.body.data.url)).toMatch(
      /^Hi Arjun, your Monthly membership at Powerhouse Fitness ends on \d{1,2} \w{3} \d{4}\./,
    );
    expect(textOf((await link(arjun, '?template=payment_due')).body.data.url)).toContain(
      'a balance of ₹1,000 is due',
    );
    expect(textOf((await link(arjun, '?template=welcome')).body.data.url)).toContain('M0001');

    const priya = await memberId('+919811111112');
    expect(textOf((await link(priya, '?template=renewal')).body.data.url)).toContain('ended on');
  });

  it('custom text; 409 when nothing applies; 422 for bad input', async () => {
    const vikram = await memberId('+919811111113'); // fully paid
    expect((await link(vikram, '?template=payment_due')).status).toBe(409);
    const suresh = await memberId('+919833333331'); // no membership
    expect((await link(suresh, '?template=renewal')).status).toBe(409);
    expect(
      textOf(
        (await link(suresh, '?template=custom&text=Gym%20closed%20on%20Sunday')).body.data.url,
      ),
    ).toBe('Gym closed on Sunday');
    expect((await link(suresh, '?template=custom')).status).toBe(422);
    expect((await link(suresh, '?template=spam')).status).toBe(422);
  });

  it('the expiring-soon list carries a ready renewal link per member', async () => {
    const res = await call('get', PH, '/memberships/expiring', desk);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].whatsappUrl).toMatch(
      /^https:\/\/wa\.me\/919811111111\?text=Hi%20Arjun/,
    );
  });

  it('members, anonymous and other gyms are refused', async () => {
    const arjun = await memberId('+919811111111');
    const me = await memberToken(PH, 'arjun@member.demo');
    expect((await link(arjun, '?template=welcome', me)).status).toBe(403);
    expect((await call('get', PH, `/members/${arjun}/whatsapp?template=welcome`)).status).toBe(401);
    const fz = await tokenFor(FZ, 'desk@fitzone.demo');
    expect((await link(arjun, '?template=welcome', fz, FZ)).status).toBe(404);
  });
});
