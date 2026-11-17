import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import { getEnv, type Env } from '../config/env.js';
import '../db/models.js';
import { AppError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { createAuditService } from '../modules/audit/audit.service.js';
import { createGatewayService } from '../modules/payments/gateway.service.js';
import { gatewayKeysBody } from '../modules/payments/payment.schemas.js';
import { httpRazorpayClient } from '../modules/payments/razorpay.client.js';
import { Tenant } from '../modules/tenants/tenant.model.js';
import { runAsPlatform, runInTenant } from '../tenancy/context.js';

/**
 * Connects a gym's Razorpay account from the terminal, until the dashboard has a settings screen:
 *
 *   npm run razorpay:connect -- --gym powerhouse
 *
 * Asks for the Key Id and (hidden) Key Secret, generates a webhook secret unless
 * RAZORPAY_WEBHOOK_SECRET is set, and stores them exactly like the API does: encrypted, audited.
 * The secret never goes on the command line, so it can't end up in shell history.
 */
export async function connectRazorpay(
  env: Env,
  slug: string,
  keys: { keyId: string; keySecret: string; webhookSecret: string },
) {
  const parsed = gatewayKeysBody.safeParse(keys);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  const gym = await runAsPlatform('razorpay:connect script', () =>
    Tenant.findOne({ slug }).select('_id').lean(),
  );
  if (!gym) throw new Error(`No gym with subdomain "${slug}"`);
  const logger = createLogger('silent');
  const gateway = createGatewayService({
    env,
    logger,
    audit: createAuditService({ logger }),
    razorpay: httpRazorpayClient(),
  });
  try {
    return await runInTenant(gym._id, () =>
      gateway.setKeys(parsed.data, { actor: { type: 'system', name: 'razorpay:connect script' } }),
    );
  } catch (err) {
    // Show the person at the terminal the actual reason, not just "validation failed".
    if (err instanceof AppError && Array.isArray(err.details)) {
      throw new Error((err.details as { message: string }[]).map((d) => d.message).join('; '), {
        cause: err,
      });
    }
    throw err;
  }
}

function ask(question: string, hidden = false): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    // Echo nothing while the secret is typed or pasted.
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      if (s.includes(question)) process.stdout.write(question);
    };
  }
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    }),
  );
}

async function main() {
  const i = process.argv.indexOf('--gym');
  const slug = i > 0 ? process.argv[i + 1] : undefined;
  if (!slug) throw new Error('Usage: npm run razorpay:connect -- --gym <subdomain>');
  const env = getEnv();
  await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
  try {
    const keyId = await ask('Test API Key (rzp_test_...): ');
    const keySecret = await ask('Test Key Secret (hidden): ', true);
    const generated = !process.env.RAZORPAY_WEBHOOK_SECRET;
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET ?? randomBytes(16).toString('hex');
    const settings = await connectRazorpay(env, slug, { keyId, keySecret, webhookSecret });
    const r = settings.razorpay;
    process.stdout.write(
      `\nConnected ${slug}: ${r.connected ? 'yes' : 'no'}, mode ${r.mode}, key ${r.keyId}\n` +
        `Webhook URL (add in Razorpay once deployed): ${r.webhookUrl}\n` +
        (generated
          ? `Webhook secret (shown once; paste the same value in Razorpay → Webhooks): ${webhookSecret}\n`
          : ''),
    );
  } finally {
    await mongoose.disconnect();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    process.stderr.write(
      `razorpay:connect failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
