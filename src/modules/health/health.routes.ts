import { Router } from 'express';

/**
 * /health – liveness: the process is up (used by the platform to restart a dead process).
 * /ready  – readiness: dependencies reachable (used to stop routing traffic while the DB is down).
 */
export function healthRouter(isDbReady: () => boolean) {
  const router = Router();
  router.get('/health', (_req, res) => {
    res.json({ success: true, data: { status: 'ok', uptimeSec: Math.round(process.uptime()) } });
  });
  router.get('/ready', (_req, res) => {
    const db = isDbReady();
    res.status(db ? 200 : 503).json({
      success: db,
      data: { status: db ? 'ready' : 'not_ready', checks: { database: db ? 'up' : 'down' } },
    });
  });
  return router;
}
