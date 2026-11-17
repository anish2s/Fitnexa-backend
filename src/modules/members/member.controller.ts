import type { Request, Response } from 'express';
import { created, ok } from '../../lib/response.js';
import { auditContextFrom } from '../audit/audit.service.js';
import type {
  CreateMemberInput,
  MemberListQuery,
  SelfUpdateInput,
  UpdateMemberInput,
} from './member.schemas.js';
import { Errors } from '../../lib/errors.js';
import type { createMemberImporter } from './member.import.js';
import type { MemberService } from './member.service.js';

export function createMemberController(
  members: MemberService,
  importer: ReturnType<typeof createMemberImporter>,
) {
  const idOf = (req: Request) => (req.valid.params as { id: string }).id;
  const noStore = (res: Response) => res.set('Cache-Control', 'no-store');

  return {
    async list(req: Request, res: Response) {
      const { items, meta } = await members.list(req.valid.query as MemberListQuery);
      noStore(res);
      ok(res, items, 200, { ...meta });
    },
    async get(req: Request, res: Response) {
      noStore(res);
      ok(res, await members.get(idOf(req)));
    },
    async create(req: Request, res: Response) {
      created(
        res,
        await members.create(req.valid.body as CreateMemberInput, auditContextFrom(req)),
      );
    },
    async update(req: Request, res: Response) {
      ok(
        res,
        await members.update(idOf(req), req.valid.body as UpdateMemberInput, auditContextFrom(req)),
      );
    },
    async setPhoto(req: Request, res: Response) {
      const { publicId } = req.valid.body as { publicId: string };
      ok(res, await members.setPhoto(idOf(req), publicId, auditContextFrom(req)));
    },
    async removePhoto(req: Request, res: Response) {
      ok(res, await members.setPhoto(idOf(req), null, auditContextFrom(req)));
    },
    async archive(req: Request, res: Response) {
      ok(res, await members.archive(idOf(req), auditContextFrom(req)));
    },
    async restore(req: Request, res: Response) {
      ok(res, await members.restore(idOf(req), auditContextFrom(req)));
    },
    async importCsv(req: Request, res: Response) {
      if (typeof req.body !== 'string' || !req.body.trim()) {
        throw Errors.badRequest('Send the CSV file as the request body (Content-Type: text/csv)');
      }
      const opts = req.valid.query as { dryRun: boolean; consentConfirmed: boolean };
      const report = await importer.run(req.body, opts, auditContextFrom(req));
      if (!opts.dryRun && report.errorCount) throw Errors.importInvalid(report);
      ok(res, report, opts.dryRun ? 200 : 201);
    },
    async getSelf(req: Request, res: Response) {
      noStore(res);
      ok(res, await members.getSelf(req.auth!.userId));
    },
    async updateSelf(req: Request, res: Response) {
      ok(
        res,
        await members.updateSelf(
          req.auth!.userId,
          req.valid.body as SelfUpdateInput,
          auditContextFrom(req),
        ),
      );
    },
  };
}
