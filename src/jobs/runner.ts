import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import cron from 'node-cron';
import type { Logger } from '../lib/logger.js';
import { Tenant } from '../modules/tenants/tenant.model.js';
import { runAsPlatform, runInTenant } from '../tenancy/context.js';
import { JobLock } from './job-lock.model.js';

/** Identifies this process in lock documents (useful when debugging a stuck lease). */
export const INSTANCE_ID = `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`;

const isDuplicate = (e: unknown) => (e as { code?: number })?.code === 11000;

/**
 * Runs `fn` only if this instance can take the job's lease. Returns 'skipped' when another
 * instance holds it. The lease must outlast a normal run; it's released (and the result recorded)
 * when the run ends, success or failure.
 */
export async function withLease<T>(
  name: string,
  leaseMs: number,
  fn: () => Promise<T>,
  owner = INSTANCE_ID,
): Promise<{ status: 'ran'; result: T } | { status: 'skipped' }> {
  const now = new Date();
  try {
    await JobLock.findOneAndUpdate(
      { _id: name, $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }] },
      { $set: { lockedUntil: new Date(now.getTime() + leaseMs), owner, lastStartedAt: now } },
      // Upsert creates the first lock; if the job exists and is locked, the upsert's insert
      // collides on _id and we know someone else holds it.
      { upsert: true },
    );
  } catch (err) {
    if (isDuplicate(err)) return { status: 'skipped' };
    throw err;
  }
  try {
    const result = await fn();
    await JobLock.updateOne(
      { _id: name, owner },
      {
        $set: { lockedUntil: null, lastFinishedAt: new Date(), lastSummary: result ?? null },
        $unset: { lastError: 1 },
      },
    );
    return { status: 'ran', result };
  } catch (err) {
    await JobLock.updateOne(
      { _id: name, owner },
      {
        $set: {
          lockedUntil: null,
          lastFinishedAt: new Date(),
          lastError: String((err as Error)?.message ?? err).slice(0, 1000),
        },
      },
    );
    throw err;
  }
}

export interface GymRef {
  _id: string;
  slug: string;
  name: string;
}

/**
 * Runs `fn` once per active gym, inside that gym's tenant scope. One gym failing is logged and
 * doesn't stop the others. Suspended and archived gyms are skipped.
 */
export async function forEachActiveGym<T>(
  logger: Logger,
  fn: (gym: GymRef) => Promise<T>,
): Promise<{ gyms: number; failed: number; results: T[] }> {
  const gyms = await runAsPlatform('scheduled job: list active gyms', () =>
    Tenant.find({ status: 'active' }).select('_id slug name').lean(),
  );
  let failed = 0;
  const results: T[] = [];
  for (const g of gyms) {
    const ref = { _id: String(g._id), slug: g.slug, name: g.name };
    try {
      results.push(await runInTenant(g._id, () => fn(ref)));
    } catch (err) {
      failed += 1;
      logger.error({ err, gym: ref.slug }, 'Scheduled job failed for a gym');
    }
  }
  return { gyms: gyms.length, failed, results };
}

export interface JobDef {
  name: string;
  /** Standard 5-field cron expression, evaluated in UTC. */
  schedule: string;
  leaseMs: number;
  run: () => Promise<unknown>;
}

/** Starts cron schedules; each tick takes the job's lease first. Returns a stop function. */
export function startScheduler(jobs: JobDef[], logger: Logger): () => Promise<void> {
  const tasks = jobs.map((job) =>
    cron.schedule(
      job.schedule,
      async () => {
        try {
          const r = await withLease(job.name, job.leaseMs, job.run);
          if (r.status === 'ran') logger.info({ job: job.name, summary: r.result }, 'Job finished');
        } catch (err) {
          logger.error({ err, job: job.name }, 'Job failed');
        }
      },
      { timezone: 'UTC', name: job.name, noOverlap: true },
    ),
  );
  logger.info({ jobs: jobs.map((j) => `${j.name} (${j.schedule})`) }, 'Scheduler started');
  return async () => {
    await Promise.all(tasks.map((t) => t.stop()));
  };
}
