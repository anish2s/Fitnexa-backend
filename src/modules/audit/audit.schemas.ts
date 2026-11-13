import { z } from 'zod';
import { objectId, pageQuery } from '../../lib/pagination.js';

export const auditListQuery = pageQuery.extend({
  action: z
    .string()
    .regex(/^[a-z_]+\.[a-z_]+$/, 'Use an action name like tenant.update')
    .optional(),
  actorId: objectId.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
