import type { Request, Response } from 'express';
import { created, ok } from '../../lib/response.js';
import { auditContextFrom } from '../audit/audit.service.js';
import type { CreatePlanInput, PlanListQuery, UpdatePlanInput } from './plan.schemas.js';
import type { PlanService } from './plan.service.js';

export function createPlanController(plans: PlanService) {
  const idOf = (req: Request) => (req.valid.params as { id: string }).id;
  return {
    async list(req: Request, res: Response) {
      const { items, meta } = await plans.list(req.valid.query as PlanListQuery);
      ok(res, items, 200, { ...meta });
    },
    async get(req: Request, res: Response) {
      ok(res, await plans.get(idOf(req)));
    },
    async create(req: Request, res: Response) {
      created(res, await plans.create(req.valid.body as CreatePlanInput, auditContextFrom(req)));
    },
    async update(req: Request, res: Response) {
      ok(
        res,
        await plans.update(idOf(req), req.valid.body as UpdatePlanInput, auditContextFrom(req)),
      );
    },
    async archive(req: Request, res: Response) {
      ok(res, await plans.archive(idOf(req), auditContextFrom(req)));
    },
    async restore(req: Request, res: Response) {
      ok(res, await plans.restore(idOf(req), auditContextFrom(req)));
    },
  };
}
