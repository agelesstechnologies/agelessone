import { z } from 'zod';
import { DateOnly, Instant, PersonRef, PublicId } from './common';
import { EventEnvelope } from './events/envelope';
import { LocationRef, Quantity, UnitRef } from './inventory';
/**
 * Inventory stock: documents (receipt, issue, return, transfer, reversal) that move stock, the stock on hand, and the
 * events they publish. Every movement is a document; stock is never edited directly, mistakes are reversed. Quantities
 * are in the item's base unit; money is integer minor units (paise) with its currency. Guide: backend/docs/api/inventory.md.
 */

const emptyToUndefined = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
const queryBool = z.enum(['true', 'false']).transform((v) => v === 'true');
const company = z.string().trim().min(1).max(12);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((d) => !Number.isNaN(Date.parse(d)), 'Not a real date');
const note = z.string().trim().min(1).max(500);
const reason = z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(300);
const lines = <T extends z.ZodTypeAny>(line: T) => z.array(line).min(1, 'Add at least one line').max(200, 'At most 200 lines in one document');
const positive = Quantity.positive('The quantity must be more than 0');
const batchNo = z.string().trim().min(1).max(60);
const serialNo = z.string().trim().min(1).max(80);

export const StockDocumentType = z.enum(['receipt', 'issue', 'return', 'transfer', 'reversal']);
export type StockDocumentType = z.infer<typeof StockDocumentType>;
/** posted: done. in_transit: a transfer sent but not yet received. reversed: a reversal document undid it. */
export const StockDocumentStatus = z.enum(['posted', 'in_transit', 'reversed']);
export type StockDocumentStatus = z.infer<typeof StockDocumentStatus>;
/** Where a returned part goes: usable → a store, rack, bin, work area or testing space; repair → quarantine; scrap → scrap. */
export const ReturnCondition = z.enum(['usable', 'repair', 'scrap']);
export type ReturnCondition = z.infer<typeof ReturnCondition>;

// ---- create documents ----

/**
 * POST /api/inventory/receipts — goods arriving from a supplier. Until purchase orders exist every receipt is a direct
 * purchase and needs a reason. Each line: quantity in the base unit or one of the item's conversion units (unitPublicId),
 * cost per that unit in minor units; the location defaults to the item's default location.
 */
export const CreateReceiptRequest = z.object({
  publicId: z.string().uuid().optional(),
  company,
  documentDate: isoDate.optional(),
  supplierName: z.string().trim().min(2).max(120),
  challanNo: z.string().trim().min(1).max(60).optional(),
  reason,
  note: note.optional(),
  lines: lines(z.object({
    itemPublicId: z.string().uuid(),
    locationPublicId: z.string().uuid().optional(),
    quantity: positive,
    unitPublicId: z.string().uuid().optional(),
    unitCostMinor: z.number().int().min(0).max(10_000_000_000),
    /** batch items: the batch received (expiry optional) */
    batchNo: batchNo.optional(),
    expiryDate: isoDate.optional(),
    /** serial items: one unit per line, its serial number */
    serialNo: serialNo.optional(),
  })),
});
export type CreateReceiptRequest = z.infer<typeof CreateReceiptRequest>;

/**
 * POST /api/inventory/issues — parts handed out for a ticket of the same company, at the average cost at that moment.
 * Either against an approved part request (requestPublicId + requestLines: it takes the request's reserved stock), or
 * directly (ticketPublicId + lines: only stock that is not reserved). Batch items without a batch take the earliest
 * expiry first; serial items are one unit per line with its serial number.
 */
export const CreateIssueRequest = z.object({
  publicId: z.string().uuid().optional(),
  company,
  documentDate: isoDate.optional(),
  ticketPublicId: z.string().uuid().optional(),
  note: note.optional(),
  lines: lines(z.object({
    itemPublicId: z.string().uuid(), locationPublicId: z.string().uuid(), quantity: positive,
    batchNo: batchNo.optional(), serialNo: serialNo.optional(),
  })).optional(),
  requestPublicId: z.string().uuid().optional(),
  requestLines: lines(z.object({
    lineNo: z.number().int().min(1),
    /** left out: everything still to issue on that line */
    quantity: positive.optional(),
    /** serial items: the units handed out */
    serialNos: z.array(serialNo).min(1).max(200).optional(),
  })).optional(),
}).superRefine((r, c) => {
  const direct = r.ticketPublicId !== undefined || r.lines !== undefined;
  const against = r.requestPublicId !== undefined || r.requestLines !== undefined;
  if (direct === against) c.addIssue({ code: z.ZodIssueCode.custom, path: ['requestPublicId'], message: 'Send either ticketPublicId with lines, or requestPublicId with requestLines' });
  else if (direct && (!r.ticketPublicId || !r.lines)) c.addIssue({ code: z.ZodIssueCode.custom, path: ['lines'], message: 'A direct issue needs ticketPublicId and lines' });
  else if (against && (!r.requestPublicId || !r.requestLines)) c.addIssue({ code: z.ZodIssueCode.custom, path: ['requestLines'], message: 'An issue against a request needs requestPublicId and requestLines' });
});
export type CreateIssueRequest = z.infer<typeof CreateIssueRequest>;

/**
 * POST /api/inventory/returns — parts coming back from an issue (lineNo: the issue's line), at the cost they were issued
 * at. The location follows the condition; left out: usable goes back where it came from, repair and scrap to the
 * company's only quarantine or scrap location.
 */
export const CreateReturnRequest = z.object({
  publicId: z.string().uuid().optional(),
  issuePublicId: z.string().uuid(),
  documentDate: isoDate.optional(),
  note: note.optional(),
  lines: lines(z.object({
    lineNo: z.number().int().min(1),
    quantity: positive,
    condition: ReturnCondition,
    locationPublicId: z.string().uuid().optional(),
  })),
});
export type CreateReturnRequest = z.infer<typeof CreateReturnRequest>;

/**
 * POST /api/inventory/transfers — stock moving between two locations of the same company: it leaves now and waits in the
 * transit location (default: the company's only one) until received (POST /transfers/:id/receive).
 */
export const CreateTransferRequest = z.object({
  publicId: z.string().uuid().optional(),
  company,
  documentDate: isoDate.optional(),
  transitLocationPublicId: z.string().uuid().optional(),
  note: note.optional(),
  lines: lines(z.object({
    itemPublicId: z.string().uuid(),
    fromLocationPublicId: z.string().uuid(),
    toLocationPublicId: z.string().uuid(),
    quantity: positive,
    batchNo: batchNo.optional(),
    serialNo: serialNo.optional(),
  }).refine((l) => l.fromLocationPublicId !== l.toLocationPublicId, { message: 'From and to must be different locations', path: ['toLocationPublicId'] })),
});
export type CreateTransferRequest = z.infer<typeof CreateTransferRequest>;

/** POST /api/inventory/documents/:id/reverse — undo a posted document with a reversal document. */
export const ReverseDocumentRequest = z.object({ publicId: z.string().uuid().optional(), reason });
export type ReverseDocumentRequest = z.infer<typeof ReverseDocumentRequest>;

// ---- read ----

/** GET /api/inventory/documents */
export const StockDocumentsQuery = z.object({
  company: emptyToUndefined(company),
  type: emptyToUndefined(StockDocumentType),
  status: emptyToUndefined(StockDocumentStatus),
  ticket: emptyToUndefined(z.string().uuid()),
  from: emptyToUndefined(isoDate),
  to: emptyToUndefined(isoDate),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
export type StockDocumentsQuery = z.infer<typeof StockDocumentsQuery>;

const ItemBrief = z.object({ publicId: PublicId, code: z.string(), name: z.string() });

export const StockDocumentLine = z.object({
  lineNo: z.number().int(),
  item: ItemBrief,
  /** in the base unit */
  quantity: z.number(),
  unit: UnitRef,
  /** as received, when a conversion unit was used */
  enteredQuantity: z.number().nullable(),
  enteredUnit: UnitRef.nullable(),
  /** receipt / return: into; issue / transfer: from */
  location: LocationRef,
  /** transfer: to */
  toLocation: LocationRef.nullable(),
  condition: ReturnCondition.nullable(),
  /** return: the issue line it returns */
  returnOfLineNo: z.number().int().nullable(),
  batchNo: z.string().nullable(),
  expiryDate: DateOnly.nullable(),
  serialNo: z.string().nullable(),
  /** issue against a request: the request line it fills */
  requestLineNo: z.number().int().nullable(),
  /** minor units per base unit (may have decimals); recorded when posted and never changed */
  unitCostMinor: z.number(),
  valueMinor: z.number().int(),
  currency: z.string(),
});
export type StockDocumentLine = z.infer<typeof StockDocumentLine>;

const DocumentRef = z.object({ publicId: PublicId, number: z.string(), type: StockDocumentType });

export const StockDocumentSummary = z.object({
  publicId: PublicId, company: z.string(), type: StockDocumentType, number: z.string(), status: StockDocumentStatus, documentDate: DateOnly,
  supplierName: z.string().nullable(), ticket: z.object({ publicId: PublicId, number: z.string(), title: z.string() }).nullable(),
  original: DocumentRef.nullable(), reversal: DocumentRef.nullable(),
  /** issue against a part request */
  request: z.object({ publicId: PublicId, number: z.string() }).nullable(),
  lineCount: z.number().int(), totalValueMinor: z.number().int(), currency: z.string(), createdBy: PersonRef, createdAt: Instant,
});
export type StockDocumentSummary = z.infer<typeof StockDocumentSummary>;

export const StockDocument = StockDocumentSummary.extend({
  challanNo: z.string().nullable(),
  hasChallan: z.boolean(),
  reason: z.string().nullable(),
  note: z.string().nullable(),
  transitLocation: LocationRef.nullable(),
  receivedBy: PersonRef.nullable(),
  receivedAt: Instant.nullable(),
  lines: z.array(StockDocumentLine),
});
export type StockDocument = z.infer<typeof StockDocument>;
export const StockDocumentList = z.object({ items: z.array(StockDocumentSummary), page: z.number().int(), pageSize: z.number().int(), total: z.number().int() });
export type StockDocumentList = z.infer<typeof StockDocumentList>;

/** GET /api/inventory/stock — stock on hand by item and location. */
export const StockQuery = z.object({
  company: emptyToUndefined(company),
  item: emptyToUndefined(z.string().uuid()),
  location: emptyToUndefined(z.string().uuid()),
  /** also rows that are empty now */
  includeEmpty: emptyToUndefined(queryBool),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
export type StockQuery = z.infer<typeof StockQuery>;

/**
 * One item in one location. available = onHand − reserved. avgCostMinor is the item's moving average for the whole
 * company (minor units per base unit); valueMinor = onHand × that average.
 */
export const StockRow = z.object({
  company: z.string(), item: ItemBrief, unit: UnitRef, location: LocationRef,
  batch: z.object({ batchNo: z.string(), expiryDate: DateOnly.nullable() }).nullable(),
  onHand: z.number(), reserved: z.number(), available: z.number(), avgCostMinor: z.number(), valueMinor: z.number().int(), currency: z.string(),
});
export type StockRow = z.infer<typeof StockRow>;
export const StockList = z.object({ items: z.array(StockRow), page: z.number().int(), pageSize: z.number().int(), total: z.number().int() });
export type StockList = z.infer<typeof StockList>;

/** GET /api/inventory/stock/batches?item=&location= — an item's batches with stock, earliest expiry first (no expiry last). */
export const StockBatchesQuery = z.object({ item: z.string().uuid(), location: emptyToUndefined(z.string().uuid()) });
export type StockBatchesQuery = z.infer<typeof StockBatchesQuery>;
export const StockBatch = z.object({
  batchNo: z.string(), expiryDate: DateOnly.nullable(), location: LocationRef, onHand: z.number(), reserved: z.number(), available: z.number(),
});
export type StockBatch = z.infer<typeof StockBatch>;

// ---- events (written to core.outbox in the same transaction) ----

export type StockEventType = 'stock.received' | 'stock.issued' | 'stock.returned' | 'stock.transferred' | 'stock.adjusted';
export interface StockEventLine {
  itemPublicId: string; itemCode: string; locationPublicId: string; batchNo: string | null; serialNo: string | null;
  /** base units; negative when stock left the location */
  quantity: number;
  unitCostMinor: number; valueMinor: number; currency: string;
}
/**
 * stock.received (receipt), stock.issued (issue: ticket and project, unit cost per line), stock.returned (return),
 * stock.transferred (phase dispatched or received), stock.adjusted (reason reversal: the reversed document undone).
 */
export type StockEvent = EventEnvelope<StockEventType, {
  company: string; documentPublicId: string; documentNumber: string; documentType: StockDocumentType; documentDate: string;
  ticketPublicId: string | null; projectId: string | null; requestPublicId: string | null; phase: 'dispatched' | 'received' | null;
  reason: string | null; reversalOf: string | null; lines: StockEventLine[]; totalValueMinor: number; currency: string;
}>;
