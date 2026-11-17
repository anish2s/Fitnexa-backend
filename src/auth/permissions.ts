/**
 * Role → permission map. Routes check permissions, never role names, so a staff member can be
 * given one extra capability (e.g. viewing reports) without becoming an owner.
 *
 * Enforced on the server for every request; the dashboard only uses the list to hide buttons.
 */
export const PERMISSIONS = [
  // gym profile & settings
  'gym:read',
  'gym:update',
  'branding:update',
  // people
  'staff:read',
  'staff:manage',
  'members:read',
  'members:create',
  'members:update',
  'members:archive',
  'members:import',
  // plans & memberships
  'plans:read',
  'plans:manage',
  'memberships:read',
  'memberships:manage',
  // money
  'payments:read',
  'payments:record',
  'payments:refund',
  // attendance
  'attendance:read',
  'attendance:checkin',
  // insight
  'dashboard:read',
  'reports:read',
  'audit:read',
  /** DPDP export/erase of a member's data. Owner only: deliberately not grantable to staff. */
  'privacy:manage',
  'renewals:manage',
  // member self-service (PWA)
  'self:read',
  'self:update',
  /** Pay one's own membership online (member app). */
  'self:pay',
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type TenantRole = 'owner' | 'staff' | 'member';

const OWNER: Permission[] = PERMISSIONS.filter((p) => !p.startsWith('self:'));

/** Front desk: register, look up, take payments, check in. No reports, refunds, plans or staff. */
const STAFF: Permission[] = [
  'gym:read',
  'members:read',
  'members:create',
  'members:update',
  'plans:read',
  'memberships:read',
  'memberships:manage',
  'payments:read',
  'payments:record',
  'attendance:read',
  'attendance:checkin',
  'dashboard:read',
];

const MEMBER: Permission[] = ['self:read', 'self:update', 'self:pay'];

export const ROLE_PERMISSIONS: Record<TenantRole, readonly Permission[]> = {
  owner: OWNER,
  staff: STAFF,
  member: MEMBER,
};

/**
 * Extra permissions an owner may grant to an individual staff member. Anything that could let staff
 * take over the gym (staff:manage, branding, gym settings, audit log) is deliberately not grantable.
 */
export const STAFF_GRANTABLE: readonly Permission[] = [
  'reports:read',
  'payments:refund',
  'members:archive',
  'members:import',
  'plans:manage',
  'renewals:manage',
];

export function effectivePermissions(
  role: TenantRole,
  grants: readonly string[] = [],
): Set<Permission> {
  const set = new Set<Permission>(ROLE_PERMISSIONS[role]);
  if (role === 'staff') {
    for (const g of grants) {
      if ((STAFF_GRANTABLE as readonly string[]).includes(g)) set.add(g as Permission);
    }
  }
  return set;
}
