import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { AuditLog, Tenant } from '../../src/db/models.js';
import { connectRazorpay } from '../../src/scripts/connect-razorpay.js';
import { runAsPlatform, runInTenant } from '../../src/tenancy/context.js';
import { testEnv } from '../helpers/app.js';
import { connectTestDb, describeWithDb, dropAndDisconnect } from '../helpers/db.js';
import { gymId, resetDemo } from '../helpers/int.js';

const env = testEnv({ PAYMENTS_ENCRYPTION_KEY: randomBytes(32).toString('base64') });
const keys = {
  keyId: 'rzp_test_Script1234567',
  keySecret: 'ScriptKeySecret1234567890',
  webhookSecret: 'abcdef0123456789',
};

describeWithDb('razorpay:connect script (real MongoDB)', () => {
  beforeAll(async () => {
    await connectTestDb(`rzpconnect_${Date.now()}`);
  });
  afterAll(dropAndDisconnect);
  beforeEach(async () => {
    await resetDemo();
  });

  it('stores the keys for that gym only, encrypted, and audited', async () => {
    const s = await connectRazorpay(env, 'powerhouse', keys);
    expect(s.razorpay).toMatchObject({ connected: true, mode: 'test', keyId: keys.keyId });
    const t = await runAsPlatform('test', () =>
      Tenant.findOne({ slug: 'powerhouse' }).select('+razorpay.keySecretEnc').lean(),
    );
    expect(t!.razorpay!.keySecretEnc).toMatch(/^v1\./);
    expect(JSON.stringify(t)).not.toContain(keys.keySecret);
    const fz = await runAsPlatform('test', () => Tenant.findOne({ slug: 'fitzone' }).lean());
    expect(fz!.razorpay?.keyId).toBeUndefined();
    const log = await runInTenant(await gymId('powerhouse'), () =>
      AuditLog.findOne({ action: 'gym.payment_gateway_update' }).lean(),
    );
    expect(log!.actor).toMatchObject({ type: 'system', name: 'razorpay:connect script' });
  });

  it('refuses live keys, bad formats and unknown gyms', async () => {
    await expect(
      connectRazorpay(env, 'powerhouse', { ...keys, keyId: 'rzp_live_Script1234567' }),
    ).rejects.toThrow(/Live keys/);
    await expect(
      connectRazorpay(env, 'powerhouse', { ...keys, keySecret: 'short' }),
    ).rejects.toThrow(/keySecret/);
    await expect(connectRazorpay(env, 'nosuchgym', keys)).rejects.toThrow(/No gym/);
  });
});
