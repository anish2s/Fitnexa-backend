import type { Env } from '../config/env.js';
import type { Logger } from '../lib/logger.js';
import type { Mailer } from '../lib/mailer.js';
import { createAuditService } from '../modules/audit/audit.service.js';
import { createNotificationService } from '../modules/notifications/notification.service.js';
import { forEachActiveGym, type JobDef } from './runner.js';

/** The scheduled jobs. Times are UTC; per-gym logic uses each gym's own time zone. */
export function createJobs(deps: { env: Env; logger: Logger; mailer: Mailer }): JobDef[] {
  const notifications = createNotificationService({
    ...deps,
    audit: createAuditService({ logger: deps.logger }),
  });
  const total = <T extends Record<string, unknown>>(r: {
    gyms: number;
    failed: number;
    results: T[];
  }) => ({
    gyms: r.gyms,
    failedGyms: r.failed,
    results: r.results,
  });
  return [
    {
      name: 'renewal-reminders-scan',
      schedule: '15 * * * *', // hourly; idempotent
      leaseMs: 30 * 60_000,
      run: async () =>
        total(await forEachActiveGym(deps.logger, () => notifications.enqueueRenewalReminders())),
    },
    {
      name: 'notifications-dispatch',
      schedule: '*/5 * * * *',
      leaseMs: 10 * 60_000,
      run: async () => total(await forEachActiveGym(deps.logger, () => notifications.dispatch())),
    },
  ];
}
