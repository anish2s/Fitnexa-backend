import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { JobLock, Member, Tenant } from '../../src/db/models.js';
import { createLogger } from '../../src/lib/logger.js';
import { forEachActiveGym, withLease } from '../../src/jobs/runner.js';
import { runAsPlatform } from '../../src/tenancy/context.js';
import { connectTestDb, describeWithDb, dropAndDisconnect } from '../helpers/db.js';
import { resetDemo } from '../helpers/int.js';

const logger = createLogger('silent');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeWithDb('job runner (real MongoDB)', () => {
  beforeAll(async () => {
    await connectTestDb(`jobs_${Date.now()}`);
  });
  afterAll(dropAndDisconnect);
  beforeEach(async () => {
    await resetDemo();
  });

  it('five instances ticking at once: exactly one runs the job', async () => {
    let runs = 0;
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        withLease(
          'test-job',
          60_000,
          async () => {
            runs += 1;
            await sleep(100);
            return { ok: true };
          },
          `instance-${i}`,
        ),
      ),
    );
    expect(runs).toBe(1);
    expect(results.filter((r) => r.status === 'ran')).toHaveLength(1);
    const lock = await JobLock.findById('test-job').lean();
    expect(lock).toMatchObject({ lockedUntil: null, lastSummary: { ok: true } });
    // Released: the next tick runs again.
    expect((await withLease('test-job', 60_000, async () => 1)).status).toBe('ran');
  });

  it("a live lease blocks other instances; an expired one (crashed holder) doesn't", async () => {
    await JobLock.create({
      _id: 'held',
      lockedUntil: new Date(Date.now() + 60_000),
      owner: 'other',
    });
    expect((await withLease('held', 60_000, async () => 1)).status).toBe('skipped');
    await JobLock.updateOne({ _id: 'held' }, { $set: { lockedUntil: new Date(Date.now() - 1) } });
    expect((await withLease('held', 60_000, async () => 1)).status).toBe('ran');
  });

  it('a failing run records the error and releases the lease', async () => {
    await expect(
      withLease('flaky', 60_000, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await JobLock.findById('flaky').lean()).toMatchObject({
      lockedUntil: null,
      lastError: 'boom',
    });
    expect((await withLease('flaky', 60_000, async () => 'fine')).status).toBe('ran');
    expect((await JobLock.findById('flaky').lean())!.lastError).toBeUndefined();
  });

  it('runs per active gym in that gym scope; skips suspended gyms; one failure does not stop others', async () => {
    const seen = await forEachActiveGym(logger, async (g) => ({
      slug: g.slug,
      members: await Member.countDocuments(),
    }));
    expect(seen.gyms).toBe(2);
    expect(seen.results.sort((a, b) => a.slug.localeCompare(b.slug))).toEqual([
      { slug: 'fitzone', members: 4 },
      { slug: 'powerhouse', members: 4 },
    ]);

    await runAsPlatform('test', () =>
      Tenant.updateOne({ slug: 'fitzone' }, { status: 'suspended' }),
    );
    const one = await forEachActiveGym(logger, async (g) => g.slug);
    expect(one.results).toEqual(['powerhouse']);

    await runAsPlatform('test', () => Tenant.updateOne({ slug: 'fitzone' }, { status: 'active' }));
    const partial = await forEachActiveGym(logger, async (g) => {
      if (g.slug === 'fitzone') throw new Error('gym-specific failure');
      return g.slug;
    });
    expect(partial).toMatchObject({ gyms: 2, failed: 1, results: ['powerhouse'] });
  });
});
