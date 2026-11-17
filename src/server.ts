import { getEnv } from './config/env.js';
import { connectDatabase, disconnectDatabase, isDatabaseReady } from './db/connection.js';
import { createApp } from './app.js';
import { createLogger } from './lib/logger.js';
import { createMailer } from './lib/mailer.js';
import { mongoTenantLookup } from './modules/tenants/tenant.lookup.js';

async function main() {
  const env = getEnv();
  const logger = createLogger(env.LOG_LEVEL);

  await connectDatabase(env.MONGODB_URI, logger);

  const app = createApp({
    env,
    logger,
    tenantLookup: mongoTenantLookup,
    isDbReady: isDatabaseReady,
    mailer: createMailer(env, logger),
  });
  const server = app.listen(env.PORT, () => logger.info({ port: env.PORT }, 'API listening'));

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    server.close(async () => {
      await disconnectDatabase();
      process.exit(0);
    });
    // Hard stop if connections don't drain.
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.error({ reason }, 'Unhandled rejection'));
}

main().catch((err) => {
  // Logger may not exist yet (bad env); write directly so the failure is visible.
  process.stderr.write(
    `Fatal startup error: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
