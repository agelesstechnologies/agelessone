import { z } from 'zod';
/** Login, the signed-in person, logins and roles. Shared by the API and the web app. */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((d) => !Number.isNaN(Date.parse(d)), 'Not a real date');
/** bcrypt only uses the first 72 bytes, so longer passwords are refused rather than silently cut. */
const password = z.string().min(8, 'At least 8 characters').max(72, 'At most 72 characters');

export const RoleScope = z.enum(['own', 'team', 'all']);
export type RoleScope = z.infer<typeof RoleScope>;

/** POST /api/auth/login: `login` is the person's login phone number or email, whichever they prefer. */
export const LoginRequest = z.object({
  login: z.string().trim().min(3).max(100),
  password: z.string().min(1).max(72),
});
export type LoginRequest = z.infer<typeof LoginRequest>;
export interface LoginResponse { token: string; expiresAt: string }

/** POST /api/auth/password: changing the password ends every older token, and answers with a new one. */
export const ChangePasswordRequest = z.object({ currentPassword: z.string().min(1).max(72), newPassword: password });
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;

/** GET /api/auth/me */
export interface Me {
  person: { publicId: string; displayName: string };
  user: { publicId: string; loginPhone: string | null; loginEmail: string | null };
  roles: { publicId: string; code: string; name: string; scope: RoleScope }[];
  /** permission code → widest scope the person holds it with */
  permissions: Record<string, RoleScope>;
}

/** POST /api/core/users: a login for an existing person, with a phone, an email, or both. */
export const CreateUserRequest = z.object({
  personPublicId: z.string().uuid(),
  loginPhone: z.string().trim().min(6).max(20).optional(),
  loginEmail: z.string().trim().email().max(100).optional(),
  password,
}).refine((u) => u.loginPhone !== undefined || u.loginEmail !== undefined, { message: 'Give a login phone or email', path: ['loginPhone'] });
export type CreateUserRequest = z.infer<typeof CreateUserRequest>;

/** POST /api/core/users/:publicId/reset-password */
export const ResetPasswordRequest = z.object({ newPassword: password });
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequest>;

/** POST /api/core/role-assignments. Nobody can give a role to themselves. */
export const AssignRoleRequest = z.object({
  personPublicId: z.string().uuid(),
  roleCode: z.string().trim().min(1).max(40),
  scope: RoleScope,
  validFrom: isoDate.optional(),   // default: today (IST)
  validTo: isoDate.optional(),
}).refine((r) => !r.validFrom || !r.validTo || r.validTo >= r.validFrom, { message: 'validTo is before validFrom', path: ['validTo'] });
export type AssignRoleRequest = z.infer<typeof AssignRoleRequest>;
