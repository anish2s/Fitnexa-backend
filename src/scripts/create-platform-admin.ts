import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import mongoose from 'mongoose';
import { hashPassword, PASSWORD_MIN } from '../auth/password.js';
import { PlatformAdmin, PlatformSession } from '../db/models.js';

/**
 * Create a super admin, or reset one's password (super admins have no email reset by design).
 *
 *   npm run admin:create -- --email you@yourapp.in --name "Your Name"
 *   npm run admin:create -- --email you@yourapp.in --reset        # new password, all sessions ended
 *
 * The password comes from ADMIN_PASSWORD, or a strong one is generated and printed once.
 */
async function main() {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      name: { type: 'string' },
      reset: { type: 'boolean', default: false },
    },
  });
  const email = values.email?.trim().toLowerCase();
  if (!email || !email.includes('@')) throw new Error('--email is required');

  const password = process.env.ADMIN_PASSWORD ?? randomBytes(15).toString('base64url');
  if (password.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters');
  if (password.length < PASSWORD_MIN) throw new Error('Password too short');

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');
  await mongoose.connect(uri);
  try {
    await PlatformAdmin.createIndexes();
    const existing = await PlatformAdmin.findOne({ email });
    if (existing && !values.reset) {
      throw new Error(`${email} already exists. Use --reset to set a new password.`);
    }
    if (!existing && values.reset) throw new Error(`${email} does not exist`);

    const passwordHash = await hashPassword(password);
    if (existing) {
      existing.set({
        passwordHash,
        passwordChangedAt: new Date(),
        failedLogins: 0,
        lockedUntil: undefined,
      });
      await existing.save();
      await PlatformSession.updateMany(
        { userId: existing._id, revokedAt: null },
        { $set: { revokedAt: new Date(), revokedReason: 'password_changed' } },
      );
    } else {
      if (!values.name) throw new Error('--name is required when creating');
      await PlatformAdmin.create({ email, name: values.name, passwordHash });
    }
    const shown = process.env.ADMIN_PASSWORD ? '(from ADMIN_PASSWORD)' : password;
    process.stdout.write(
      `${existing ? 'Password reset' : 'Created'} super admin ${email}\nPassword: ${shown}\n` +
        'Store it in your password manager now; it will not be shown again.\n',
    );
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
