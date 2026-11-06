import { z } from 'zod';
import { Instant, PersonRef, PublicId } from './common';
/** Tickets: ticket types (what a kind of work asks for and what it needs to be completed). Editing a type makes a new version. */

const emptyToUndefined = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
const queryBool = z.enum(['true', 'false']).transform((v) => v === 'true');

export const TicketFieldType = z.enum(['text', 'number', 'date', 'money', 'file', 'person', 'customer']);
export type TicketFieldType = z.infer<typeof TicketFieldType>;

/** One question a ticket of this type asks. `money` values are integer paise. */
export const TicketField = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'Use lower-case letters, digits and _, starting with a letter'),
  label: z.string().trim().min(1).max(80),
  type: TicketFieldType,
  required: z.boolean().default(false),
});
export type TicketField = z.infer<typeof TicketField>;
const Fields = z.array(TicketField).max(40).refine((f) => new Set(f.map((x) => x.key)).size === f.length, 'Field keys must be different');

/** What must be in place before a ticket of this type can be completed. */
export const CompletionRules = z.object({
  photo_required: z.boolean().default(false),
  file_required: z.boolean().default(false),
  checklist_required: z.boolean().default(false),
  customer_signoff_required: z.boolean().default(false),
  head_approval_required: z.boolean().default(false),
  daily_update_required: z.boolean().default(false),
});
export type CompletionRules = z.infer<typeof CompletionRules>;

const ChecklistItems = z.array(z.string().trim().min(1).max(120)).max(40);
const typeName = z.string().trim().min(2).max(80);
const sortOrder = z.number().int().min(0).max(10000);

/** A rule that needs a checklist must have one. */
const checklistRule = (v: { completionRules?: CompletionRules; checklistItems?: string[] }) =>
  !v.completionRules?.checklist_required || (v.checklistItems?.length ?? 0) > 0;
const CHECKLIST_MESSAGE = 'checklistItems needs at least one item when checklist_required is on';

/** GET /api/tickets/types?active=&department=&company= */
export const TicketTypesQuery = z.object({
  active: emptyToUndefined(queryBool),
  department: emptyToUndefined(z.string().uuid()),
  company: emptyToUndefined(z.string().trim().min(1).max(12)),
});
export type TicketTypesQuery = z.infer<typeof TicketTypesQuery>;

/** POST /api/tickets/types — a new type (never a standard one). Without ownerDepartmentPublicId it is company-wide (admin and Management only). */
export const CreateTicketTypeRequest = z.object({
  publicId: z.string().uuid().optional(),
  company: z.string().trim().min(1).max(12),
  code: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, 'Use lower-case letters, digits and _, starting with a letter'),
  name: typeName,
  ownerDepartmentPublicId: z.string().uuid().optional(),
  sortOrder: sortOrder.default(100),
  fields: Fields.default([]),
  completionRules: CompletionRules.default({}),
  checklistItems: ChecklistItems.default([]),
}).refine(checklistRule, { message: CHECKLIST_MESSAGE, path: ['checklistItems'] });
export type CreateTicketTypeRequest = z.infer<typeof CreateTicketTypeRequest>;

/** PATCH /api/tickets/types/:id — send only what changes; a real change makes a new version. */
export const UpdateTicketTypeRequest = z.object({
  /** The version you were looking at; refused with 409 when someone has saved a newer one. */
  expectedVersion: z.number().int().min(1).optional(),
  name: typeName.optional(),
  /** null = company-wide. Admin and Management only. */
  ownerDepartmentPublicId: z.string().uuid().nullable().optional(),
  sortOrder: sortOrder.optional(),
  fields: Fields.optional(),
  completionRules: CompletionRules.optional(),
  checklistItems: ChecklistItems.optional(),
}).refine((v) => Object.keys(v).some((k) => k !== 'expectedVersion'), { message: 'Send at least one field to change' });
export type UpdateTicketTypeRequest = z.infer<typeof UpdateTicketTypeRequest>;

const DepartmentRef = z.object({ publicId: PublicId, name: z.string() });
const Content = {
  name: z.string(),
  ownerDepartment: DepartmentRef.nullable(),
  sortOrder: z.number().int(),
  fields: z.array(TicketField),
  completionRules: CompletionRules,
  checklistItems: z.array(z.string()),
  createdBy: PersonRef,
  createdAt: Instant,
};

/** One saved version of a type. */
export const TicketTypeVersion = z.object({ version: z.number().int(), isCurrent: z.boolean(), ...Content });
export type TicketTypeVersion = z.infer<typeof TicketTypeVersion>;

/** A type as it stands now (its newest version). publicId is the type's id; it stays the same across versions. */
export const TicketType = z.object({
  publicId: PublicId, version: z.number().int(), company: z.string(), code: z.string(), isStandard: z.boolean(), active: z.boolean(), ...Content,
});
export type TicketType = z.infer<typeof TicketType>;

/** GET /api/tickets/types/:id — the type with every version, newest first. */
export const TicketTypeDetail = TicketType.extend({ versions: z.array(TicketTypeVersion) });
export type TicketTypeDetail = z.infer<typeof TicketTypeDetail>;
