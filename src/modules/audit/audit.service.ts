import type { Request } from 'express';
import { Types } from 'mongoose';
import { Errors } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import { pageMeta, skipFor, type PageQuery } from '../../lib/pagination.js';
import { currentTenantId, runInTenant } from '../../tenancy/context.js';
import { AuditLog, PlatformAuditLog } from './audit.model.js';

export interface AuditActor {
  type: 'user' | 'platform_admin' | 'system';
  id?: string;
  name?: string;
  role?: string;
}

/** Who did it and from where. Built once per request by auditContextFrom(). */
export interface AuditContext {
  actor: AuditActor;
  impersonator?: { id: string; name?: string };
  ip?: string;
  userAgent?: string;
  requestId?: string;
}

export interface AuditChange {
  field: string;
  from: unknown;
  to: unknown;
}

export interface AuditEntry {
  action: string;
  target?: { type: string; id: string };
  changes?: AuditChange[];
  metadata?: Record<string, unknown>;
}

export interface AuditListFilter extends PageQuery {
  action?: string;
  actorId?: string;
  from?: Date;
  to?: Date;
}

/** Field names whose values identify a person: the log records THAT they changed, not to what. */
const PERSONAL_FIELDS = new Set(['email', 'phone']);
export const MASKED = '[hidden]';

const clip = (s: string | undefined, n: number) => (s ? s.slice(0, n) : undefined);

/** The audit "hook" for HTTP handlers: actor, impersonator, IP, user agent and request id. */
export function auditContextFrom(req: Request): AuditContext {
  const a = req.auth;
  const base = {
    ip: clip(req.ip, 64),
    userAgent: clip(req.get('user-agent'), 300),
    requestId: clip(String(req.id ?? ''), 64) || undefined,
  };
  if (!a) return { ...base, actor: { type: 'system' } };
  if (a.kind === 'platform') {
    return { ...base, actor: { type: 'platform_admin', id: a.userId, name: a.name } };
  }
  return {
    ...base,
    actor: { type: 'user', id: a.userId, name: a.name, role: a.role },
    ...(a.impersonator ? { impersonator: a.impersonator } : {}),
  };
}

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

const comparable = (v: unknown) => JSON.stringify(v ?? null);

/**
 * Field-level before/after for the given dotted paths, skipping paths that didn't change.
 * Personal fields are masked.
 */
export function diffChanges(before: unknown, after: unknown, paths: string[]): AuditChange[] {
  const out: AuditChange[] = [];
  for (const field of paths) {
    const from = getPath(before, field) ?? null;
    const to = getPath(after, field) ?? null;
    if (comparable(from) === comparable(to)) continue;
    const leaf = field.split('.').at(-1)!;
    out.push(
      PERSONAL_FIELDS.has(leaf)
        ? { field, from: from === null ? null : MASKED, to: to === null ? null : MASKED }
        : { field, from, to },
    );
  }
  return out;
}

function toDoc(ctx: AuditContext, entry: AuditEntry) {
  const oid = (id?: string) =>
    id && Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : undefined;
  return {
    action: entry.action,
    actor: { ...ctx.actor, id: oid(ctx.actor.id) },
    impersonator: ctx.impersonator
      ? { id: oid(ctx.impersonator.id), name: ctx.impersonator.name }
      : undefined,
    target: entry.target,
    changes: entry.changes?.length ? entry.changes : undefined,
    metadata: entry.metadata,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    requestId: ctx.requestId,
  };
}

function toView(e: Record<string, unknown> & { _id: unknown }) {
  const actor = (e.actor ?? {}) as Record<string, unknown>;
  const imp = e.impersonator as Record<string, unknown> | undefined;
  const target = e.target as Record<string, unknown> | undefined;
  return {
    id: String(e._id),
    action: e.action,
    actor: {
      type: actor.type,
      id: actor.id ? String(actor.id) : null,
      name: actor.name ?? null,
      role: actor.role ?? null,
    },
    impersonator: imp?.id ? { id: String(imp.id), name: imp.name ?? null } : null,
    target: target?.type ? { type: target.type, id: target.id ?? null } : null,
    changes: e.changes ?? [],
    metadata: e.metadata ?? null,
    ip: e.ip ?? null,
    userAgent: e.userAgent ?? null,
    requestId: e.requestId ?? null,
    createdAt: e.createdAt,
  };
}

export function createAuditService(deps: { logger: Logger }) {
  const { logger } = deps;

  /**
   * Writes one entry.
   *  - Inside a gym's scope (gym-host requests) it goes to that gym's log.
   *  - `tenantId` writes to that gym's log from platform code (super admin acting on a gym).
   *  - Otherwise it goes to the platform log.
   *
   * By default a failed write is logged (with the full entry, so nothing is lost) but doesn't fail
   * the action that already happened. `required: true` is for writes that must exist BEFORE the
   * action proceeds (e.g. starting impersonation): a failure then aborts the action.
   */
  async function record(
    ctx: AuditContext,
    entry: AuditEntry,
    opts: { tenantId?: Types.ObjectId | string; required?: boolean } = {},
  ): Promise<void> {
    const doc = toDoc(ctx, entry);
    try {
      if (opts.tenantId) await runInTenant(opts.tenantId, () => AuditLog.create(doc));
      else if (currentTenantId()) await AuditLog.create(doc);
      else await PlatformAuditLog.create(doc);
    } catch (err) {
      logger.error(
        { err, audit: { ...doc, tenantId: String(opts.tenantId ?? currentTenantId() ?? '') } },
        'AUDIT WRITE FAILED',
      );
      if (opts.required) throw err;
    }
  }

  function filterOf(f: AuditListFilter) {
    const q: Record<string, unknown> = {};
    if (f.action) q.action = f.action;
    if (f.actorId) q['actor.id'] = new Types.ObjectId(f.actorId);
    if (f.from || f.to) {
      q.createdAt = { ...(f.from ? { $gte: f.from } : {}), ...(f.to ? { $lte: f.to } : {}) };
    }
    return q;
  }

  async function listFrom(model: typeof AuditLog, f: AuditListFilter) {
    const q = filterOf(f);
    const [rows, total] = await Promise.all([
      model.find(q).sort({ createdAt: -1, _id: -1 }).skip(skipFor(f)).limit(f.limit).lean(),
      model.countDocuments(q),
    ]);
    return { items: rows.map((r) => toView(r as never)), meta: pageMeta(f, total) };
  }

  return {
    record,
    /** The current gym's log (gym-host requests). */
    listForCurrentTenant(f: AuditListFilter) {
      if (!currentTenantId()) throw Errors.tenantRequired();
      return listFrom(AuditLog, f);
    },
    /** A given gym's log, read by a super admin. */
    listForTenant(tenantId: Types.ObjectId, f: AuditListFilter) {
      return runInTenant(tenantId, () => listFrom(AuditLog, f));
    },
    listPlatform(f: AuditListFilter) {
      return listFrom(PlatformAuditLog as unknown as typeof AuditLog, f);
    },
  };
}

export type AuditService = ReturnType<typeof createAuditService>;
