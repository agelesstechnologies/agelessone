import { z } from 'zod';
import { DateOnly, Instant, PersonRef, PublicId } from './common';
import { LocationRef, Quantity, UnitRef } from './inventory';
/**
 * Part requests (Froid's "Parts required"): a ticket's assignee asks for parts; the store in-charge approves (and the
 * department head too above the company's value limit); approval reserves the stock until the request is issued,
 * cancelled, its ticket closes or the reservation expires. Cross-company grants let a person from the other company
 * request for one ticket until an end date. Requesters never see values. Guide: backend/docs/api/inventory.md.
 */

const emptyToUndefined = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
const queryBool = z.enum(['true', 'false']).transform((v) => v === 'true');
const company = z.string().trim().min(1).max(12);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((d) => !Number.isNaN(Date.parse(d)), 'Not a real date');
const reason = z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(300);

/**
 * pending: waiting for approval. approved: stock reserved. fulfilled: everything issued. rejected, cancelled: never
 * issued (or the rest released). expired: the reservation ran out. closed: its ticket was completed or cancelled.
 */
export const PartRequestStatus = z.enum(['pending', 'approved', 'fulfilled', 'rejected', 'cancelled', 'expired', 'closed']);
export type PartRequestStatus = z.infer<typeof PartRequestStatus>;

/** POST /api/inventory/requests — parts for a ticket. */
export const CreatePartRequest = z.object({
  publicId: z.string().uuid().optional(),
  ticketPublicId: z.string().uuid(),
  note: z.string().trim().min(1).max(500).optional(),
  lines: z.array(z.object({ itemPublicId: z.string().uuid(), quantity: Quantity.positive('The quantity must be more than 0') }))
    .min(1, 'Ask for at least one item').max(50).refine((l) => new Set(l.map((x) => x.itemPublicId)).size === l.length, 'List each item once'),
});
export type CreatePartRequest = z.infer<typeof CreatePartRequest>;

/**
 * POST /api/inventory/requests/:id/approve — as store in-charge (locations: where to reserve each line from; left out,
 * the item's default location or the first with enough available) and/or as the ticket's department head. When every
 * approval it needs is in, the stock is reserved until reserveUntil (default: today + policy inventory.requests.reserve_days).
 */
export const ApprovePartRequest = z.object({
  locations: z.array(z.object({ lineNo: z.number().int().min(1), locationPublicId: z.string().uuid() })).max(50).optional(),
  reserveUntil: isoDate.optional(),
});
export type ApprovePartRequest = z.infer<typeof ApprovePartRequest>;

export const RejectPartRequest = z.object({ reason });
export type RejectPartRequest = z.infer<typeof RejectPartRequest>;
export const CancelPartRequest = z.object({ reason: reason.optional() });
export type CancelPartRequest = z.infer<typeof CancelPartRequest>;

/** GET /api/inventory/requests — your own; the store's for its companies; a head's for their departments' tickets. */
export const PartRequestsQuery = z.object({
  company: emptyToUndefined(company),
  status: emptyToUndefined(PartRequestStatus),
  ticket: emptyToUndefined(z.string().uuid()),
  mine: emptyToUndefined(queryBool),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
export type PartRequestsQuery = z.infer<typeof PartRequestsQuery>;

const ItemBrief = z.object({ publicId: PublicId, code: z.string(), name: z.string() });
const TicketBrief = z.object({ publicId: PublicId, number: z.string(), title: z.string() });

export const Reservation = z.object({ location: LocationRef, batchNo: z.string().nullable(), expiryDate: DateOnly.nullable(), quantity: z.number() });
export type Reservation = z.infer<typeof Reservation>;

export const PartRequestLine = z.object({
  lineNo: z.number().int(), item: ItemBrief, unit: UnitRef,
  quantity: z.number(), reserved: z.number(), issued: z.number(),
  /** where the store in-charge chose to reserve from */
  location: LocationRef.nullable(),
  reservations: z.array(Reservation),
  /** null for people who do not see values (requesters) */
  estimatedValueMinor: z.number().int().nullable(),
});
export type PartRequestLine = z.infer<typeof PartRequestLine>;

export const PartRequest = z.object({
  publicId: PublicId, company: z.string(), number: z.string(), status: PartRequestStatus, ticket: TicketBrief,
  requestedBy: PersonRef,
  /** asked through a cross-company grant */
  crossCompany: z.boolean(),
  note: z.string().nullable(),
  needsHeadApproval: z.boolean(),
  storeApprovedBy: PersonRef.nullable(), storeApprovedAt: Instant.nullable(),
  headApprovedBy: PersonRef.nullable(), headApprovedAt: Instant.nullable(),
  decidedBy: PersonRef.nullable(), decisionReason: z.string().nullable(),
  reserveUntil: DateOnly.nullable(),
  /** null for people who do not see values */
  estimatedValueMinor: z.number().int().nullable(), currency: z.string(),
  lines: z.array(PartRequestLine),
  /** what the caller may do now */
  canApprove: z.boolean(), canCancel: z.boolean(),
  createdAt: Instant,
});
export type PartRequest = z.infer<typeof PartRequest>;
export const PartRequestList = z.object({ items: z.array(PartRequest), page: z.number().int(), pageSize: z.number().int(), total: z.number().int() });
export type PartRequestList = z.infer<typeof PartRequestList>;

/** GET /api/inventory/requests/items?ticket=&search= — what a requester may ask for on that ticket: no quantities, no values. */
export const RequestItemsQuery = z.object({
  ticket: z.string().uuid(),
  search: emptyToUndefined(z.string().trim().max(100)),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type RequestItemsQuery = z.infer<typeof RequestItemsQuery>;
export const RequestItem = z.object({ publicId: PublicId, code: z.string(), name: z.string(), unit: UnitRef, inStock: z.boolean() });
export type RequestItem = z.infer<typeof RequestItem>;

/** GET /api/inventory/tickets/:id/parts — a ticket's requests and the parts issued and returned on it. */
export const TicketParts = z.object({
  ticket: TicketBrief.extend({ company: z.string() }),
  canRequest: z.boolean(),
  showsValues: z.boolean(),
  requests: z.array(PartRequest),
  documents: z.array(z.object({
    publicId: PublicId, number: z.string(), type: z.enum(['issue', 'return']), status: z.string(), documentDate: DateOnly,
    lines: z.array(z.object({ lineNo: z.number().int(), item: ItemBrief, unit: UnitRef, quantity: z.number(), batchNo: z.string().nullable(),
      serialNo: z.string().nullable(), valueMinor: z.number().int().nullable() })),
  })),
});
export type TicketParts = z.infer<typeof TicketParts>;

// ---- cross-company grants ----

/**
 * POST /api/inventory/grants — the store in-charge of `company` lets a person from another company request parts for one
 * of its tickets until validUntil (inclusive). The person requests only: no values, no approvals.
 */
export const CreateGrantRequest = z.object({
  publicId: z.string().uuid().optional(),
  company,
  personPublicId: z.string().uuid(),
  ticketPublicId: z.string().uuid(),
  validUntil: isoDate,
});
export type CreateGrantRequest = z.infer<typeof CreateGrantRequest>;

export const GrantsQuery = z.object({ company: emptyToUndefined(company), active: emptyToUndefined(queryBool) });
export type GrantsQuery = z.infer<typeof GrantsQuery>;

export const Grant = z.object({
  publicId: PublicId, company: z.string(), person: PersonRef, ticket: TicketBrief, validUntil: DateOnly, active: z.boolean(),
  grantedBy: PersonRef, createdAt: Instant, endedBy: PersonRef.nullable(), endedAt: Instant.nullable(),
});
export type Grant = z.infer<typeof Grant>;
