import { z } from 'zod';
import { Instant, PersonRef, PublicId } from './common';
/**
 * Inventory: each company's units, item categories, items (with unit conversions) and store locations. Companies are kept
 * completely apart: every record belongs to one company and points only at that company's records. Quantities are in the
 * item's base unit, up to 4 decimals (the unit may allow fewer). Full guide: backend/docs/api/inventory.md.
 */

const emptyToUndefined = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
const queryBool = z.enum(['true', 'false']).transform((v) => v === 'true');
const company = z.string().trim().min(1).max(12);
const atLeastOne = (v: Record<string, unknown>) => Object.values(v).some((x) => x !== undefined);
const AT_LEAST_ONE = 'Send at least one field to change';

/** Records are never deleted: inactive ones are kept, but take no new use. */
export const RecordStatus = z.enum(['active', 'inactive']);
export type RecordStatus = z.infer<typeof RecordStatus>;

/** Where stock sits. A rack is inside a store; a bin inside a store or a rack; the other types stand on their own. */
export const LocationType = z.enum(['store', 'rack', 'bin', 'work_area', 'testing', 'transit', 'quarantine', 'scrap']);
export type LocationType = z.infer<typeof LocationType>;

/** How closely an item is followed: quantity only (none), by batch, or by serial number (one piece each). */
export const ItemTracking = z.enum(['none', 'batch', 'serial']);
export type ItemTracking = z.infer<typeof ItemTracking>;

/** A quantity in an item's base unit: 0 or more, at most 4 decimals (the unit may allow fewer). */
export const Quantity = z.number().min(0).max(999_999_999).multipleOf(0.0001, 'Use at most 4 decimals');
/** How many base units one of another unit holds (a box of 100 pieces: 100; a foot in metres: 0.3048). */
export const ConversionFactor = z.number().positive().max(1_000_000).multipleOf(0.000001, 'Use at most 6 decimals');

export const UnitCode = z.string().trim().toLowerCase()
  .regex(/^[a-z][a-z0-9_.]{0,11}$/, 'Use up to 12 letters, digits, _ or ., starting with a letter (e.g. pcs, m, kg)');
export const CodePrefix = z.string().trim().toUpperCase()
  .regex(/^[A-Z][A-Z0-9]{1,5}$/, 'Use 2–6 capital letters or digits, starting with a letter (e.g. EC)');
/** Item and location codes: kept in capitals, unique per company. */
export const InventoryCode = z.string().trim().toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9._/-]{0,29}$/, 'Use up to 30 letters, digits and . _ / -, starting with a letter or digit');
/** GST HSN or SAC code: 4, 6 or 8 digits. */
export const HsnCode = z.string().trim().regex(/^(\d{4}|\d{6}|\d{8})$/, 'Use an HSN/SAC code of 4, 6 or 8 digits');

const unitName = z.string().trim().min(1).max(40);
const categoryName = z.string().trim().min(2).max(60);
const itemName = z.string().trim().min(2).max(120);
const description = z.string().trim().min(1).max(1000);
const locationName = z.string().trim().min(2).max(80);
const decimals = z.number().int().min(0).max(4);

// ---- units ----

/** GET /api/inventory/units?company=&status= */
export const UnitsQuery = z.object({ company: emptyToUndefined(company), status: emptyToUndefined(RecordStatus) });
export type UnitsQuery = z.infer<typeof UnitsQuery>;

/** POST /api/inventory/units — the code never changes; decimals: 0 for pieces, 2 for metres, 3 for kilograms. */
export const CreateUnitRequest = z.object({ publicId: z.string().uuid().optional(), company, code: UnitCode, name: unitName, decimals });
export type CreateUnitRequest = z.infer<typeof CreateUnitRequest>;

/** PATCH /api/inventory/units/:id — decimals only while no item uses the unit. Inactive units take no new items. */
export const UpdateUnitRequest = z.object({ name: unitName.optional(), decimals: decimals.optional(), status: RecordStatus.optional() })
  .refine(atLeastOne, AT_LEAST_ONE);
export type UpdateUnitRequest = z.infer<typeof UpdateUnitRequest>;

export const Unit = z.object({
  publicId: PublicId, company: z.string(), code: z.string(), name: z.string(), decimals: z.number().int(), status: RecordStatus,
  createdBy: PersonRef, createdAt: Instant,
});
export type Unit = z.infer<typeof Unit>;
export const UnitRef = z.object({ publicId: PublicId, code: z.string(), name: z.string(), decimals: z.number().int() });
export type UnitRef = z.infer<typeof UnitRef>;

// ---- categories ----

/** GET /api/inventory/categories?company=&status= */
export const CategoriesQuery = z.object({ company: emptyToUndefined(company), status: emptyToUndefined(RecordStatus) });
export type CategoriesQuery = z.infer<typeof CategoriesQuery>;

/** POST /api/inventory/categories — codePrefix starts the item codes made for it (EC → EC-0001) and never changes. */
export const CreateCategoryRequest = z.object({ publicId: z.string().uuid().optional(), company, name: categoryName, codePrefix: CodePrefix });
export type CreateCategoryRequest = z.infer<typeof CreateCategoryRequest>;

/** PATCH /api/inventory/categories/:id — inactive categories take no new items; their items keep them. */
export const UpdateCategoryRequest = z.object({ name: categoryName.optional(), status: RecordStatus.optional() }).refine(atLeastOne, AT_LEAST_ONE);
export type UpdateCategoryRequest = z.infer<typeof UpdateCategoryRequest>;

export const Category = z.object({
  publicId: PublicId, company: z.string(), name: z.string(), codePrefix: z.string(), status: RecordStatus,
  /** how many items (any status) are in it */
  itemCount: z.number().int(),
  createdBy: PersonRef, createdAt: Instant,
});
export type Category = z.infer<typeof Category>;

// ---- locations ----

/** GET /api/inventory/locations?company=&type=&status= */
export const LocationsQuery = z.object({
  company: emptyToUndefined(company),
  type: emptyToUndefined(LocationType),
  status: emptyToUndefined(RecordStatus),
});
export type LocationsQuery = z.infer<typeof LocationsQuery>;

/**
 * POST /api/inventory/locations. A rack goes inside a store, a bin inside a store or a rack; every other type stands on its
 * own. The custodian is a person with a current job in the same company — needed except for racks and bins, which fall
 * back to their parent's. Type and parent never change.
 */
export const CreateLocationRequest = z.object({
  publicId: z.string().uuid().optional(),
  company,
  type: LocationType,
  code: InventoryCode,
  name: locationName,
  parentPublicId: z.string().uuid().optional(),
  custodianPersonPublicId: z.string().uuid().optional(),
});
export type CreateLocationRequest = z.infer<typeof CreateLocationRequest>;

/** PATCH /api/inventory/locations/:id — null custodian: a rack or bin falls back to its parent's. */
export const UpdateLocationRequest = z.object({
  name: locationName.optional(),
  custodianPersonPublicId: z.string().uuid().nullable().optional(),
  status: RecordStatus.optional(),
}).refine(atLeastOne, AT_LEAST_ONE);
export type UpdateLocationRequest = z.infer<typeof UpdateLocationRequest>;

/** The custodian: a person, through their job in the location's company. */
export const Custodian = z.object({ person: PersonRef, employmentPublicId: PublicId, employeeCode: z.string() });
export type Custodian = z.infer<typeof Custodian>;
export const LocationRef = z.object({ publicId: PublicId, type: LocationType, code: z.string(), name: z.string() });
export type LocationRef = z.infer<typeof LocationRef>;

export const Location = LocationRef.extend({
  company: z.string(),
  parent: LocationRef.nullable(),
  /** set on this location */
  custodian: Custodian.nullable(),
  /** who answers for it: its own custodian, else the nearest parent's */
  responsible: Custodian.nullable(),
  status: RecordStatus, createdBy: PersonRef, createdAt: Instant, updatedBy: PersonRef.nullable(), updatedAt: Instant.nullable(),
});
export type Location = z.infer<typeof Location>;

// ---- items ----

/** A unit an item is also counted or bought in, and how many base units one of it holds. */
export const ItemConversionInput = z.object({ unitPublicId: z.string().uuid(), factor: ConversionFactor });
export type ItemConversionInput = z.infer<typeof ItemConversionInput>;
const Conversions = z.array(ItemConversionInput).max(10)
  .refine((c) => new Set(c.map((x) => x.unitPublicId)).size === c.length, 'List each unit once');

/** GET /api/inventory/items — search matches code or name. */
export const ItemsQuery = z.object({
  company: emptyToUndefined(company),
  category: emptyToUndefined(z.string().uuid()),
  status: emptyToUndefined(RecordStatus),
  tracking: emptyToUndefined(ItemTracking),
  stocked: emptyToUndefined(queryBool),
  search: emptyToUndefined(z.string().trim().max(100)),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
export type ItemsQuery = z.infer<typeof ItemsQuery>;

/**
 * POST /api/inventory/items. Without a code the item gets the next one of its category (EC-0001, EC-0002 …). A
 * non-stocked item (bought for use, never kept in a store) has no tracking, reorder level, reorder quantity or default
 * location. Serial items use a unit with 0 decimals. The default location is one of the company's stores, racks, bins,
 * work areas or testing spaces.
 */
export const CreateItemRequest = z.object({
  publicId: z.string().uuid().optional(),
  company,
  code: InventoryCode.optional(),
  name: itemName,
  description: description.optional(),
  categoryPublicId: z.string().uuid(),
  baseUnitPublicId: z.string().uuid(),
  tracking: ItemTracking.default('none'),
  hsnCode: HsnCode.optional(),
  isStocked: z.boolean().default(true),
  /** below this quantity the item is on the reorder list */
  reorderLevel: Quantity.optional(),
  /** how much to order then */
  reorderQty: Quantity.positive().optional(),
  defaultLocationPublicId: z.string().uuid().optional(),
  conversions: Conversions.default([]),
});
export type CreateItemRequest = z.infer<typeof CreateItemRequest>;

/**
 * PATCH /api/inventory/items/:id — send only what changes; null clears an optional field. The code never changes.
 * conversions replaces the whole list (left out: kept). A new base unit needs the conversions sent with it.
 */
export const UpdateItemRequest = z.object({
  name: itemName.optional(),
  description: description.nullable().optional(),
  categoryPublicId: z.string().uuid().optional(),
  baseUnitPublicId: z.string().uuid().optional(),
  tracking: ItemTracking.optional(),
  hsnCode: HsnCode.nullable().optional(),
  isStocked: z.boolean().optional(),
  reorderLevel: Quantity.nullable().optional(),
  reorderQty: Quantity.positive().nullable().optional(),
  defaultLocationPublicId: z.string().uuid().nullable().optional(),
  conversions: Conversions.optional(),
  status: RecordStatus.optional(),
}).refine(atLeastOne, AT_LEAST_ONE);
export type UpdateItemRequest = z.infer<typeof UpdateItemRequest>;

/**
 * POST /api/inventory/items/copy — a new, separate item in `company` made from another company's item: only its
 * description travels (name, description, HSN/SAC code, tracking, stocked or not). Category, base unit (default: the unit
 * with the same code), code and everything else are the new company's own. The two items stay unlinked.
 */
export const CopyItemRequest = z.object({
  publicId: z.string().uuid().optional(),
  sourceItemPublicId: z.string().uuid(),
  company,
  categoryPublicId: z.string().uuid(),
  baseUnitPublicId: z.string().uuid().optional(),
  code: InventoryCode.optional(),
});
export type CopyItemRequest = z.infer<typeof CopyItemRequest>;

export const ItemConversion = z.object({ unit: UnitRef, factor: z.number() });
export type ItemConversion = z.infer<typeof ItemConversion>;

export const Item = z.object({
  publicId: PublicId, company: z.string(), code: z.string(), name: z.string(), description: z.string().nullable(),
  category: z.object({ publicId: PublicId, name: z.string(), codePrefix: z.string() }),
  baseUnit: UnitRef, tracking: ItemTracking, hsnCode: z.string().nullable(), isStocked: z.boolean(),
  reorderLevel: z.number().nullable(), reorderQty: z.number().nullable(), defaultLocation: LocationRef.nullable(),
  /** the other units it is counted or bought in */
  conversions: z.array(ItemConversion),
  status: RecordStatus, createdBy: PersonRef, createdAt: Instant, updatedBy: PersonRef.nullable(), updatedAt: Instant.nullable(),
});
export type Item = z.infer<typeof Item>;
export const ItemList = z.object({ items: z.array(Item), page: z.number().int(), pageSize: z.number().int(), total: z.number().int() });
export type ItemList = z.infer<typeof ItemList>;

/** GET /api/inventory/items/:id/convert?quantity=&unit= — a quantity in one of the item's units, in its base unit. */
export const ConvertQuery = z.object({ quantity: z.coerce.number().pipe(Quantity), unit: z.string().uuid() });
export type ConvertQuery = z.infer<typeof ConvertQuery>;
/** baseQuantity is rounded (half up) to the base unit's decimals. */
export const Conversion = z.object({ quantity: z.number(), unit: UnitRef, factor: z.number(), baseQuantity: z.number(), baseUnit: UnitRef });
export type Conversion = z.infer<typeof Conversion>;

// ---- CSV import ----

/**
 * POST /api/inventory/items/import and /api/inventory/locations/import — multipart/form-data: the CSV `file` plus these
 * fields. Any invalid row refuses the whole file (400 INVENTORY_IMPORT_INVALID, details = ImportProblem[]); rows whose
 * code is already used (in the company, or earlier in the file) are skipped. dryRun: check only, save nothing.
 */
export const ImportCsvRequest = z.object({
  company,
  dryRun: emptyToUndefined(queryBool).transform((v) => v ?? false),
});
export type ImportCsvRequest = z.infer<typeof ImportCsvRequest>;

/** row: the spreadsheet row number (the header is row 1). */
export const ImportProblem = z.object({ row: z.number().int(), field: z.string(), message: z.string() });
export type ImportProblem = z.infer<typeof ImportProblem>;

export const ImportResult = z.object({
  company: z.string(),
  dryRun: z.boolean(),
  created: z.number().int(),
  skipped: z.number().int(),
  rows: z.array(z.object({
    row: z.number().int(), code: z.string(), name: z.string(), result: z.enum(['created', 'skipped']), reason: z.string().nullable(),
  })),
});
export type ImportResult = z.infer<typeof ImportResult>;

/** A CSV cell: blank means not given. */
const cell = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema.optional());
const numberCell = <T extends z.ZodTypeAny>(schema: T) => cell(z.preprocess((v) => (typeof v === 'string' ? Number(v.trim().replace(/,/g, '')) : v), schema));
const yesNo = z.string().trim().toLowerCase().pipe(z.enum(['yes', 'no', 'true', 'false', 'y', 'n', '1', '0']))
  .transform((v) => ['yes', 'true', 'y', '1'].includes(v));

/**
 * One row of an items CSV (columns by header name, any case; extra columns are ignored): code (blank: made from the
 * category), name, description, category (name or code prefix), unit (base unit code), tracking (none/batch/serial),
 * hsn_code, is_stocked (yes/no, default yes), reorder_level, reorder_qty, default_location (location code),
 * purchase_unit + purchase_factor (one conversion).
 */
export const ItemCsvRow = z.object({
  code: cell(InventoryCode),
  name: itemName,
  description: cell(description),
  category: z.string().trim().min(1, 'Give the category').max(60),
  unit: z.string().trim().min(1, 'Give the base unit').max(12),
  tracking: cell(z.string().trim().toLowerCase().pipe(ItemTracking)),
  hsn_code: cell(HsnCode),
  is_stocked: cell(yesNo),
  reorder_level: numberCell(Quantity),
  reorder_qty: numberCell(Quantity.positive()),
  default_location: cell(InventoryCode),
  purchase_unit: cell(z.string().trim().max(12)),
  purchase_factor: numberCell(ConversionFactor),
});
export type ItemCsvRow = z.infer<typeof ItemCsvRow>;
export const ITEM_CSV_COLUMNS = ['code', 'name', 'description', 'category', 'unit', 'tracking', 'hsn_code', 'is_stocked', 'reorder_level',
  'reorder_qty', 'default_location', 'purchase_unit', 'purchase_factor'] as const;

/** One row of a locations CSV: code, name, type, parent (parent's code), custodian (employee code in the company). */
export const LocationCsvRow = z.object({
  code: InventoryCode,
  name: locationName,
  type: z.string().trim().toLowerCase().transform((v) => v.replace(/[\s-]+/g, '_')).pipe(LocationType),
  parent: cell(InventoryCode),
  custodian: cell(z.string().trim().max(40)),
});
export type LocationCsvRow = z.infer<typeof LocationCsvRow>;
export const LOCATION_CSV_COLUMNS = ['code', 'name', 'type', 'parent', 'custodian'] as const;
