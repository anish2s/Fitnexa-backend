import { z } from 'zod';
import { objectId } from '../../lib/pagination.js';

export const signatureBody = z.discriminatedUnion('purpose', [
  z.object({ purpose: z.literal('gym_logo') }),
  z.object({ purpose: z.literal('gym_icon') }),
  z.object({ purpose: z.literal('gym_cover') }),
  z.object({ purpose: z.literal('member_photo'), memberId: objectId }),
]);
export type SignatureInput = z.infer<typeof signatureBody>;

/** The id returned by /uploads/signature, sent back once the browser has uploaded the file. */
export const photoBody = z.object({
  publicId: z.string().trim().min(1).max(200),
});
