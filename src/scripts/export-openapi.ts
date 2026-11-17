import { writeFileSync } from 'node:fs';
import { createApp } from '../app.js';
import { parseEnv } from '../config/env.js';
import { createLogger } from '../lib/logger.js';
import { memoryMailer } from '../lib/mailer.js';
import { buildOpenApi, type MountedRouter } from '../openapi/generate.js';
import { PACKAGE_VERSION } from '../openapi/assets.js';

/**
 * Writes docs/openapi.json from the app's routers (no database needed). Run after changing routes:
 * `npm run openapi`. A test fails if the committed file is out of date.
 */
export function currentSpec() {
  const app = createApp({
    env: parseEnv({
      MONGODB_URI: 'mongodb://unused',
      BASE_DOMAINS: 'yourapp.in',
      JWT_ACCESS_SECRET: 'openapi-export-only-'.padEnd(48, 'x'),
    }),
    logger: createLogger('silent'),
    tenantLookup: { bySlug: async () => null, byCustomDomain: async () => null },
    isDbReady: () => false,
    mailer: memoryMailer(),
    images: null,
  });
  return buildOpenApi(app.locals.mounts as MountedRouter[], { version: PACKAGE_VERSION });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = new URL('../../docs/openapi.json', import.meta.url);
  writeFileSync(out, JSON.stringify(currentSpec(), null, 2) + '\n');
  process.stdout.write(`wrote ${out.pathname}\n`);
}
