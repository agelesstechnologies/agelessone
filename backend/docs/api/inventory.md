# Inventory API

Written for developers of the web app and the backend. Base URL `http://localhost:3000/api`; every call needs
`Authorization: Bearer <token>`. Request and answer shapes are defined once in `shared/src/inventory.ts` (set-up) and
`shared/src/inventory-stock.ts` (stock); `/api/docs` shows every route live. Tables: `backend/src/modules/inventory/schema.ts`
(schema `inventory`; migrations `0040_inventory_items_locations` and `0041_inventory_stock`).

Covered so far:
- the **set-up records**: units, item categories, items (with unit conversions), store locations and CSV import;
- **stock** (see [Stock](#stock)): documents (receipt, issue, return, transfer, reversal), stock moves, balances, the moving
  average cost, stock events and the nightly rebuild.

Part requests and reservations come next.

## Companies are kept apart

ATPL and AE (and any later company) each have their own units, categories, items and locations. Nothing is shared.

- Every record carries its company (`company: "ATPL"` in requests and answers; `legal_entity_id` in the database).
- Every link between records carries the company too: an item's category, base unit, default location and conversion units,
  a location's parent and custodian are all **company-safe foreign keys** `(x_id, legal_entity_id) → (id, legal_entity_id)`.
  An ATPL record can never point at an AE record, even when written straight into the database. The stock tables and
  documents will use the same keys.
- **Who reaches a company:** a permission held with scope **all** reaches every company (Management). A narrower scope
  (own / team) reaches only the companies where the person has a **current job** (active or on notice). Inside a
  company, scope own narrows locations further (see [Who sees what](#who-sees-what)).
- Another company's record answers **404** (as if it did not exist); a `company=` filter for a company that is not yours
  answers **403 `INVENTORY_NOT_YOUR_COMPANY`**. List calls without `company` return every company you reach.
- "Copy from another company" (below) makes a new, separate item; the two are not linked.

## Who sees what

Inventory is **need-to-know**. Staff roles (Employee, Manager, Supervisor) hold no inventory permission, so developers,
designers and HR see no Inventory at all. Visibility follows the person's job in the store, or their work on a ticket.

The scope given with a role decides the reach:

| Permission | own | team | all |
| --- | --- | --- | --- |
| `inventory.view`: catalog, locations (and later stock, documents, values) | catalog of your companies; locations **you are responsible for** | every location of the companies you work in | every company |
| `inventory.items.manage`: units, categories, items, copy, items CSV | your companies | your companies | every company |
| `inventory.locations.manage` | change the locations you are responsible for | add, change, import every location of your companies | every company |
| `inventory.stock.post` (stock step) | documents touching your locations | any location of your companies | every company |
| `inventory.request` (requests step) | request on tickets you are assigned to whose type uses parts; no store browsing, no values | same | same |
| `inventory.department.view` (requests step) | – | parts and cost on tickets of departments you head; approve above the limit | every department |

**Responsible for:** you are the location's custodian, or the custodian of the parent a rack or bin falls back to. A
storekeeper of a store looks after its racks and bins unless those name someone else. A location you don't reach answers
**404**. Changing a location you can see but don't look after answers **403 `INVENTORY_NOT_YOUR_LOCATION`**. Adding or
importing locations needs scope team or all (**403 `INVENTORY_LOCATION_SCOPE`**).

| Role | Holds | Usual scope |
| --- | --- | --- |
| Storekeeper | view, items.manage, locations.manage, stock.post | own (the locations they look after) |
| Store in-charge, Inventory controller | the same (each gets its own approvals with the stock and requests steps) | team |
| Accounts executive, Accounts manager | view | team |
| CEO, Management | view | Management: all |
| Parts requester | request | own |
| Manager (department heads) | department.view | team |

Every role holding `inventory.view` sees cost and stock value. Parts requesters never do.

**Which ticket types use parts** is the company policy `inventory.parts.ticket_types`: ticket type codes, default
production, workshop, installation, service, site_work. A parts requester requests only on those tickets.

Give a role with `POST /api/core/role-assignments { personPublicId, roleCode: "storekeeper", scope: "own" }`.

## Common rules

- Records are identified by `publicId`. Creates accept an optional client-made `publicId`: sending the same create again
  answers **200** with the stored record instead of 201 (a double click or a retry is stored once).
- Nothing is deleted (the database refuses it): records have `status` `active` / `inactive`. Inactive records keep their
  history and existing links but cannot be chosen for new ones. `PATCH … { "status": "inactive" }`.
- `PATCH` takes only what changes; sending what is already stored changes nothing (no audit entry, `updatedAt` unchanged).
- Every create and change is written to `core.audit_log` (`inventory.item.created`, `inventory.location.deactivated` …).
- **Quantities** are in the item's base unit, up to 4 decimals and never more than the unit allows (`numeric(18,4)`).
- **Codes** (item, location) are kept in capitals and are unique per company; the same code may exist in another company.

## Units — `/api/inventory/units`

| Call | |
| --- | --- |
| `GET /units?company=&status=` | units of the companies you reach |
| `GET /units/:publicId` | one unit |
| `POST /units` | `{ "company": "ATPL", "code": "m", "name": "Metres", "decimals": 2 }` |
| `PATCH /units/:publicId` | `{ "name"?, "decimals"?, "status"? }` |

`code`: lower case, up to 12 (`pcs`, `m`, `kg`, `box`), unique per company, never changes. `decimals` 0–4: pieces 0,
metres 2, kilograms 3. Decimals change only while no item uses the unit (base unit or conversion): **409 `INVENTORY_UNIT_IN_USE`**.

## Item categories — `/api/inventory/categories`

| Call | |
| --- | --- |
| `GET /categories?company=&status=` | with `itemCount` |
| `GET /categories/:publicId` | |
| `POST /categories` | `{ "company": "ATPL", "name": "Electronic components", "codePrefix": "EC" }` |
| `PATCH /categories/:publicId` | `{ "name"?, "status"? }` |

Name (ignoring case) and `codePrefix` (2–6 capitals or digits) are unique per company. The prefix starts the item codes
made for the category and never changes.

## Items — `/api/inventory/items`

| Call | |
| --- | --- |
| `GET /items?company=&category=&status=&tracking=&stocked=&search=&page=&pageSize=` | a page (default 50, at most 100), by company then code; `search` matches code or name. Staff with `inventory.request` may call it |
| `GET /items/:publicId` | one item with its conversions |
| `POST /items` | create (below) |
| `PATCH /items/:publicId` | change; `null` clears an optional field |
| `GET /items/:publicId/convert?quantity=3&unit=<unitPublicId>` | a quantity in one of the item's units, in base units |
| `POST /items/copy` | copy another company's item (below) |
| `POST /items/import` | CSV import (below) |

Create:
```json
{
  "company": "ATPL",
  "code": "EC-0002",
  "name": "Relay module, 5 V, 4 channel",
  "description": "Opto-isolated",
  "categoryPublicId": "…",
  "baseUnitPublicId": "…",
  "tracking": "none",
  "hsnCode": "8536",
  "isStocked": true,
  "reorderLevel": 10,
  "reorderQty": 20,
  "defaultLocationPublicId": "…",
  "conversions": [{ "unitPublicId": "<box>", "factor": 10 }]
}
```

| Field | Rule |
| --- | --- |
| `code` | optional; left out, the item gets the next code of its category: `EC-0001`, `EC-0002` … (counting codes typed by hand). Never changes |
| `name` | 2–120, unique per company ignoring case |
| `tracking` | `none` (quantity only), `batch`, `serial`. Serial items need a base unit with 0 decimals |
| `hsnCode` | GST HSN/SAC code, 4, 6 or 8 digits, optional |
| `isStocked` | default true. A **non-stocked** item (bought for use, never kept in a store) has no tracking, reorder level, reorder qty or default location |
| `reorderLevel`, `reorderQty` | base units, within the base unit's decimals; `reorderQty` > 0 |
| `defaultLocationPublicId` | an active store, rack, bin, work area or testing space of the same company (not transit, quarantine or scrap) |
| `conversions` | other units the item is bought or counted in: one `unit` = `factor` base units (up to 6 decimals). Not the base unit; each unit once; at most 10 |

Category, base unit, default location and conversion units must belong to the item's company (**400**
`INVENTORY_UNKNOWN_CATEGORY` / `_UNIT` / `_LOCATION`) and be active (`INVENTORY_CATEGORY_INACTIVE`, `INVENTORY_UNIT_INACTIVE`,
`INVENTORY_LOCATION_INACTIVE`). Breaking an item rule answers **400 `INVENTORY_ITEM_INVALID`** with every problem in
`details: [{ field, message }]`. Duplicates: **409 `INVENTORY_DUPLICATE_ITEM_CODE`** / **`INVENTORY_DUPLICATE_ITEM_NAME`**.

**Conversions.** `PATCH { "conversions": [...] }` replaces the list; a changed or removed conversion is ended (kept as
history) and a new row added. Factors are in base units, so a new base unit needs the conversions sent with it
(**400 `INVENTORY_CONVERSIONS_NEEDED`** otherwise).

**Convert.** `GET /items/:id/convert?quantity=7&unit=<ft>` →
`{ "quantity": 7, "unit": {…ft}, "factor": 0.3048, "baseQuantity": 2.13, "baseUnit": {…m} }`. `baseQuantity` = quantity ×
factor, computed exactly and rounded half up to the base unit's decimals. The base unit itself has factor 1. Errors:
**400 `INVENTORY_NO_CONVERSION`** (no conversion for that unit), **400 `INVENTORY_QUANTITY_DECIMALS`** (2.5 boxes in a
0-decimal unit). Receipts will use the same calculation.

**Copy from another company.** `POST /items/copy { "sourceItemPublicId", "company": "ATPL", "categoryPublicId",
"baseUnitPublicId"?, "code"? }` makes a **new, separate item** in `company`. Only the description travels: name,
description, HSN/SAC code, tracking, stocked. Category, base unit (default: the target company's active unit with the same
code, else **400 `INVENTORY_UNKNOWN_UNIT`**), code (default: next of the category) are the target's own; reorder values,
default location and conversions start empty. The caller must reach the source item (else 404) and hold
`inventory.items.manage` in the target company. Copying into the item's own company: **400 `INVENTORY_COPY_SAME_COMPANY`**.
The audit entry records where it was copied from; the items themselves are not linked.

## Locations — `/api/inventory/locations`

| Call | |
| --- | --- |
| `GET /locations?company=&type=&status=` | every location, with `parent`, `custodian` and `responsible` |
| `GET /locations/:publicId` | |
| `POST /locations` | `{ "company": "ATPL", "type": "store", "code": "STORE", "name": "Office store", "custodianPersonPublicId": "…" }` |
| `PATCH /locations/:publicId` | `{ "name"?, "custodianPersonPublicId"? (null for racks and bins), "status"? }` |
| `POST /locations/import` | CSV import (below) |

Types: `store`, `rack`, `bin`, `work_area`, `testing`, `transit`, `quarantine`, `scrap`. A **rack** goes inside a store, a
**bin** inside a store or a rack (`parentPublicId`); every other type stands on its own (**400
`INVENTORY_LOCATION_PLACEMENT`**). The parent must be an active location of the same company (`INVENTORY_UNKNOWN_PARENT`,
409 `INVENTORY_PARENT_INACTIVE`). Type and parent never change.

**Custodian** — the person responsible: a person with a **current job in the location's company** (stored as that job, so
it can never be another company's person): **400 `INVENTORY_BAD_CUSTODIAN`** otherwise. Needed for every type except racks
and bins, which may leave it empty and fall back to their parent's (**400 `INVENTORY_CUSTODIAN_NEEDED`**). `responsible`
in the answer is the location's own custodian, else the nearest parent's.

A location with active racks or bins inside cannot become inactive (**409 `INVENTORY_LOCATION_HAS_CHILDREN`**); a rack or
bin becomes active again only while its parent is active. Duplicate code: **409 `INVENTORY_DUPLICATE_LOCATION_CODE`**.

## CSV import

`POST /api/inventory/items/import` and `POST /api/inventory/locations/import`, **multipart/form-data**:

| Field | |
| --- | --- |
| `file` | the CSV, UTF-8 ("CSV UTF-8" in Excel), at most 2 MB and 5000 rows; header row first |
| `company` | `ATPL` |
| `dryRun` | `true` to check and see the result without saving (default `false`) |

Columns are found by header name (any case; spaces and hyphens read as `_`); extra columns are ignored; blank cells mean
"not given"; numbers may have thousands separators (`1,000`).

- **Duplicates by code are skipped**, not refused: a code the company already uses, or a code an earlier row of the file
  used. For items without a code, the same applies to the name. Skipped rows are listed with the reason.
- **Any other problem refuses the whole file**; nothing is saved: **400 `INVENTORY_IMPORT_INVALID`**, `message` names the
  first problem, `details: [{ row, field, message }]` lists them all. `row` is the spreadsheet row (the header is row 1).
- Sending the same file again skips every row, so a retry is safe.
- Other refusals: no file (`INVENTORY_IMPORT_NO_FILE`), not a text CSV (`INVENTORY_IMPORT_NOT_CSV`, e.g. an .xlsx), no rows
  (`INVENTORY_IMPORT_EMPTY`), over 5000 rows (`INVENTORY_IMPORT_TOO_LARGE`), a code or name added by someone else at the same
  moment (409 `INVENTORY_IMPORT_CONFLICT`: send again).

Answer:
```json
{ "company": "ATPL", "dryRun": false, "created": 2, "skipped": 1,
  "rows": [ { "row": 2, "code": "EC-0003", "name": "Limit switch", "result": "created", "reason": null },
            { "row": 3, "code": "EC-0002", "name": "Relay", "result": "skipped", "reason": "This code is already used by an item of the company" } ] }
```

**Items CSV** — required columns `name`, `category`, `unit`:

| Column | |
| --- | --- |
| `code` | blank: the next code of the category |
| `name`, `description` | |
| `category` | the category's name or code prefix |
| `unit` | base unit code |
| `tracking` | `none` (blank), `batch`, `serial` |
| `hsn_code` | 4, 6 or 8 digits |
| `is_stocked` | `yes` (blank) / `no` |
| `reorder_level`, `reorder_qty` | base units |
| `default_location` | a location code |
| `purchase_unit`, `purchase_factor` | one conversion, both or neither |

```csv
code,name,category,unit,tracking,hsn_code,is_stocked,reorder_level,reorder_qty,default_location,purchase_unit,purchase_factor
,Limit switch,EC,pcs,,8536,yes,10,20,STORE-A-03,box,10
CF-0010,"Cable tie, 200 mm",Cables and fittings,pcs,,,no,,,,,
```

**Locations CSV** — required columns `code`, `name`, `type`:

| Column | |
| --- | --- |
| `code`, `name` | |
| `type` | `store`, `rack`, `bin`, `work_area` (or `work area`), `testing`, `transit`, `quarantine`, `scrap` |
| `parent` | the parent's code: an existing active location, or another row of the same file (created first) |
| `custodian` | the employee code of a current job in the company; blank only for racks and bins |

```csv
code,name,type,parent,custodian
LAB,Hardware & IoT lab,store,,ATH001
LAB-R1,Rack 1,rack,LAB,
LAB-R1-B1,Bin 1,bin,LAB-R1,
```

## Stock

Every movement is a **document**: a receipt, issue, return, transfer or reversal. Stock is never edited directly, and a
mistake is undone with a reversal. Posting a document does all of the following in one transaction:
- writes **stock moves**: the ledger, append-only, which the database refuses to change or delete;
- updates the **balances**: quantity per item and location, never below zero;
- updates the **valuation**: value and moving average cost per item per company;
- publishes the **stock event** (`core.outbox`);
- writes the **audit log**.

**Who** (see [Who sees what](#who-sees-what)):
- **Posting** needs `inventory.stock.post` in the company. With scope own, every location the document moves stock in or out
  of must be one the poster looks after (**403 `INVENTORY_NOT_YOUR_LOCATION`**).
- **Reading** documents and stock needs `inventory.view` (or stock.post). Scope own sees only documents and stock of its
  locations, and values are shown.
- A document of another company answers **404**.

**Common rules:**
- **Company:** a document belongs to one company and uses only that company's items, locations and tickets. The database's
  company-safe keys refuse anything else, and the API answers 400 `INVENTORY_UNKNOWN_ITEM` / `_LOCATION` / `_TICKET`.
- **Dates:** `documentDate` defaults to today (IST) and is never in the future (400 `INVENTORY_DATE_IN_FUTURE`). A month
  closed by Accounts will be refused (400 `INVENTORY_MONTH_CLOSED`) once the Accounts module is merged; until then no month
  is closed.
- **Quantities** are in the base unit and fit its decimals (400 `INVENTORY_QUANTITY_DECIMALS`).
- **Items:**
  - non-stocked items never move (400 `INVENTORY_ITEM_NOT_STOCKABLE`);
  - batch and serial items get stock with part requests (next step);
  - inactive items take no receipts.
- **Locations:** they are active. Received, issued and usable stock sits in a store, rack, bin, work area or testing space
  (400 `INVENTORY_LOCATION_USE`).
- **Numbers** are per company and type: `GRN-00001` (receipt), `ISS-` (issue), `RET-` (return), `TRF-` (transfer), `REV-` (reversal).
- **Resends:** creates take an optional `publicId`; sending the same create again answers **200** with the stored document.
- **Money** is integer minor units (paise) in `INR`. `unitCostMinor` is minor units per base unit and may have 6 decimals.

**Moving weighted average (per item, per company):**
- **Receipts and returns** add their value and recalculate the average: total value ÷ total quantity.
- **Issues and transfers** take stock out at the current average. The cost is recorded on the line and never changes,
  whatever later receipts do. An issue that empties the stock takes all the value left, so nothing in stock keeps a value.
- **Amounts** are computed in exact integers (no floating point).
- **Stored per company, not per location:** the value and average live once per item per company (`stock_valuations`).
  A per-location value would drift away from a company-wide average, so stock on hand shows value = quantity × that average.

### Receipt — `POST /api/inventory/receipts`
```json
{ "company": "ATPL", "supplierName": "Fictional Supplies", "challanNo": "DC-114", "reason": "Direct purchase for the lab",
  "lines": [{ "itemPublicId": "…", "locationPublicId": "…", "quantity": 2, "unitPublicId": "<box>", "unitCostMinor": 15000 }] }
```
- **Reason:** until purchase orders exist every receipt is a direct purchase, so `reason` is required.
- **Unit:** `unitPublicId` is the base unit (the default) or one of the item's conversion units. The quantity is converted with
  the item's factor (2 boxes of 10 = 20 pcs). `unitCostMinor` is per that unit, and the line value is quantity × cost, half up.
- **Location:** defaults to the item's default location (400 `INVENTORY_LOCATION_NEEDED` when it has none).
- **Delivery challan:** attach it once with `POST /api/inventory/documents/:id/challan` (multipart `file`: JPEG, PNG or PDF,
  up to 5 MB, told by its bytes; 409 `INVENTORY_CHALLAN_EXISTS`). Download it with `GET …/challan`.

### Issue — `POST /api/inventory/issues`
`{ "company": "ATPL", "ticketPublicId": "…", "lines": [{ "itemPublicId", "locationPublicId", "quantity" }] }`
- **Ticket:** a ticket of the same company that is open, assigned, in progress or on hold (409 `INVENTORY_TICKET_CLOSED`).
  Projects come later.
- **Cost:** each line takes the average at that moment.
- **Not enough stock:** **409 `INVENTORY_NOT_ENOUGH_STOCK`** ("Not enough X in Y: 1 on hand, 2 needed"). Balances are
  locked while posting, so two issues of the last unit can never both pass.

### Return — `POST /api/inventory/returns`
`{ "issuePublicId": "…", "lines": [{ "lineNo": 1, "quantity": 1, "condition": "usable", "locationPublicId"? }] }`
- **Cost:** at the cost the line was issued at. The last part of a line takes exactly the rest of its value.
- **Quantity:** never more than was issued less what came back already (409 `INVENTORY_RETURN_TOO_MUCH`).
- **Condition decides the location:**
  - `usable` goes to a store, rack, bin, work area or testing space (default: where it was issued from);
  - `repair` goes to a quarantine location;
  - `scrap` goes to a scrap location.
  - Without `locationPublicId`, repair and scrap use the company's only active one; if there isn't exactly one, the answer
    is 400 `INVENTORY_RETURN_LOCATION_NEEDED`.

### Transfer — `POST /api/inventory/transfers`, then `POST /api/inventory/transfers/:id/receive`
`{ "company": "ATPL", "transitLocationPublicId"?, "lines": [{ "itemPublicId", "fromLocationPublicId", "toLocationPublicId", "quantity" }] }`
- **Sending:** the stock leaves its from-locations at the average and waits in the transit location (default: the company's
  only one; 400 `INVENTORY_TRANSIT_NEEDED`). The document is `in_transit`.
- **Receiving:** the receiving side (scope own: the to-locations' custodians) receives it. The stock leaves transit for the
  destinations with the value it left with, and the document becomes `posted`, recording who received it and when. A
  second receive answers 409 `INVENTORY_NOT_IN_TRANSIT`.
- **Value:** a transfer never changes the item's value or average.

### Reversal — `POST /api/inventory/documents/:id/reverse` `{ "reason": "…" }`
- **What it does:** posts a reversal document (`REV-…`) with every move of the original, opposite (`reversal_of`), so
  quantity and value come back. The original becomes `reversed`, and each move is reversed at most once.
- **Transfers:** a transfer in transit returns to its from-locations; a received one goes back from the destinations to the
  from-locations.
- **Refused when:**
  - it's a reversal (400 `INVENTORY_CANNOT_REVERSE_REVERSAL`);
  - it's already reversed (409 `INVENTORY_ALREADY_REVERSED`);
  - it's an issue with returns (reverse the returns first: 409 `INVENTORY_REVERSE_RETURNS_FIRST`);
  - the stock has moved on since (409 `INVENTORY_NOT_ENOUGH_STOCK`, or `INVENTORY_REVERSAL_NOT_POSSIBLE` when it would
    leave value without stock).

### Reading
- `GET /api/inventory/documents?company=&type=&status=&ticket=&from=&to=&page=&pageSize=`: newest first, with line count
  and total value.
- `GET /api/inventory/documents/:id`: lines with item, quantity, entered unit, locations, condition, unit cost and value;
  links to the original document or its reversal.
- `GET /api/inventory/stock?company=&item=&location=&includeEmpty=&page=&pageSize=`: one row per item and location, with
  `onHand`, `reserved`, `available` (= onHand − reserved), `avgCostMinor` (the company average) and `valueMinor`.

### Stock events (`core.outbox`, written in the same transaction)
Each document publishes one event (shape `StockEvent` in `shared/src/inventory-stock.ts`). Its lines give item, location,
signed quantity, unit cost and value.

| Event | When |
| --- | --- |
| `stock.received` | receipt |
| `stock.issued` | issue (with `ticketPublicId`, `projectId`) |
| `stock.returned` | return (with the issue's ticket) |
| `stock.transferred` | transfer sent (`phase: dispatched`) and received (`phase: received`) |
| `stock.adjusted` | reversal (`reason: reversal`, `reversalOf`); counts and adjustments later |

Outbox events are never deleted; only `published_at` is set once, when a consumer has taken one.

### Nightly check — `pnpm --filter @ageless/backend inventory:daily`
Rebuilds every balance and valuation from the stock moves, fixes any that differ, and alerts: an audit entry
`inventory.stock.rebuilt` for each company with a difference, and the job prints each one. Posting waits while it runs.

### Once stock exists
- An item with stock moves can no longer change its base unit, tracking or stocked setting (409 `INVENTORY_ITEM_HAS_STOCK_MOVES`).
- A location that still holds stock cannot become inactive (409 `INVENTORY_LOCATION_HAS_STOCK`).

## Error codes

| Code | Status | When |
| --- | --- | --- |
| `INVENTORY_UNKNOWN_COMPANY` | 400 | no company with that code |
| `INVENTORY_NOT_YOUR_COMPANY` | 403 | a company you do not work in (and no scope all) |
| `INVENTORY_NOT_YOUR_LOCATION` | 403 | changing a location you can see but do not look after (scope own) |
| `INVENTORY_LOCATION_SCOPE` | 403 | adding or importing locations without scope team or all |
| `INVENTORY_DUPLICATE_ID` | 409 | the `publicId` is used by another tenant |
| `INVENTORY_UNIT_NOT_FOUND`, `_CATEGORY_NOT_FOUND`, `_ITEM_NOT_FOUND`, `_LOCATION_NOT_FOUND` | 404 | unknown, or another company's |
| `INVENTORY_DUPLICATE_UNIT_CODE`, `_CATEGORY_NAME`, `_CATEGORY_PREFIX`, `_ITEM_CODE`, `_ITEM_NAME`, `_LOCATION_CODE` | 409 | already used in the company |
| `INVENTORY_UNIT_IN_USE` | 409 | decimals of a unit items use |
| `INVENTORY_UNKNOWN_CATEGORY`, `_UNIT`, `_LOCATION`, `_PARENT` | 400 | not the record's company |
| `INVENTORY_CATEGORY_INACTIVE`, `_UNIT_INACTIVE`, `_LOCATION_INACTIVE` | 400 | chosen record is inactive |
| `INVENTORY_PARENT_INACTIVE` | 409 | parent location inactive |
| `INVENTORY_ITEM_INVALID` | 400 | item rules (details per field) |
| `INVENTORY_CONVERSIONS_NEEDED` | 400 | new base unit without conversions |
| `INVENTORY_NO_CONVERSION`, `INVENTORY_QUANTITY_DECIMALS` | 400 | convert |
| `INVENTORY_COPY_SAME_COMPANY` | 400 | copy into the item's own company |
| `INVENTORY_LOCATION_PLACEMENT` | 400 | rack / bin parent rules |
| `INVENTORY_CUSTODIAN_NEEDED`, `INVENTORY_BAD_CUSTODIAN` | 400 | custodian rules |
| `INVENTORY_LOCATION_HAS_CHILDREN` | 409 | inactive with active racks or bins inside |
| `INVENTORY_IMPORT_INVALID`, `_NO_FILE`, `_NOT_CSV`, `_EMPTY`, `_TOO_LARGE` | 400 | CSV import |
| `INVENTORY_IMPORT_CONFLICT` | 409 | CSV import raced another change; send again |
| `INVENTORY_DOCUMENT_NOT_FOUND` | 404 | unknown stock document, or another company's (or, with scope own, not of your locations) |
| `INVENTORY_UNKNOWN_ITEM`, `_TICKET`, `_LINE` | 400 | not the document's company, or no such issue line |
| `INVENTORY_ITEM_NOT_STOCKABLE`, `INVENTORY_ITEM_INACTIVE` | 400 | non-stocked, batch or serial item; inactive item on a receipt |
| `INVENTORY_LOCATION_USE`, `_LOCATION_NEEDED`, `_RETURN_LOCATION_NEEDED`, `_TRANSIT_NEEDED` | 400 | location rules of stock documents |
| `INVENTORY_DATE_IN_FUTURE`, `INVENTORY_MONTH_CLOSED` | 400 | document date |
| `INVENTORY_NOT_ENOUGH_STOCK` | 409 | a location would go below zero |
| `INVENTORY_TICKET_CLOSED` | 409 | issue to a completed or cancelled ticket |
| `INVENTORY_RETURN_TOO_MUCH` | 409 | more than issued less returned |
| `INVENTORY_NOT_AN_ISSUE`, `_NOT_A_TRANSFER`, `_NOT_A_RECEIPT` | 400 | wrong document type for the call |
| `INVENTORY_NOT_IN_TRANSIT`, `_DOCUMENT_REVERSED` | 409 | transfer already received or reversed; return from a reversed issue |
| `INVENTORY_ALREADY_REVERSED`, `_REVERSE_RETURNS_FIRST`, `_REVERSAL_NOT_POSSIBLE` | 409 | reversal rules |
| `INVENTORY_CANNOT_REVERSE_REVERSAL` | 400 | a reversal is final |
| `INVENTORY_FILE_REQUIRED`, `_FILE_TYPE` | 400 | challan file missing, or not JPEG / PNG / PDF |
| `INVENTORY_CHALLAN_EXISTS` | 409 | the receipt already has its challan |
| `INVENTORY_NO_CHALLAN` | 404 | no challan attached |
| `INVENTORY_ITEM_HAS_STOCK_MOVES`, `INVENTORY_LOCATION_HAS_STOCK` | 409 | once stock exists |
| `VALIDATION` | 400 | request shape (`details` per field) |

## Not built yet

- **Part requests and reservations:** approvals by value, expiry and release.
- **Serial and batch rules:** batch and serial items take no stock until then.
- **Cross-company requesters.**
- **Intercompany charges:** from the `stock.issued` event, once the intercompany module is merged.
- **Closed months:** the check refuses nothing until Accounts is merged.
- **Purchase-order links, receipt validation by the store in-charge, counts, adjustments and reports.**
