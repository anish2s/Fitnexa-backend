import { Schema, Types, type Query, type Aggregate } from 'mongoose';
import { TenantIsolationError } from '../lib/errors.js';
import { getTenantStore } from './context.js';

/**
 * Mongoose plugin that makes a collection tenant-owned.
 *
 * What it guarantees (fail closed):
 *  - Adds a required, indexed, immutable `tenantId` field.
 *  - Every query (find, count, update, delete, distinct, findOneAnd*) gets `tenantId` forced
 *    into its filter from the server-side tenant context.
 *  - Every aggregate pipeline gets a leading `$match: { tenantId }`.
 *  - New documents get `tenantId` from context; a document carrying a different tenantId is rejected.
 *  - Updates can never change `tenantId`.
 *  - With NO context at all, every operation throws. Forgetting tenant scope is a crash, not a leak.
 *
 * Platform scope (runAsPlatform) skips injection, so super-admin/job code can work across gyms
 * deliberately. Operations that cannot be scoped (estimatedDocumentCount, bulkWrite) are only
 * allowed in platform scope.
 */

const QUERY_OPS = [
  'find',
  'findOne',
  'countDocuments',
  'distinct',
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndReplace',
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany',
] as const;

type Scope = { kind: 'tenant'; tenantId: Types.ObjectId } | { kind: 'platform' };

function resolveScope(op: string): Scope {
  const store = getTenantStore();
  if (!store) {
    throw new TenantIsolationError(
      `Tenant-owned operation "${op}" ran with no tenant context. ` +
        'Wrap it in runInTenant() or runAsPlatform().',
    );
  }
  return store.kind === 'tenant'
    ? { kind: 'tenant', tenantId: store.tenantId }
    : { kind: 'platform' };
}

function sameId(a: unknown, b: Types.ObjectId): boolean {
  if (a instanceof Types.ObjectId) return a.equals(b);
  if (typeof a === 'string') return Types.ObjectId.isValid(a) && b.equals(new Types.ObjectId(a));
  return false;
}

/** A filter may name tenantId itself only if it names the SAME tenant as the context. */
function assertFilterTenant(filter: Record<string, unknown>, tenantId: Types.ObjectId, op: string) {
  if (!('tenantId' in filter)) return;
  const value = filter.tenantId;
  if (!sameId(value, tenantId)) {
    throw new TenantIsolationError(`Query "${op}" tried to target another tenant`);
  }
}

const FORBIDDEN_UPDATE_KEYS = ['$set', '$setOnInsert', '$unset', '$rename', '$inc', '$push'];

function assertUpdateKeepsTenant(update: unknown, op: string) {
  if (!update || typeof update !== 'object' || Array.isArray(update)) return;
  const u = update as Record<string, unknown>;
  if ('tenantId' in u) throw new TenantIsolationError(`Update "${op}" may not modify tenantId`);
  for (const key of FORBIDDEN_UPDATE_KEYS) {
    const section = u[key];
    if (section && typeof section === 'object' && 'tenantId' in (section as object)) {
      throw new TenantIsolationError(`Update "${op}" may not modify tenantId`);
    }
  }
}

/**
 * Stages that read ANOTHER collection ($lookup, $unionWith, $graphLookup) would bypass the leading
 * $match, so each gets the tenant filter too, recursively (inside $facet and nested lookups).
 * Joining a collection without tenantId (e.g. tenants) therefore yields nothing: fail closed.
 */
function scopeJoinStages(stages: unknown[], tenantId: Types.ObjectId): void {
  for (const stage of stages as Record<string, Record<string, unknown>>[]) {
    if (!stage || typeof stage !== 'object') continue;
    const lookup = stage.$lookup;
    if (lookup) {
      const inner = Array.isArray(lookup.pipeline) ? (lookup.pipeline as unknown[]) : [];
      scopeJoinStages(inner, tenantId);
      inner.unshift({ $match: { tenantId } });
      lookup.pipeline = inner;
    }
    const union = stage.$unionWith;
    if (union !== undefined) {
      const spec: Record<string, unknown> =
        typeof union === 'string' ? { coll: union } : (union as Record<string, unknown>);
      const inner = Array.isArray(spec.pipeline) ? (spec.pipeline as unknown[]) : [];
      scopeJoinStages(inner, tenantId);
      inner.unshift({ $match: { tenantId } });
      spec.pipeline = inner;
      stage.$unionWith = spec;
    }
    const graph = stage.$graphLookup;
    if (graph) {
      const extra = (graph.restrictSearchWithMatch as Record<string, unknown> | undefined) ?? {};
      graph.restrictSearchWithMatch = { $and: [extra, { tenantId }] };
    }
    const facet = stage.$facet;
    if (facet) for (const sub of Object.values(facet)) scopeJoinStages(sub as unknown[], tenantId);
  }
}

export function tenantScopePlugin(schema: Schema) {
  schema.add({
    tenantId: {
      type: Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
      immutable: true,
      index: true,
    },
  });

  for (const op of QUERY_OPS) {
    // Registered as query middleware explicitly (deleteOne/updateOne are also document methods).
    schema.pre(op, { query: true, document: false }, function (this: Query<unknown, unknown>) {
      const scope = resolveScope(op);
      if (scope.kind === 'platform') return;

      const filter = this.getFilter() as Record<string, unknown>;
      assertFilterTenant(filter, scope.tenantId, op);
      this.where({ tenantId: scope.tenantId });

      if (op.startsWith('update') || op.startsWith('findOneAndUpdate') || op === 'replaceOne') {
        assertUpdateKeepsTenant(this.getUpdate(), op);
      }
      if (op === 'replaceOne' || op === 'findOneAndReplace') {
        // A replacement document must carry (or be given) the same tenant.
        const replacement = this.getUpdate() as Record<string, unknown> | null;
        if (replacement && typeof replacement === 'object') {
          if ('tenantId' in replacement && !sameId(replacement.tenantId, scope.tenantId)) {
            throw new TenantIsolationError(`"${op}" replacement targets another tenant`);
          }
          replacement.tenantId = scope.tenantId;
        }
      }
    });
  }

  schema.pre('aggregate', function (this: Aggregate<unknown>) {
    const scope = resolveScope('aggregate');
    if (scope.kind === 'platform') return;
    const pipeline = this.pipeline();
    // $geoNear / $search must be the first stage; we don't use them. Guard anyway.
    const first = pipeline[0] as Record<string, unknown> | undefined;
    if (first && ('$geoNear' in first || '$search' in first || '$vectorSearch' in first)) {
      throw new TenantIsolationError('First-stage-only aggregate operators need explicit scoping');
    }
    scopeJoinStages(pipeline, scope.tenantId);
    pipeline.unshift({ $match: { tenantId: scope.tenantId } });
  });

  // Runs before validation on save() and create(), so the required check sees the injected id.
  schema.pre('validate', function () {
    const scope = resolveScope('save');
    if (scope.kind === 'platform') {
      if (!this.get('tenantId')) {
        throw new TenantIsolationError('Platform-scope writes must set tenantId explicitly');
      }
      return;
    }
    const existing = this.get('tenantId') as Types.ObjectId | undefined;
    if (existing && !existing.equals(scope.tenantId)) {
      throw new TenantIsolationError('Document belongs to another tenant');
    }
    if (!existing) this.set('tenantId', scope.tenantId);
  });

  schema.pre('insertMany', function (this: unknown, ...args: unknown[]) {
    const scope = resolveScope('insertMany');
    // Mongoose 9 passes the docs array as the first argument.
    const docs = (Array.isArray(args[0]) ? args[0] : [args[0]]) as Record<string, unknown>[];
    for (const doc of docs) {
      if (!doc || typeof doc !== 'object') continue;
      if (scope.kind === 'platform') {
        if (!doc.tenantId)
          throw new TenantIsolationError('Platform-scope insertMany needs tenantId');
        continue;
      }
      if (doc.tenantId && !sameId(doc.tenantId, scope.tenantId)) {
        throw new TenantIsolationError('insertMany document belongs to another tenant');
      }
      doc.tenantId = scope.tenantId;
    }
  });

  for (const op of ['estimatedDocumentCount', 'bulkWrite'] as const) {
    const guard = function () {
      if (resolveScope(op).kind !== 'platform') {
        throw new TenantIsolationError(`"${op}" cannot be tenant-scoped; use a scoped alternative`);
      }
    };
    if (op === 'bulkWrite') schema.pre('bulkWrite', guard);
    else schema.pre(op, { query: true, document: false }, guard);
  }
}
