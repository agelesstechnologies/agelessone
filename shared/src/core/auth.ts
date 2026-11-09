import { z } from 'zod';
import { Instant, PersonRef, PublicId } from '../common';
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
export const LoginResponse = z.object({ token: z.string(), expiresAt: Instant });
export type LoginResponse = z.infer<typeof LoginResponse>;

/** POST /api/auth/password: changing the password ends every older token, and answers with a new one. */
export const ChangePasswordRequest = z.object({ currentPassword: z.string().min(1).max(72), newPassword: password });
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;

/** GET /api/auth/me */
export const Me = z.object({
  person: PersonRef,
  user: z.object({
    publicId: PublicId, loginPhone: z.string().nullable(), loginEmail: z.string().nullable(),
    /** someone else chose the password (new login, admin reset): set your own before using the app */
    mustChangePassword: z.boolean(),
  }),
  roles: z.array(z.object({ publicId: PublicId, code: z.string(), name: z.string(), scope: RoleScope })),
  /** permission code → widest scope the person holds it with */
  permissions: z.record(z.string(), RoleScope),
});
export type Me = z.infer<typeof Me>;

/**
 * POST /api/core/users: a login for an existing person. An email is required: a welcome email tells the person to set
 * their password with a code sent to it ("First time or forgot your password?" on the sign-in page). A phone is
 * optional. No password is needed; one given is temporary (the person confirms an emailed code and sets their own).
 */
export const CreateUserRequest = z.object({
  personPublicId: z.string().uuid(),
  loginPhone: z.string().trim().min(6).max(20).optional(),
  loginEmail: z.string().trim().email('Enter a valid email address').max(100),
  password: password.optional(),
});
export type CreateUserRequest = z.infer<typeof CreateUserRequest>;

const code = z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from the email');

/** POST /api/auth/first-login/code: emails a code to the signed-in person's login email. */
export const CodeSent = z.object({
  sentTo: z.string(),               // masked: "ne***@example.com and the phone ending 3210"
  expiresAt: Instant,
  devCode: z.string().optional(),   // development only (DEV_SHOW_CODES): the code itself, to test without email or SMS
});
export type CodeSent = z.infer<typeof CodeSent>;

/** POST /api/auth/first-login: the emailed code and your own password; answers a fresh token. */
export const CompleteFirstLoginRequest = z.object({ code: code.optional(), newPassword: password });
export type CompleteFirstLoginRequest = z.infer<typeof CompleteFirstLoginRequest>;

/** POST /api/auth/forgot-password: emails a code if the login exists (the answer never says whether it does). */
export const ForgotPasswordRequest = z.object({ login: z.string().trim().min(3).max(100) });
export type ForgotPasswordRequest = z.infer<typeof ForgotPasswordRequest>;
export const ForgotPasswordResponse = z.object({ message: z.string(), devCode: z.string().optional() });
export type ForgotPasswordResponse = z.infer<typeof ForgotPasswordResponse>;

/** POST /api/auth/reset-password: the emailed code and a new password; answers a token (you are signed in). */
export const ResetWithCodeRequest = z.object({ login: z.string().trim().min(3).max(100), code, newPassword: password });
export type ResetWithCodeRequest = z.infer<typeof ResetWithCodeRequest>;

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

/** GET /api/core/roles: the roles that can be given. */
export const RoleOption = z.object({ code: z.string(), name: z.string() });
export type RoleOption = z.infer<typeof RoleOption>;

/** GET /api/core/people/:publicId/access: a person's login (null: none yet) and the roles they hold today. */
export const PersonAccess = z.object({
  login: z.object({ publicId: PublicId, loginEmail: z.string().nullable(), loginPhone: z.string().nullable(), isActive: z.boolean() }).nullable(),
  roles: z.array(z.object({ publicId: PublicId, code: z.string(), name: z.string(), scope: RoleScope })),
});
export type PersonAccess = z.infer<typeof PersonAccess>;
