import mongoose, { Schema, Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { TenantIsolationError } from '../../src/lib/errors.js';
import { Tenant } from '../../src/modules/tenants/tenant.model.js';
import { mongoTenantLookup } from '../../src/modules/tenants/tenant.lookup.js';
import { runAsPlatform, runInTenant } from '../../src/tenancy/context.js';
import { tenantScopePlugin } from '../../src/tenancy/tenant-scope.plugin.js';
import { connectTestDb, describeWithDb, dropAndDisconnect } from '../helpers/db.js';

/**
 * Real-database proof that Gym B can never read, change or delete Gym A's records,
 * and that per-gym uniqueness works. Uses a probe collection shaped like `members`;
 * the real Member model gets the same suite in Milestone 4.
 */
const probeSchema = new Schema({ name: String, phone: { type: String, required: true } });
probeSchema.plugin(tenantScopePlugin);
probeSchema.index({ tenantId: 1, phone: 1 }, { unique: true });
const Probe = mongoose.model('IsolationProbe', probeSchema);

describeWithDb('tenant isolation against a real MongoDB', () => {
  let gymA: Types.ObjectId;
  let gymB: Types.ObjectId;
  let aDocId: Types.ObjectId;

  beforeAll(async () => {
    await connectTestDb(`isolation_${Date.now()}`);
  });
  afterAll(dropAndDisconnect);

  beforeEach(async () => {
    await runAsPlatform('test reset', async () => {
      await Probe.deleteMany({});
      await Tenant.deleteMany({});
    });
    const [a, b] = await Tenant.create([
      { name: 'Powerhouse Fitness', slug: 'powerhouse' },
      { name: 'FitZone', slug: 'fitzone' },
    ]);
    gymA = a!._id;
    gymB = b!._id;
    const doc = await runInTenant(gymA, () =>
      Probe.create({ name: 'Ravi (Gym A)', phone: '9876543210' }),
    );
    aDocId = doc._id as Types.ObjectId;
  });

  it('Gym B cannot list or count Gym A records', async () => {
    await runInTenant(gymB, async () => {
      expect(await Probe.find({})).toHaveLength(0);
      expect(await Probe.countDocuments({})).toBe(0);
      expect(await Probe.distinct('phone')).toEqual([]);
    });
  });

  it('Gym B cannot fetch a Gym A record by id (IDOR)', async () => {
    await runInTenant(gymB, async () => {
      expect(await Probe.findById(aDocId)).toBeNull();
      expect(await Probe.findOne({ _id: aDocId })).toBeNull();
    });
  });

  it('Gym B cannot update a Gym A record', async () => {
    await runInTenant(gymB, async () => {
      const res = await Probe.updateOne({ _id: aDocId }, { $set: { name: 'hacked' } });
      expect(res.matchedCount).toBe(0);
      expect(await Probe.findOneAndUpdate({ _id: aDocId }, { name: 'hacked' })).toBeNull();
    });
    const still = await runInTenant(gymA, () => Probe.findById(aDocId).lean());
    expect(still?.name).toBe('Ravi (Gym A)');
  });

  it('Gym B cannot delete a Gym A record', async () => {
    await runInTenant(gymB, async () => {
      expect((await Probe.deleteOne({ _id: aDocId })).deletedCount).toBe(0);
      expect((await Probe.deleteMany({})).deletedCount).toBe(0);
      expect(await Probe.findOneAndDelete({ _id: aDocId })).toBeNull();
    });
    expect(await runInTenant(gymA, () => Probe.countDocuments({}))).toBe(1);
  });

  it('Gym B cannot read Gym A data through aggregation', async () => {
    const rows = await runInTenant(gymB, () => Probe.aggregate([{ $match: { _id: aDocId } }]));
    expect(rows).toHaveLength(0);
  });

  it('Gym B cannot target Gym A by naming its tenantId', async () => {
    await expect(runInTenant(gymB, () => Probe.find({ tenantId: gymA }))).rejects.toBeInstanceOf(
      TenantIsolationError,
    );
    await expect(
      // tenantId is added by the plugin at runtime, so the static schema type doesn't know it.
      runInTenant(gymB, () => Probe.create({ name: 'x', phone: '1', tenantId: gymA } as never)),
    ).rejects.toBeInstanceOf(TenantIsolationError);
  });

  it('a loaded Gym A document cannot be saved from Gym B context', async () => {
    const doc = await runInTenant(gymA, () => Probe.findById(aDocId));
    doc!.set('name', 'hacked');
    await expect(runInTenant(gymB, () => doc!.save())).rejects.toBeInstanceOf(TenantIsolationError);
  });

  it('phone is unique within a gym but may repeat across gyms', async () => {
    // Same phone in Gym B is fine.
    await expect(
      runInTenant(gymB, () => Probe.create({ name: 'Ravi (Gym B)', phone: '9876543210' })),
    ).resolves.toBeTruthy();
    // Same phone twice in Gym A is a duplicate.
    await expect(
      runInTenant(gymA, () => Probe.create({ name: 'Dup', phone: '9876543210' })),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('platform scope sees every gym, deliberately', async () => {
    await runInTenant(gymB, () => Probe.create({ name: 'B', phone: '1111111111' }));
    expect(await runAsPlatform('test: platform stats', () => Probe.countDocuments({}))).toBe(2);
  });

  it('refuses to run at all without a tenant context', async () => {
    await expect(Probe.find({})).rejects.toBeInstanceOf(TenantIsolationError);
  });
});

describeWithDb('tenant registry + lookup', () => {
  beforeAll(async () => {
    await connectTestDb(`tenants_${Date.now()}`);
  });
  afterAll(dropAndDisconnect);

  it('enforces unique, DNS-safe slugs', async () => {
    await Tenant.create({ name: 'Powerhouse', slug: 'powerhouse' });
    await expect(Tenant.create({ name: 'Copy', slug: 'powerhouse' })).rejects.toMatchObject({
      code: 11000,
    });
    await expect(Tenant.create({ name: 'Bad', slug: 'Bad_Slug!' })).rejects.toBeInstanceOf(
      mongoose.Error.ValidationError,
    );
  });

  it('looks tenants up by slug, and by custom domain only once verified', async () => {
    await Tenant.create({ name: 'FitZone', slug: 'fitzone', customDomain: 'app.fitzone.in' });
    expect((await mongoTenantLookup.bySlug('fitzone'))?.name).toBe('FitZone');
    expect(await mongoTenantLookup.byCustomDomain('app.fitzone.in')).toBeNull();

    await Tenant.updateOne({ slug: 'fitzone' }, { customDomainVerified: true });
    expect((await mongoTenantLookup.byCustomDomain('app.fitzone.in'))?.slug).toBe('fitzone');
  });

  it('applies branding and theme defaults', async () => {
    const t = await Tenant.create({ name: 'IronClub', slug: 'ironclub' });
    expect(t.branding?.defaultTheme).toBe('dark');
    expect(t.settings?.timezone).toBe('Asia/Kolkata');
    expect(t.settings?.currency).toBe('INR');
  });
});
