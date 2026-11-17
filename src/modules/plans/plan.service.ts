import type { Types } from 'mongoose';
import { Errors } from '../../lib/errors.js';
import { priceBreakdown, type TaxMode } from '../../lib/money.js';
import { pageMeta, skipFor } from '../../lib/pagination.js';
import { requireTenantId } from '../../tenancy/context.js';
import { diffChanges, type AuditContext, type AuditService } from '../audit/audit.service.js';
import { Tenant } from '../tenants/tenant.model.js';
import { Plan } from './plan.model.js';
import type { CreatePlanInput, PlanListQuery, UpdatePlanInput } from './plan.schemas.js';

export type LeanPlan = {
  _id: Types.ObjectId;
  name: string;
  description?: string | null;
  durationDays: number;
  pricePaise: number;
  taxMode: TaxMode;
  gstRate: number;
  archivedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
};

export function toPlanView(p: LeanPlan) {
  return {
    id: String(p._id),
    name: p.name,
    description: p.description ?? null,
    durationDays: p.durationDays,
    pricePaise: p.pricePaise,
    taxMode: p.taxMode,
    gstRate: p.gstRate,
    /** What a member pays for this plan and how much of it is GST. */
    breakdown: priceBreakdown(p.pricePaise, p.taxMode, p.gstRate),
    archivedAt: p.archivedAt ?? null,
    createdAt: p.createdAt ?? null,
    updatedAt: p.updatedAt ?? null,
  };
}

async function gymHasGstin(): Promise<boolean> {
  const t = await Tenant.findById(requireTenantId()).select('settings.gstin').lean();
  return Boolean(t?.settings?.gstin);
}

/** An unregistered business can't charge GST; a plan "with GST at 0%" is just "none". */
async function checkTax(mode: TaxMode, rate: number) {
  if (mode === 'none') return { taxMode: mode, gstRate: 0 };
  if (rate === 0) {
    throw Errors.validation([{ path: 'gstRate', message: 'Use taxMode "none" for no GST' }]);
  }
  if (!(await gymHasGstin())) {
    throw Errors.validation([
      { path: 'taxMode', message: "Add the gym's GSTIN in settings before charging GST" },
    ]);
  }
  return { taxMode: mode, gstRate: rate };
}

export function createPlanService(deps: { audit: AuditService }) {
  const { audit } = deps;

  async function load(id: string) {
    const p = await Plan.findById(id).lean<LeanPlan>();
    if (!p) throw Errors.notFound('Plan');
    return p;
  }

  async function list(q: PlanListQuery) {
    const filter = { archivedAt: q.archived ? { $ne: null } : null };
    const [rows, total] = await Promise.all([
      Plan.find(filter)
        .sort({ durationDays: 1, pricePaise: 1, _id: 1 })
        .skip(skipFor(q))
        .limit(q.limit)
        .lean<LeanPlan[]>(),
      Plan.countDocuments(filter),
    ]);
    return { items: rows.map(toPlanView), meta: pageMeta(q, total) };
  }

  async function create(input: CreatePlanInput, ctx: AuditContext) {
    const defaultMode: TaxMode = (await gymHasGstin()) ? 'inclusive' : 'none';
    const tax = await checkTax(input.taxMode ?? defaultMode, input.gstRate ?? 18);
    const doc = new Plan({
      name: input.name,
      nameKey: input.name.toLowerCase(),
      description: input.description,
      durationDays: input.durationDays,
      pricePaise: input.pricePaise,
      ...tax,
    });
    await doc.save();
    const plan = doc.toObject() as unknown as LeanPlan;
    await audit.record(ctx, {
      action: 'plan.create',
      target: { type: 'plan', id: String(plan._id) },
      metadata: { name: plan.name, pricePaise: plan.pricePaise, durationDays: plan.durationDays },
    });
    return toPlanView(plan);
  }

  /** Changes apply to future sales only; memberships already sold keep their snapshot. */
  async function update(id: string, input: UpdatePlanInput, ctx: AuditContext) {
    const before = await load(id);
    if (before.archivedAt) throw Errors.conflict('Plan is archived; restore it first');
    const set: Record<string, unknown> = {};
    const unset: Record<string, 1> = {};
    if (input.name !== undefined)
      Object.assign(set, { name: input.name, nameKey: input.name.toLowerCase() });
    if (input.description === null) unset.description = 1;
    else if (input.description !== undefined) set.description = input.description;
    for (const k of ['durationDays', 'pricePaise'] as const)
      if (input[k] !== undefined) set[k] = input[k];
    if (input.taxMode !== undefined || input.gstRate !== undefined) {
      Object.assign(
        set,
        await checkTax(input.taxMode ?? before.taxMode, input.gstRate ?? (before.gstRate || 18)),
      );
    }
    const after = await Plan.findOneAndUpdate(
      { _id: id },
      {
        ...(Object.keys(set).length ? { $set: set } : {}),
        ...(Object.keys(unset).length ? { $unset: unset } : {}),
      },
      { returnDocument: 'after', runValidators: true },
    ).lean<LeanPlan>();
    const changes = diffChanges(before, after, [
      'name',
      'description',
      'durationDays',
      'pricePaise',
      'taxMode',
      'gstRate',
    ]);
    if (changes.length) {
      await audit.record(ctx, { action: 'plan.update', target: { type: 'plan', id }, changes });
    }
    return toPlanView(after!);
  }

  async function setArchived(id: string, archive: boolean, ctx: AuditContext) {
    const p = await load(id);
    if (Boolean(p.archivedAt) === archive) {
      throw Errors.conflict(archive ? 'Plan is already archived' : 'Plan is not archived');
    }
    // Restoring re-enters the "unique live name" index: a clash is a 409 DUPLICATE.
    const after = await Plan.findOneAndUpdate(
      { _id: id },
      { $set: { archivedAt: archive ? new Date() : null } },
      { returnDocument: 'after' },
    ).lean<LeanPlan>();
    await audit.record(ctx, {
      action: archive ? 'plan.archive' : 'plan.restore',
      target: { type: 'plan', id },
    });
    return toPlanView(after!);
  }

  return {
    list,
    get: async (id: string) => toPlanView(await load(id)),
    load,
    create,
    update,
    archive: (id: string, ctx: AuditContext) => setArchived(id, true, ctx),
    restore: (id: string, ctx: AuditContext) => setArchived(id, false, ctx),
  };
}

export type PlanService = ReturnType<typeof createPlanService>;
