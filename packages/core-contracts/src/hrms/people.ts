import { z } from 'zod';
/** People requests and responses, shared by the API and the web app. */

export const ContactKind = z.enum(['phone', 'email', 'other']);
export const EngagementType = z.enum(['permanent', 'probation', 'contract', 'intern', 'external']);
export const EmploymentStatus = z.enum(['active', 'notice', 'exited']);

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((d) => !Number.isNaN(Date.parse(d)), 'Not a real date');
const emptyToUndefined = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

export const ContactInput = z.object({
  kind: ContactKind,
  value: z.string().trim().min(3).max(100),
  label: z.string().trim().max(40).optional(),
  isPrimary: z.boolean().optional(),
}).refine((c) => c.kind !== 'email' || z.string().email().safeParse(c.value).success, { message: 'Not a valid email', path: ['value'] });
export type ContactInput = z.infer<typeof ContactInput>;

export const EmploymentInput = z.object({
  legalEntityCode: z.string().trim().min(1).max(12),   // company: AE, ATPL ...
  employeeCode: z.string().trim().min(1).max(20),
  engagementType: EngagementType,
  joinedOn: isoDate,
  department: z.string().trim().max(80).optional(),
  designation: z.string().trim().max(80).optional(),
  managerPublicId: z.string().uuid().optional(),
  isPrimary: z.boolean().optional(),
});
export type EmploymentInput = z.infer<typeof EmploymentInput>;

/** POST /api/hrms/people: person, contacts and first employment together. The first employment is always primary. */
export const CreatePersonRequest = z.object({
  displayName: z.string().trim().min(2).max(100),
  contacts: z.array(ContactInput).max(10).default([]),
  employment: EmploymentInput.extend({ isPrimary: z.literal(true).optional() }),
}).refine((p) => ContactKind.options.every((k) => p.contacts.filter((c) => c.kind === k && c.isPrimary).length <= 1),
  { message: 'Only one primary contact per kind', path: ['contacts'] });
export type CreatePersonRequest = z.infer<typeof CreatePersonRequest>;

/** POST /api/hrms/people/:publicId/employments: another employment for an existing person. */
export const AddEmploymentRequest = EmploymentInput;
export type AddEmploymentRequest = z.infer<typeof AddEmploymentRequest>;

/** GET /api/hrms/people: search name, employee code or contact; company and status filter on the person's employments. */
export const ListPeopleQuery = z.object({
  search: emptyToUndefined(z.string().trim().max(100)),
  company: emptyToUndefined(z.string().trim().max(12)),
  status: emptyToUndefined(EmploymentStatus),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListPeopleQuery = z.infer<typeof ListPeopleQuery>;

export interface PersonListItem {
  publicId: string; displayName: string; status: string;
  primaryEmployment: { company: string; employeeCode: string; department: string | null; designation: string | null; status: string } | null;
}
export interface PersonList { items: PersonListItem[]; page: number; pageSize: number; total: number }

export interface PersonDetail {
  publicId: string; displayName: string; status: string;
  contacts: { publicId: string; kind: string; value: string; label: string | null; isPrimary: boolean; endedAt: string | null }[];
  employments: {
    publicId: string; company: { code: string; name: string }; employeeCode: string; engagementType: string;
    status: string; isPrimary: boolean; joinedOn: string; exitOn: string | null;
    department: string | null; designation: string | null; manager: { publicId: string; displayName: string } | null;
  }[];
}
