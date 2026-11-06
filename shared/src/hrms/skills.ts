import { z } from 'zod';
import { DateOnly, Instant, PersonRef, PublicId } from '../common';
/** Skills and certificates: shared by the API and the web app. */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((d) => !Number.isNaN(Date.parse(d)), 'Not a real date');
const emptyToUndefined = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
const company = z.string().trim().min(1).max(12);
const prefix = z.string().trim().regex(/^[A-Z]{2,6}$/, '2 to 6 capital letters, e.g. ATS');
const skillCode = z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,39}$/, 'lowercase letters, digits, - or _ (2–40)');

export const SkillLevel = z.enum(['trainee', 'skilled', 'expert']);
export type SkillLevel = z.infer<typeof SkillLevel>;
export const CertificateStatus = z.enum(['review', 'verified', 'expired']);
export type CertificateStatus = z.infer<typeof CertificateStatus>;

export const Skill = z.object({
  publicId: PublicId, company: z.string(), department: z.object({ code: z.string(), name: z.string() }).nullable(), code: z.string(), name: z.string(),
});
export type Skill = z.infer<typeof Skill>;
/** GET /api/hrms/skills?company=&department= */
export const SkillsQuery = z.object({ company: emptyToUndefined(company), department: emptyToUndefined(prefix) });
export type SkillsQuery = z.infer<typeof SkillsQuery>;
/** POST /api/hrms/skills — HR keeps the list. */
export const CreateSkillRequest = z.object({ company, departmentCode: prefix.optional(), code: skillCode, name: z.string().trim().min(2).max(100) });
export type CreateSkillRequest = z.infer<typeof CreateSkillRequest>;

/** POST /api/hrms/people/:publicId/skills — adds the skill, or changes its level (which clears the verification). */
export const AddPersonSkillRequest = z.object({ skillPublicId: z.string().uuid(), level: SkillLevel });
export type AddPersonSkillRequest = z.infer<typeof AddPersonSkillRequest>;

export const PersonSkill = z.object({
  publicId: PublicId, skill: z.object({ publicId: PublicId, code: z.string(), name: z.string() }), level: SkillLevel,
  verifiedBy: PersonRef.nullable(), verifiedAt: Instant.nullable(),
});
export type PersonSkill = z.infer<typeof PersonSkill>;

/** POST /api/hrms/people/:publicId/certificates — multipart: these text fields plus an optional file field `file`. */
export const AddCertificateRequest = z.object({
  name: z.string().trim().min(2).max(120),
  issuer: emptyToUndefined(z.string().trim().max(120)),
  number: emptyToUndefined(z.string().trim().max(60)),
  issuedOn: emptyToUndefined(isoDate),
  expiresOn: emptyToUndefined(isoDate),
}).refine((c) => !c.issuedOn || !c.expiresOn || c.expiresOn >= c.issuedOn, { message: '`expiresOn` is before `issuedOn`', path: ['expiresOn'] });
export type AddCertificateRequest = z.infer<typeof AddCertificateRequest>;

export const Certificate = z.object({
  publicId: PublicId, person: PersonRef,
  name: z.string(), issuer: z.string().nullable(), number: z.string().nullable(), issuedOn: DateOnly.nullable(), expiresOn: DateOnly.nullable(),
  status: CertificateStatus, hasFile: z.boolean(),
  verifiedBy: PersonRef.nullable(), verifiedAt: Instant.nullable(), createdAt: Instant,
});
export type Certificate = z.infer<typeof Certificate>;

/** GET /api/hrms/skills/matrix?company=&department=&skill= — skill is a skill code: only people who have it. */
export const SkillsMatrixQuery = z.object({ company: emptyToUndefined(company), department: emptyToUndefined(prefix), skill: emptyToUndefined(skillCode) });
export type SkillsMatrixQuery = z.infer<typeof SkillsMatrixQuery>;
export const SkillsMatrix = z.object({
  rows: z.array(z.object({
    person: PersonRef,
    employment: z.object({ publicId: PublicId, company: z.string(), employeeCode: z.string(), department: z.object({ code: z.string(), name: z.string() }).nullable() }),
    skills: z.array(PersonSkill),
    certificates: z.array(Certificate),
  })),
});
export type SkillsMatrix = z.infer<typeof SkillsMatrix>;

/** GET /api/hrms/certificates/expiring?days=30 — certificates still valid that expire within the days given. */
export const ExpiringCertificatesQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });
export type ExpiringCertificatesQuery = z.infer<typeof ExpiringCertificatesQuery>;
export const ExpiringCertificates = z.object({ today: DateOnly, until: DateOnly, certificates: z.array(Certificate.extend({ daysLeft: z.number().int() })) });
export type ExpiringCertificates = z.infer<typeof ExpiringCertificates>;
