import { z } from 'zod';
import { STAFF_GRANTABLE } from '../../auth/permissions.js';
import { objectId, pageQuery } from '../../lib/pagination.js';
import { emailField, phoneField } from '../tenants/tenant.schemas.js';

const name = z.string().trim().min(1).max(120);

/** Extra grants on top of the front-desk set. Only STAFF_GRANTABLE values are accepted. */
const grants = z
  .array(z.enum(STAFF_GRANTABLE as unknown as [string, ...string[]]))
  .max(STAFF_GRANTABLE.length)
  .transform((a) => [...new Set(a)].sort());

export const staffIdParams = z.object({ id: objectId });

export const staffListQuery = pageQuery.extend({
  q: z.string().trim().min(1).max(100).optional(),
  role: z.enum(['owner', 'staff']).optional(),
  status: z.enum(['invited', 'active', 'disabled']).optional(),
});

export const createStaffBody = z.object({
  name,
  /** Required: new staff set their password from the emailed invite. */
  email: emailField,
  phone: phoneField.optional(),
  permissions: grants.default([]),
});

export const updateStaffBody = z
  .object({
    name: name.optional(),
    email: emailField.optional(),
    phone: phoneField.nullable().optional(),
    permissions: grants.optional(),
  })
  .refine((o) => Object.values(o).some((v) => v !== undefined), 'Nothing to update');

export type CreateStaffInput = z.infer<typeof createStaffBody>;
export type UpdateStaffInput = z.infer<typeof updateStaffBody>;
export type StaffListQuery = z.infer<typeof staffListQuery>;
