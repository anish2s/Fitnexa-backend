import type { Types } from 'mongoose';
import { Errors } from '../../lib/errors.js';
import type { ImageStore } from '../../lib/image-store.js';
import type { AuditChange } from '../audit/audit.service.js';
import { Tenant } from './tenant.model.js';
import { patchTenant, type TenantView } from './tenant.service.js';

/** App icon rules (owner's decision 2026-11-19): raster only, small, square. */
export const ICON_FORMATS = ['png', 'jpg', 'jpeg', 'webp'] as const;
export const ICON_MAX_BYTES = 2 * 1024 * 1024;

const fail = (message: string) => Errors.validation([{ path: 'appIconUrl', message }]);

/**
 * An app icon may only be an image WE stored for THIS gym (via /uploads/signature), and what was
 * stored must be PNG/JPG/WebP, ≤ 2 MB and square. Checked against Cloudinary's own record of the file,
 * not anything the browser says. SVG never gets this far (the upload signature allows raster formats
 * only), but is refused here too.
 */
export async function verifyAppIcon(
  tenantId: string,
  url: string,
  images: ImageStore | null,
): Promise<string> {
  if (!images) throw Errors.uploadsNotConfigured();
  const publicId = images.publicIdFromUrl(url, 'icon');
  const prefix = `${images.gymPrefix(tenantId)}/branding/icon-`;
  if (
    !publicId ||
    !publicId.startsWith(prefix) ||
    !/^[A-Za-z0-9]{16}$/.test(publicId.slice(prefix.length))
  ) {
    throw fail('Upload the app icon here; links to other images are not accepted');
  }
  const stored = await images.inspect(publicId);
  if (!stored) throw fail('That upload was not found. Upload the icon again');
  if (!(ICON_FORMATS as readonly string[]).includes(stored.format)) {
    throw fail('The app icon must be a PNG, JPG or WebP image');
  }
  if (stored.bytes > ICON_MAX_BYTES) throw fail('The app icon must be 2 MB or smaller');
  if (!stored.width || stored.width !== stored.height) throw fail('The app icon must be square');
  return publicId;
}

/**
 * Applies a branding patch for the owner (PATCH /gym/branding) or a super admin
 * (PATCH /platform/tenants/:id/branding). Verifies a new app icon, stamps `branding.updatedAt`
 * when anything changed (icon URLs are versioned with it), and deletes a replaced icon of ours.
 */
export async function applyBrandingPatch(
  tenantId: Types.ObjectId | string,
  patch: Record<string, unknown>,
  images: ImageStore | null,
): Promise<{ tenant: TenantView; changes: AuditChange[] }> {
  const id = String(tenantId);
  if (typeof patch.appIconUrl === 'string') await verifyAppIcon(id, patch.appIconUrl, images);
  const before = await Tenant.findById(id)
    .select('branding.appIconUrl')
    .lean<{ branding?: { appIconUrl?: string } }>();

  const result = await patchTenant(id, { branding: patch });
  if (result.changes.length) {
    const at = new Date();
    await Tenant.updateOne({ _id: id }, { $set: { 'branding.updatedAt': at } });
    result.tenant.branding.updatedAt = at;

    const oldUrl = before?.branding?.appIconUrl;
    if (images && oldUrl && oldUrl !== result.tenant.branding.appIconUrl) {
      const oldId = images.publicIdFromUrl(oldUrl, 'icon');
      if (oldId?.startsWith(`${images.gymPrefix(id)}/branding/icon-`)) await images.destroy(oldId);
    }
  }
  return result;
}
