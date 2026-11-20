import type { Types } from 'mongoose';
import { Errors } from '../../lib/errors.js';
import type { ImageStore } from '../../lib/image-store.js';
import type { AuditChange } from '../audit/audit.service.js';
import { Tenant } from './tenant.model.js';
import { patchTenant, type TenantView } from './tenant.service.js';

/** App icon rules (owner's decision 2026-11-19): raster only, small, square. */
export const ICON_FORMATS = ['png', 'jpg', 'jpeg', 'webp'] as const;
export const ICON_MAX_BYTES = 2 * 1024 * 1024;
/** Cover image rules (owner's decision 2026-11-20): raster only, up to 5 MB, any shape. */
export const COVER_FORMATS = ICON_FORMATS;
export const COVER_MAX_BYTES = 5 * 1024 * 1024;

type Verified = 'icon' | 'cover';
const FIELD: Record<Verified, 'appIconUrl' | 'coverImageUrl'> = {
  icon: 'appIconUrl',
  cover: 'coverImageUrl',
};
const NAME: Record<Verified, string> = { icon: 'app icon', cover: 'cover image' };
const RULES: Record<
  Verified,
  { formats: readonly string[]; maxBytes: number; maxLabel: string; square: boolean }
> = {
  icon: { formats: ICON_FORMATS, maxBytes: ICON_MAX_BYTES, maxLabel: '2 MB', square: true },
  cover: { formats: COVER_FORMATS, maxBytes: COVER_MAX_BYTES, maxLabel: '5 MB', square: false },
};

/**
 * An app icon or cover image may only be an image WE stored for THIS gym (via /uploads/signature),
 * and what was stored must follow its rules (PNG/JPG/WebP; icon ≤ 2 MB and square, cover ≤ 5 MB).
 * Checked against Cloudinary's own record of the file, not anything the browser says. SVG never gets
 * this far (the upload signature allows raster formats only), but is refused here too.
 */
export async function verifyBrandingImage(
  kind: Verified,
  tenantId: string,
  url: string,
  images: ImageStore | null,
): Promise<string> {
  const fail = (message: string) => Errors.validation([{ path: FIELD[kind], message }]);
  const name = NAME[kind];
  const rules = RULES[kind];
  if (!images) throw Errors.uploadsNotConfigured();
  const publicId = images.publicIdFromUrl(url, kind);
  const prefix = `${images.gymPrefix(tenantId)}/branding/${kind}-`;
  if (
    !publicId ||
    !publicId.startsWith(prefix) ||
    !/^[A-Za-z0-9]{16}$/.test(publicId.slice(prefix.length))
  ) {
    throw fail(`Upload the ${name} here; links to other images are not accepted`);
  }
  const stored = await images.inspect(publicId);
  if (!stored) throw fail(`That upload was not found. Upload the ${name} again`);
  if (!rules.formats.includes(stored.format)) {
    throw fail(`The ${name} must be a PNG, JPG or WebP image`);
  }
  if (stored.bytes > rules.maxBytes) throw fail(`The ${name} must be ${rules.maxLabel} or smaller`);
  if (rules.square && (!stored.width || stored.width !== stored.height)) {
    throw fail(`The ${name} must be square`);
  }
  return publicId;
}

/** Kept for callers of the icon-only check. */
export const verifyAppIcon = (tenantId: string, url: string, images: ImageStore | null) =>
  verifyBrandingImage('icon', tenantId, url, images);

/**
 * Applies a branding patch for the owner (PATCH /gym/branding) or a super admin
 * (PATCH /platform/tenants/:id/branding). Verifies a new app icon or cover image, stamps
 * `branding.updatedAt` when anything changed (image URLs are versioned with it), and deletes a
 * replaced icon or cover of ours.
 */
export async function applyBrandingPatch(
  tenantId: Types.ObjectId | string,
  patch: Record<string, unknown>,
  images: ImageStore | null,
): Promise<{ tenant: TenantView; changes: AuditChange[] }> {
  const id = String(tenantId);
  for (const kind of ['icon', 'cover'] as const) {
    const url = patch[FIELD[kind]];
    if (typeof url === 'string') await verifyBrandingImage(kind, id, url, images);
  }
  const before = await Tenant.findById(id)
    .select('branding.appIconUrl branding.coverImageUrl')
    .lean<{ branding?: { appIconUrl?: string; coverImageUrl?: string } }>();

  const result = await patchTenant(id, { branding: patch });
  if (result.changes.length) {
    const at = new Date();
    await Tenant.updateOne({ _id: id }, { $set: { 'branding.updatedAt': at } });
    result.tenant.branding.updatedAt = at;

    for (const kind of ['icon', 'cover'] as const) {
      const oldUrl = before?.branding?.[FIELD[kind]];
      if (images && oldUrl && oldUrl !== result.tenant.branding[FIELD[kind]]) {
        const oldId = images.publicIdFromUrl(oldUrl, kind);
        if (oldId?.startsWith(`${images.gymPrefix(id)}/branding/${kind}-`))
          await images.destroy(oldId);
      }
    }
  }
  return result;
}
