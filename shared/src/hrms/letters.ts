import { z } from 'zod';
import { Instant, PersonRef, PublicId } from '../common';
/** Letter templates and issued letters (joining letter): HR and Management only (hrms.letters.manage). */

export const LetterKind = z.enum(['joining']);
export type LetterKind = z.infer<typeof LetterKind>;

/** The fill-ins a template may use, written {{name}}. Filled from the person's job when a letter is prepared. */
export const LETTER_FIELDS = [
  'name', 'fullName', 'employeeCode', 'designation', 'department', 'company', 'joiningDate', 'engagementType', 'manager', 'today',
] as const;
export type LetterField = (typeof LETTER_FIELDS)[number];

const title = z.string().trim().min(1, 'Give the letter a title').max(200);
const body = z.string().trim().min(1, 'Write the letter').max(20000);

/** GET /api/hrms/letter-templates/:company/joining — the company's template, or the built-in one when none is saved. */
export const LetterTemplate = z.object({
  company: z.string(), kind: LetterKind, title: z.string(), body: z.string(),
  fields: z.array(z.string()),          // the fill-ins that may be used
  isDefault: z.boolean(),               // true: nothing saved yet, this is the built-in text
  updatedBy: PersonRef.nullable(), updatedAt: Instant.nullable(),
});
export type LetterTemplate = z.infer<typeof LetterTemplate>;

/** PUT /api/hrms/letter-templates/:company/joining */
export const SaveLetterTemplateRequest = z.object({ title, body });
export type SaveLetterTemplateRequest = z.infer<typeof SaveLetterTemplateRequest>;

const LetterJob = z.object({ publicId: PublicId, company: z.string(), employeeCode: z.string() });

/** GET /api/hrms/employments/:publicId/joining-letter — the template filled with this job's details, ready to adjust. */
export const LetterDraft = z.object({ kind: LetterKind, person: PersonRef, employment: LetterJob, title: z.string(), body: z.string() });
export type LetterDraft = z.infer<typeof LetterDraft>;

/** POST /api/hrms/employments/:publicId/joining-letters — keep this text as issued (sent twice: stored once). */
export const IssueLetterRequest = z.object({ publicId: PublicId.optional(), title, body });
export type IssueLetterRequest = z.infer<typeof IssueLetterRequest>;

export const IssuedLetter = z.object({
  publicId: PublicId, kind: LetterKind, person: PersonRef, employment: LetterJob,
  title: z.string(), body: z.string(), issuedBy: PersonRef, issuedAt: Instant,
});
export type IssuedLetter = z.infer<typeof IssuedLetter>;

/** path :company is a company code (AE, ATPL). */
export const LetterCompanyParam = z.string().trim().min(1).max(12);
