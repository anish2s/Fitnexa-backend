import mongoose from 'mongoose';
import request from 'supertest';
import type { Express } from 'express';
import { Tenant } from '../../src/db/models.js';
import type { ImageStore } from '../../src/lib/image-store.js';
import type { RazorpayClient } from '../../src/modules/payments/razorpay.client.js';
import { memoryMailer } from '../../src/lib/mailer.js';
import { mongoTenantLookup } from '../../src/modules/tenants/tenant.lookup.js';
import { seedDemo } from '../../src/scripts/seed.js';
import { buildTestApp } from './app.js';

/** Shared fixtures for real-MongoDB integration suites that run against the demo seed. */
export const PASSWORD = 'demo-Password-123';
export const PH = 'powerhouse.localhost';
export const FZ = 'fitzone.localhost';
export const PLATFORM = 'admin.localhost';

export function intApp(
  env: Record<string, string> = {},
  images: ImageStore | null = null,
  razorpay?: RazorpayClient,
) {
  const mailer = memoryMailer();
  const app = buildTestApp({
    lookup: mongoTenantLookup,
    mailer,
    images,
    razorpay,
    env: { AUTH_RATE_LIMIT_MAX: '1000', RATE_LIMIT_MAX: '100000', ...env },
  }) as Express;

  function lastLinkToken(): string {
    const m = /token=([A-Za-z0-9_-]{43})/.exec(mailer.outbox.at(-1)?.text ?? '');
    if (!m) throw new Error('no link in last email');
    return m[1]!;
  }

  async function tokenFor(host: string, identifier: string, password = PASSWORD) {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Host', host)
      .send({ identifier, password });
    if (res.status !== 200) throw new Error(`login ${identifier}@${host}: ${res.status}`);
    return res.body.data.accessToken as string;
  }

  async function memberToken(host: string, email: string) {
    await request(app).post('/api/v1/auth/magic-link').set('Host', host).send({ email });
    const res = await request(app)
      .post('/api/v1/auth/magic-link/verify')
      .set('Host', host)
      .send({ token: lastLinkToken() });
    if (res.status !== 200) throw new Error(`member login ${email}@${host}: ${res.status}`);
    return res.body.data.accessToken as string;
  }

  type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';
  const call = (method: Method, host: string, path: string, token?: string) => {
    const r = request(app)[method](`/api/v1${path}`).set('Host', host);
    return token ? r.set('Authorization', `Bearer ${token}`) : r;
  };

  return { app, mailer, lastLinkToken, tokenFor, memberToken, call };
}

/** Wipes every collection and re-seeds both demo gyms. */
export async function resetDemo(mailer?: { clear(): void }) {
  for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
  mailer?.clear();
  await seedDemo({ password: PASSWORD });
}

export async function gymId(slug: string) {
  return String((await Tenant.findOne({ slug }).lean())!._id);
}
