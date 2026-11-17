import mongoose, { type Model } from 'mongoose';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Membership, PaymentOrder, WebhookEvent } from '../../src/db/models.js';
import { runAsPlatform, runInTenant } from '../../src/tenancy/context.js';
import { connectTestDb, describeWithDb, dropAndDisconnect } from '../helpers/db.js';
import { FZ, PH, gymId, intApp, resetDemo } from '../helpers/int.js';

/**
 * Cross-tenant guarantees for EVERY registered model, so a new model can't slip through.
 *
 * Adding a model? Put it in one of these lists. A gym-owned model must use tenantScopePlugin.
 */
const TENANT_SCOPED = [
  'Attendance',
  'AuditLog',
  'AuthToken',
  'Counter',
  'Member',
  'Membership',
  'Payment',
  'PaymentOrder',
  'Plan',
  'Session',
  'User',
  'WebhookEvent',
];
const PLATFORM_ONLY = ['JobLock', 'PlatformAdmin', 'PlatformAuditLog', 'PlatformSession', 'Tenant'];

const { mailer, call, tokenFor } = intApp();
const scopedModels = () =>
  Object.values(mongoose.models).filter((m) => m.schema.path('tenantId')) as Model<unknown>[];

describeWithDb('cross-tenant isolation for every model (real MongoDB)', () => {
  let ph: string;
  let fz: string;

  beforeAll(async () => {
    await connectTestDb(`allmodels_${Date.now()}`);
    await resetDemo(mailer);
    ph = await gymId('powerhouse');
    fz = await gymId('fitzone');
    // Put real rows for BOTH gyms in every collection: sessions + audit (logins), auth tokens
    // (email links), counters + members + member logins (registration).
    for (const [host, owner] of [
      [PH, 'owner@powerhouse.demo'],
      [FZ, 'owner@fitzone.demo'],
    ] as const) {
      const t = await tokenFor(host, owner);
      await call('post', host, '/auth/magic-link').send({ email: 'arjun@member.demo' });
      await call('post', host, '/members', t).send({
        name: 'Iso Test',
        phone: '9876500000',
        email: 'iso@member.demo',
        consent: true,
      });
    }
    // Razorpay orders and webhook events have no seed data; add one per gym directly.
    for (const gym of [ph, fz]) {
      await runInTenant(gym, async () => {
        const m = await Membership.findOne().lean();
        await PaymentOrder.create({
          membershipId: m!._id,
          memberId: m!.memberId,
          amountPaise: 1000,
          razorpayOrderId: `order_iso${gym.slice(-6)}`,
          createdVia: 'desk',
        });
        await WebhookEvent.create({ provider: 'razorpay', eventId: `evt_iso${gym.slice(-6)}` });
      });
    }
  });
  afterAll(dropAndDisconnect);

  it('every model is classified; scoped models are exactly the expected set', () => {
    const names = Object.keys(mongoose.models).sort();
    expect(names).toEqual([...TENANT_SCOPED, ...PLATFORM_ONLY].sort());
    expect(
      scopedModels()
        .map((m) => m.modelName)
        .sort(),
    ).toEqual(TENANT_SCOPED);
  });

  it('every index on a scoped model starts with tenantId (TTL indexes excepted)', async () => {
    for (const model of scopedModels()) {
      for (const [keys, opts] of model.schema.indexes()) {
        if ((opts as { expireAfterSeconds?: number }).expireAfterSeconds !== undefined) continue;
        expect(Object.keys(keys)[0], `${model.modelName} ${JSON.stringify(keys)}`).toBe('tenantId');
      }
    }
  });

  it('both gyms have data in every scoped collection (so the checks below are meaningful)', async () => {
    for (const model of scopedModels()) {
      for (const gym of [ph, fz]) {
        const n = await runInTenant(gym, () => model.countDocuments());
        expect(n, `${model.modelName} in ${gym}`).toBeGreaterThan(0);
      }
    }
  });

  it("from FitZone's scope, no model can list, count, fetch, update or delete a Powerhouse row", async () => {
    for (const model of scopedModels()) {
      const name = model.modelName;
      const phIds = await runAsPlatform('isolation test', () =>
        model.find({ tenantId: ph }).distinct('_id'),
      );
      expect(phIds.length, name).toBeGreaterThan(0);

      await runInTenant(fz, async () => {
        const listed = (await model.find({}).select('tenantId').lean()) as unknown as {
          tenantId: unknown;
        }[];
        expect(
          listed.every((d) => String(d.tenantId) === fz),
          `${name} list`,
        ).toBe(true);
        expect(await model.countDocuments({ _id: { $in: phIds } }), `${name} count`).toBe(0);
        expect(await model.findById(phIds[0]).lean(), `${name} findById`).toBeNull();
        const agg = await model.aggregate([{ $match: { _id: { $in: phIds } } }]);
        expect(agg, `${name} aggregate`).toEqual([]);
        // The audit log refuses all updates/deletes; for the rest, they must match nothing.
        if (name !== 'AuditLog') {
          const upd = await model.updateMany({ _id: { $in: phIds } }, { $inc: { __v: 0 } });
          expect(upd.matchedCount, `${name} update`).toBe(0);
          const del = await model.deleteMany({ _id: { $in: phIds } });
          expect(del.deletedCount, `${name} delete`).toBe(0);
        }
      });

      const still = await runAsPlatform('isolation test', () =>
        model.countDocuments({ _id: { $in: phIds } }),
      );
      expect(still, `${name} rows survived`).toBe(phIds.length);
      // Control: the same update DOES match these rows when allowed, so "matched 0" above is real.
      if (name !== 'AuditLog') {
        const control = await runAsPlatform('isolation test', () =>
          model.updateMany({ _id: { $in: phIds } }, { $inc: { __v: 0 } }),
        );
        expect(control.matchedCount, `${name} control`).toBe(phIds.length);
      }
    }
  });

  it('naming the other gym in a filter is refused outright, for every scoped model', async () => {
    for (const model of scopedModels()) {
      await runInTenant(fz, async () => {
        await expect(model.find({ tenantId: ph }).lean(), model.modelName).rejects.toThrow();
      });
    }
  });
});
