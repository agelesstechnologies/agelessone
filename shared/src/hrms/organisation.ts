import { z } from 'zod';
import { Instant, PersonRef, PublicId } from '../common';
/** Departments, designations and positions of a company: shared by the API and the web app. */

const emptyToUndefined = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
const company = z.string().trim().min(1).max(12);
const prefix = z.string().trim().regex(/^[A-Z]{2,6}$/, '2 to 6 capital letters, e.g. ATS');

export const Department = z.object({ publicId: PublicId, company: z.string(), name: z.string(), codePrefix: z.string(), head: PersonRef.nullable() });
export type Department = z.infer<typeof Department>;
/** GET /api/hrms/departments?company= */
export const DepartmentsQuery = z.object({ company: emptyToUndefined(company) });
export type DepartmentsQuery = z.infer<typeof DepartmentsQuery>;
/** POST /api/hrms/departments */
export const CreateDepartmentRequest = z.object({ company, name: z.string().trim().min(2).max(80), codePrefix: prefix });
export type CreateDepartmentRequest = z.infer<typeof CreateDepartmentRequest>;
/** PATCH /api/hrms/departments/:publicId — headPublicId null clears the head. */
export const UpdateDepartmentRequest = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  headPublicId: z.string().uuid().nullable().optional(),
}).refine((r) => r.name !== undefined || r.headPublicId !== undefined, { message: 'Send name and/or headPublicId' });
export type UpdateDepartmentRequest = z.infer<typeof UpdateDepartmentRequest>;

export const Designation = z.object({ publicId: PublicId, company: z.string(), name: z.string() });
export type Designation = z.infer<typeof Designation>;
/** GET /api/hrms/designations?company= */
export const DesignationsQuery = z.object({ company: emptyToUndefined(company) });
export type DesignationsQuery = z.infer<typeof DesignationsQuery>;

export const PositionStatus = z.enum(['planned', 'open', 'filled']);
export type PositionStatus = z.infer<typeof PositionStatus>;
export const Position = z.object({
  publicId: PublicId, company: z.string(),
  department: z.object({ code: z.string(), name: z.string() }),
  designation: z.string(),
  status: PositionStatus,
  notes: z.string().nullable(),
  filledBy: z.object({ employmentPublicId: PublicId, employeeCode: z.string(), person: PersonRef }).nullable(),
  filledAt: Instant.nullable(), createdAt: Instant,
});
export type Position = z.infer<typeof Position>;
/** GET /api/hrms/positions?company=&department=&status= */
export const PositionsQuery = z.object({
  company: emptyToUndefined(company), department: emptyToUndefined(prefix), status: emptyToUndefined(PositionStatus),
});
export type PositionsQuery = z.infer<typeof PositionsQuery>;
/** POST /api/hrms/positions — designation is one of the company's designation names. */
export const CreatePositionRequest = z.object({
  publicId: z.string().uuid().optional(),
  company, departmentCode: prefix,
  designation: z.string().trim().min(2).max(80),
  status: z.enum(['planned', 'open']).default('planned'),
  notes: z.string().trim().max(500).optional(),
});
export type CreatePositionRequest = z.infer<typeof CreatePositionRequest>;
/** POST /api/hrms/positions/:publicId/status — between planned and open (filling uses /fill). */
export const PositionStatusRequest = z.object({ status: z.enum(['planned', 'open']) });
export type PositionStatusRequest = z.infer<typeof PositionStatusRequest>;
/** POST /api/hrms/positions/:publicId/fill — the employment of the person hired (same company). */
export const FillPositionRequest = z.object({ employmentPublicId: z.string().uuid() });
export type FillPositionRequest = z.infer<typeof FillPositionRequest>;
