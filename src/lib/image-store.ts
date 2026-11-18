import { createHash, randomBytes } from 'node:crypto';
import type { Env } from '../config/env.js';
import type { Logger } from './logger.js';

/**
 * Image hosting for logos and member photos. Uploads go straight from the browser to Cloudinary
 * with a signature from us, so image bytes never pass through the API.
 *
 * The signature binds an exact `public_id` that the server chose under the gym's own folder, so a
 * client can't upload into another gym's (or member's) space. See docs/SECURITY.md.
 */
export interface SignedUpload {
  uploadUrl: string;
  /** Form fields to POST with the file (multipart). */
  fields: Record<string, string>;
  publicId: string;
  /** Where the image will be served from once uploaded. */
  deliveryUrl: string;
  /** Cloudinary rejects signatures older than one hour. */
  expiresAt: Date;
}

export interface ImageStore {
  signUpload(publicId: string, kind: ImageKind): SignedUpload;
  deliveryUrl(publicId: string, kind: ImageKind): string;
  /** Best effort: never throws (a leftover image must not fail the user's action). */
  destroy(publicId: string): Promise<void>;
  /** e.g. `fitexaa-dev/gyms/<tenantId>` — every id this gym may use starts with it. */
  gymPrefix(tenantId: string): string;
}

export type ImageKind = 'logo' | 'icon' | 'member_photo';

export const ALLOWED_FORMATS = 'jpg,jpeg,png,webp';

/** Delivery transformations: resized and auto-format on the CDN, not stored at full size. */
const DELIVERY: Record<ImageKind, string> = {
  logo: 'c_limit,w_512,h_512,f_auto,q_auto',
  icon: 'c_fill,w_512,h_512,f_auto,q_auto',
  member_photo: 'c_fill,g_face,w_400,h_400,f_auto,q_auto',
};

/** Cloudinary's signature: sorted `key=value` pairs joined by `&`, then the secret, SHA-1 hex. */
export function cloudinarySignature(params: Record<string, string>, secret: string): string {
  const toSign = Object.keys(params)
    .filter((k) => params[k] !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return createHash('sha1')
    .update(toSign + secret)
    .digest('hex');
}

/** Unguessable, so a new upload never overwrites (or is cached as) an older image. */
export const randomImageName = () => randomBytes(12).toString('base64url').replace(/[-_]/g, 'x');

export function cloudinaryImageStore(opts: {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  folder: string;
  logger: Logger;
  fetch?: typeof fetch;
  now?: () => Date;
}): ImageStore {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? (() => new Date());
  const base = `https://api.cloudinary.com/v1_1/${opts.cloudName}/image`;

  const deliveryUrl = (publicId: string, kind: ImageKind) =>
    `https://res.cloudinary.com/${opts.cloudName}/image/upload/${DELIVERY[kind]}/${publicId}`;

  return {
    gymPrefix: (tenantId) => `${opts.folder}/gyms/${tenantId}`,
    deliveryUrl,

    signUpload(publicId, kind) {
      const issued = now();
      const timestamp = String(Math.floor(issued.getTime() / 1000));
      const signed = {
        allowed_formats: ALLOWED_FORMATS,
        overwrite: 'false',
        public_id: publicId,
        timestamp,
      };
      return {
        uploadUrl: `${base}/upload`,
        fields: {
          ...signed,
          api_key: opts.apiKey,
          signature: cloudinarySignature(signed, opts.apiSecret),
        },
        publicId,
        deliveryUrl: deliveryUrl(publicId, kind),
        expiresAt: new Date(issued.getTime() + 3_600_000),
      };
    },

    async destroy(publicId) {
      const timestamp = String(Math.floor(now().getTime() / 1000));
      const signed = { invalidate: 'true', public_id: publicId, timestamp };
      try {
        const res = await doFetch(`${base}/destroy`, {
          method: 'POST',
          body: new URLSearchParams({
            ...signed,
            api_key: opts.apiKey,
            signature: cloudinarySignature(signed, opts.apiSecret),
          }),
          signal: AbortSignal.timeout(10_000),
        });
        const body = (await res.json().catch(() => ({}))) as { result?: string };
        if (!res.ok || (body.result !== 'ok' && body.result !== 'not found')) {
          opts.logger.warn(
            { publicId, status: res.status, result: body.result },
            'Image delete failed',
          );
        }
      } catch (err) {
        opts.logger.warn({ publicId, err: (err as Error).name }, 'Image delete failed');
      }
    },
  };
}

/** null when Cloudinary isn't configured: upload endpoints then answer 503. */
export function createImageStore(env: Env, logger: Logger): ImageStore | null {
  if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) {
    return null;
  }
  return cloudinaryImageStore({
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    apiKey: env.CLOUDINARY_API_KEY,
    apiSecret: env.CLOUDINARY_API_SECRET,
    folder: env.CLOUDINARY_FOLDER,
    logger,
  });
}
