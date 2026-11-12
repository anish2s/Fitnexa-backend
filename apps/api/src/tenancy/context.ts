import { AsyncLocalStorage } from 'node:async_hooks';
import { Types } from 'mongoose';
import { TenantIsolationError } from '../lib/errors.js';

/**
 * Request-scoped tenant context.
 *
 * The tenant is set ONCE per request by server-side middleware (from the verified host, and later
 * cross-checked against the authenticated user's tenant). Nothing the client sends in a body,
 * query string or param ever writes to this context.
 *
 * Code outside a request (seeds, background jobs, super-admin tooling) must say explicitly which
 * tenant it is acting for via runInTenant(), or explicitly opt out via runAsPlatform().
 */
type TenantStore =
  { kind: 'tenant'; tenantId: Types.ObjectId } | { kind: 'platform'; reason: string };

const storage = new AsyncLocalStorage<TenantStore>();

function toObjectId(id: Types.ObjectId | string): Types.ObjectId {
  if (id instanceof Types.ObjectId) return id;
  if (!Types.ObjectId.isValid(id)) throw new TenantIsolationError(`Invalid tenantId: ${id}`);
  return new Types.ObjectId(id);
}

export function runInTenant<T>(tenantId: Types.ObjectId | string, fn: () => T): T {
  return storage.run({ kind: 'tenant', tenantId: toObjectId(tenantId) }, fn);
}

/**
 * Cross-tenant access for platform operations (super-admin listings, the renewal job iterating
 * over gyms). The reason is mandatory so every bypass is greppable and loggable.
 */
export function runAsPlatform<T>(reason: string, fn: () => T): T {
  if (!reason.trim()) throw new TenantIsolationError('runAsPlatform requires a reason');
  return storage.run({ kind: 'platform', reason }, fn);
}

export function getTenantStore(): TenantStore | undefined {
  return storage.getStore();
}

/** Current tenant id, or undefined when in platform scope or outside any scope. */
export function currentTenantId(): Types.ObjectId | undefined {
  const store = storage.getStore();
  return store?.kind === 'tenant' ? store.tenantId : undefined;
}

/** Current tenant id; throws if there is none. Use in services that are tenant-only by design. */
export function requireTenantId(): Types.ObjectId {
  const id = currentTenantId();
  if (!id) throw new TenantIsolationError('No tenant in context');
  return id;
}
