import { z } from 'zod';
import { Instant, PublicId } from '../common';
/**
 * The Core customer list: who work is done for. A company of the group (AE) is a customer too, linked to that company,
 * so work one group company does for another is billed through Intercompany. Customers are never deleted (inactive).
 */

const emptyToUndefined = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

export const CustomerStatus = z.enum(['active', 'inactive']);
export type CustomerStatus = z.infer<typeof CustomerStatus>;

const code = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9-]{0,19}$/, 'Use 1 to 20 capital letters, digits or "-" (e.g. AE, PVR-CINEMAS)');
const name = z.string().trim().min(2, 'At least 2 characters').max(200);

/** POST /api/core/customers — a new customer. company: the group company this customer is (e.g. AE); left out for an outside customer. */
export const CreateCustomerRequest = z.object({
  publicId: z.string().uuid().optional(),
  code,
  name,
  company: z.string().trim().min(1).max(12).optional(),
});
export type CreateCustomerRequest = z.infer<typeof CreateCustomerRequest>;

/** PATCH /api/core/customers/:publicId — the name, or active / inactive. The code and the company never change. */
export const UpdateCustomerRequest = z.object({ name: name.optional(), status: CustomerStatus.optional() })
  .refine((v) => v.name !== undefined || v.status !== undefined, { message: 'Send the name or the status' });
export type UpdateCustomerRequest = z.infer<typeof UpdateCustomerRequest>;

/** GET /api/core/customers?q=&status= — q matches the code or the name. */
export const CustomersQuery = z.object({ q: emptyToUndefined(z.string().trim().max(100)), status: emptyToUndefined(CustomerStatus) });
export type CustomersQuery = z.infer<typeof CustomersQuery>;

export const Customer = z.object({
  publicId: PublicId, code: z.string(), name: z.string(),
  /** the group company this customer is (e.g. AE), or null for an outside customer */
  company: z.string().nullable(),
  status: CustomerStatus, createdAt: Instant,
});
export type Customer = z.infer<typeof Customer>;
