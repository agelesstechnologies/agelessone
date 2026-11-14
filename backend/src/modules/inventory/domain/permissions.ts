/**
 * Permission codes used by the inventory endpoints (rows in core.permissions, added by migration 0040). Inventory is
 * need-to-know: staff hold none of these. Scope all: every company of the tenant. Scope team: the companies the person
 * has a current job in. Scope own: those companies' catalog, but locations (and later stock and documents) only where the
 * person is responsible (custodian of the location, or of the parent a rack or bin falls back to).
 */
export const INVENTORY = {
  /** see units, categories, items, locations, stock and values (store roles, Accounts, CEO / Management) */
  view: 'inventory.view',
  /** add and change units, categories and items; copy items; import items (store roles) */
  items: 'inventory.items.manage',
  /** add, change and import locations (store roles; adding and importing need scope team or all) */
  locations: 'inventory.locations.manage',
  /** post receipts, issues, returns and transfers (store roles; the stock step) */
  stockPost: 'inventory.stock.post',
  /** Parts requester: request parts on tickets they are assigned to whose type uses parts (the requests step) */
  request: 'inventory.request',
  /** department heads: parts and cost on their departments' tickets, approval above the limit (the requests step) */
  departmentView: 'inventory.department.view',
} as const;

/** Any of these lets a person read the set-up records: units, categories, items and locations. */
export const INVENTORY_READ = [INVENTORY.view, INVENTORY.items, INVENTORY.locations] as [string, ...string[]];
