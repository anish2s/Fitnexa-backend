import { z } from 'zod';
import { PASSWORD_MAX, PASSWORD_MIN } from '../../auth/password.js';

const email = z.string().trim().toLowerCase().email().max(254);
const token = z.string().min(1).max(200);
const newPassword = z
  .string()
  .min(PASSWORD_MIN, `Password must be at least ${PASSWORD_MIN} characters`)
  .max(PASSWORD_MAX)
  .refine((p) => p.trim().length >= PASSWORD_MIN, 'Password cannot be only spaces');

export const loginBody = z.object({
  /** Email, or phone for gym owners/staff. */
  identifier: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(PASSWORD_MAX),
});

export const magicLinkBody = z.object({ email });
export const verifyLinkBody = z.object({ token });
export const forgotBody = z.object({ email });
export const resetBody = z.object({ token, password: newPassword });
export const changePasswordBody = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX),
  newPassword,
});
export const sessionIdParams = z.object({ id: z.string().regex(/^[a-f0-9]{24}$/i) });
