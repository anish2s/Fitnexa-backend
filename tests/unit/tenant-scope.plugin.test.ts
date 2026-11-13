import mongoose, { Schema, Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { TenantIsolationError } from '../../src/lib/errors.js';
import { runAsPlatform, runInTenant } from '../../src/tenancy/context.js';
import { tenantScopePlugin } from '../../src/tenancy/tenant-scope.plugin.js';

/**
 * These tests need no database. The plugin's hooks run first; a later "sentinel" hook captures the
 * final filter/pipeline/docs and aborts before anything is sent to MongoDB.
 */
class Sentinel extends Error {
  constructor(readonly captured: unknown) {
    super('sentinel');
  }
}

const schema = new Schema({ name: String, phone: String }, { bufferCommands: false });
schema.plugin(tenantScopePlugin);
const QUERY_OPS = [
  'find',
  'findOne',
  'countDocuments',
  'distinct',
  'findOneAndUpdate',
  'findOneAndDelete',
  'updateOne',
  'updateMany',
  'deleteOne',
  'deleteMany',
  'replaceOne',
] as const;
for (const op of QUERY_OPS) {
  schema.pre(op, { query: true, document: false }, function () {
    throw new Sentinel({ filter: this.getFilter(), update: this.getUpdate?.() });
  });
}
schema.pre('aggregate', function () {
  throw new Sentinel(this.pipeline());
});
schema.pre('insertMany', function (this: unknown, ...args: unknown[]) {
  throw new Sentinel(args[0]);
});

const Probe = mongoose.model('PluginProbe', schema);

const A = new Types.ObjectId();
const B = new Types.ObjectId();

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- captured shapes vary per operation
async function captured(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (e) {
    if (e instanceof Sentinel) return e.captured;
    throw e;
  }
  throw new Error('expected the operation to be intercepted');
}

describe('tenantScopePlugin — queries', () => {
  it('forces tenantId into every query filter', async () => {
    const cases: Array<() => Promise<unknown>> = [
      () => Probe.find({ name: 'x' }).exec(),
      () => Probe.findOne({ _id: new Types.ObjectId() }).exec(),
      () => Probe.findById(new Types.ObjectId()).exec(),
      () => Probe.countDocuments({}).exec(),
      () => Probe.distinct('phone').exec(),
      () => Probe.updateOne({ name: 'x' }, { $set: { name: 'y' } }).exec(),
      () => Probe.updateMany({}, { $set: { name: 'y' } }).exec(),
      () => Probe.deleteOne({ name: 'x' }).exec(),
      () => Probe.deleteMany({}).exec(),
      () => Probe.findOneAndUpdate({ name: 'x' }, { name: 'y' }).exec(),
      () => Probe.findOneAndDelete({ name: 'x' }).exec(),
    ];
    for (const run of cases) {
      const { filter } = await runInTenant(A, () => captured(run()));
      expect(filter.tenantId).toBeInstanceOf(Types.ObjectId);
      expect((filter.tenantId as Types.ObjectId).equals(A)).toBe(true);
    }
  });

  it('cannot be widened by a client-style $or or $ne filter', async () => {
    const { filter } = await runInTenant(A, () =>
      captured(Probe.find({ $or: [{ name: 'x' }, { name: { $ne: null } }] }).exec()),
    );
    // tenantId is ANDed at the top level, outside any $or the caller wrote.
    expect((filter.tenantId as Types.ObjectId).equals(A)).toBe(true);
    expect(filter.$or).toHaveLength(2);
  });

  it('rejects a filter that names a different tenant', async () => {
    await expect(runInTenant(A, () => Probe.find({ tenantId: B }).exec())).rejects.toBeInstanceOf(
      TenantIsolationError,
    );
    await expect(
      runInTenant(A, () => Probe.find({ tenantId: B.toHexString() }).exec()),
    ).rejects.toBeInstanceOf(TenantIsolationError);
  });

  it('allows a filter that names the same tenant', async () => {
    const { filter } = await runInTenant(A, () => captured(Probe.find({ tenantId: A }).exec()));
    expect((filter.tenantId as Types.ObjectId).equals(A)).toBe(true);
  });

  it('rejects updates that try to move a document to another tenant', async () => {
    for (const update of [
      { $set: { tenantId: B } },
      { tenantId: B },
      { $unset: { tenantId: 1 } },
    ]) {
      await expect(
        runInTenant(A, () => Probe.updateOne({}, update as never).exec()),
      ).rejects.toBeInstanceOf(TenantIsolationError);
    }
  });

  it('fails closed when there is no tenant context at all', async () => {
    await expect(Probe.find({}).exec()).rejects.toBeInstanceOf(TenantIsolationError);
    await expect(Probe.deleteMany({}).exec()).rejects.toBeInstanceOf(TenantIsolationError);
    await expect(Probe.aggregate([]).exec()).rejects.toBeInstanceOf(TenantIsolationError);
  });

  it('does not inject in explicit platform scope', async () => {
    const { filter } = await runAsPlatform('test: cross-gym report', () =>
      captured(Probe.find({}).exec()),
    );
    expect(filter.tenantId).toBeUndefined();
  });

  it('only allows unscopeable operations in platform scope', async () => {
    await expect(
      runInTenant(A, () => Probe.estimatedDocumentCount().exec()),
    ).rejects.toBeInstanceOf(TenantIsolationError);
  });
});

describe('tenantScopePlugin — aggregate', () => {
  it('prepends a $match on tenantId', async () => {
    const pipeline = await runInTenant(A, () =>
      captured(Probe.aggregate([{ $group: { _id: null, n: { $sum: 1 } } }]).exec()),
    );
    expect(pipeline).toHaveLength(2);
    expect((pipeline[0].$match.tenantId as Types.ObjectId).equals(A)).toBe(true);
  });
});

describe('tenantScopePlugin — writes', () => {
  it('stamps new documents with the context tenant', async () => {
    const doc = new Probe({ name: 'Ravi' });
    await runInTenant(A, () => doc.validate());
    expect((doc.get('tenantId') as Types.ObjectId).equals(A)).toBe(true);
  });

  it('rejects a new document that claims another tenant', async () => {
    const doc = new Probe({ name: 'Ravi', tenantId: B });
    await expect(runInTenant(A, () => doc.validate())).rejects.toBeInstanceOf(TenantIsolationError);
  });

  it('rejects writes with no tenant context', async () => {
    await expect(new Probe({ name: 'Ravi' }).validate()).rejects.toBeInstanceOf(
      TenantIsolationError,
    );
  });

  it('requires an explicit tenantId for platform-scope writes', async () => {
    await expect(
      runAsPlatform('seed', () => new Probe({ name: 'x' }).validate()),
    ).rejects.toBeInstanceOf(TenantIsolationError);
    await expect(
      runAsPlatform('seed', () => new Probe({ name: 'x', tenantId: B }).validate()),
    ).resolves.toBeUndefined();
  });

  it('stamps insertMany documents and rejects foreign ones', async () => {
    const docs = await runInTenant(A, () =>
      captured(Probe.insertMany([{ name: 'a' }, { name: 'b' }])),
    );
    for (const d of docs) expect((d.tenantId as Types.ObjectId).equals(A)).toBe(true);

    await expect(
      runInTenant(A, () => Probe.insertMany([{ name: 'a' }, { name: 'b', tenantId: B }])),
    ).rejects.toBeInstanceOf(TenantIsolationError);
  });

  it('makes tenantId immutable on existing documents', () => {
    const doc = Probe.hydrate({ _id: new Types.ObjectId(), name: 'x', tenantId: A });
    doc.set('tenantId', B);
    expect((doc.get('tenantId') as Types.ObjectId).equals(A)).toBe(true);
  });
});
