import { Router, type RequestHandler } from 'express';
import type { Permission } from '../../auth/permissions.js';
import type { JwtConfig } from '../../auth/jwt.js';
import { Errors } from '../../lib/errors.js';
import { BRANDING_KIND, randomImageName, type ImageStore } from '../../lib/image-store.js';
import { ok } from '../../lib/response.js';
import { authenticate, authorize } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { tag } from '../../lib/route-meta.js';
import { Member } from '../members/member.model.js';
import { signatureBody, type SignatureInput } from './upload.schemas.js';

const PERMISSION: Record<SignatureInput['purpose'], Permission> = {
  gym_logo: 'branding:update',
  gym_icon: 'branding:update',
  gym_cover: 'branding:update',
  member_photo: 'members:update',
};

/**
 * /api/v1/uploads — signs a direct browser → Cloudinary upload. The image path is chosen here,
 * under the host gym's folder; the client never names it.
 */
export function uploadRouter(deps: { jwt: JwtConfig; images: ImageStore | null }) {
  const router = Router();
  // The permission depends on what is being uploaded; tagged so the route audit and the OpenAPI
  // document see that a permission is enforced here.
  const byPurpose: RequestHandler = tag(
    (req, res, next) =>
      authorize(PERMISSION[(req.valid.body as SignatureInput).purpose])(req, res, next),
    { kind: 'authorizeAny', any: [...new Set(Object.values(PERMISSION))] },
  );

  router.post(
    '/signature',
    authenticate(deps.jwt),
    validate({ body: signatureBody }),
    byPurpose,
    async (req, res) => {
      const images = deps.images;
      if (!images) throw Errors.uploadsNotConfigured();
      const body = req.valid.body as SignatureInput;
      const prefix = images.gymPrefix(req.tenant!.id.toHexString());
      const name = randomImageName();

      if (body.purpose === 'member_photo') {
        // Resolved inside the host gym's scope: another gym's member id is simply not found.
        const exists = await Member.exists({ _id: body.memberId, archivedAt: null });
        if (!exists) throw Errors.notFound('Member');
        return ok(
          res,
          images.signUpload(`${prefix}/members/${body.memberId}/${name}`, 'member_photo'),
        );
      }
      const kind = BRANDING_KIND[body.purpose];
      ok(res, images.signUpload(`${prefix}/branding/${kind}-${name}`, kind));
    },
  );
  return router;
}
