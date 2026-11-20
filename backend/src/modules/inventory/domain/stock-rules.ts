import type { ItemTracking, LocationType, ReturnCondition, StockDocumentType } from '@ageless/shared';
import { locationLabel } from './locations';

/** What a location is used for on a document line. */
export type LocationUse = 'receive' | 'issue' | 'transfer_from' | 'transfer_to' | 'transit' | ReturnCondition;

const USABLE: LocationType[] = ['store', 'rack', 'bin', 'work_area', 'testing'];

/**
 * Why a location of this type cannot be used this way, or null. Received, issued and usable returned stock is in a store,
 * rack, bin, work area or testing space; a part for repair goes to quarantine, scrap to scrap; transfers move between any
 * two locations except transit, which only holds stock on its way.
 */
export function locationUseProblem(use: LocationUse, type: LocationType): string | null {
  const label = locationLabel(type);
  switch (use) {
    case 'receive': case 'issue': case 'usable':
      return USABLE.includes(type) ? null : `${capital(verb(use))} stock is kept in a store, rack, bin, work area or testing space, not a ${label}`;
    case 'repair': return type === 'quarantine' ? null : `A part for repair goes to a quarantine location, not a ${label}`;
    case 'scrap': return type === 'scrap' ? null : `A scrapped part goes to a scrap location, not a ${label}`;
    case 'transfer_from': case 'transfer_to': return type === 'transit' ? 'Transit only holds stock on its way: transfer from and to the real locations' : null;
    case 'transit': return type === 'transit' ? null : `The transit location must be of type transit, not a ${label}`;
  }
}
const verb = (use: 'receive' | 'issue' | 'usable') => (use === 'receive' ? 'received' : use === 'issue' ? 'issued' : 'usable returned');
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The location type a returned part needs, by condition (usable: any that keeps usable stock). */
export const returnLocationTypes = (condition: ReturnCondition): LocationType[] =>
  condition === 'usable' ? USABLE : condition === 'repair' ? ['quarantine'] : ['scrap'];

/** Why an item cannot move in stock, or null: non-stocked items never do. */
export function itemStockProblem(item: { code: string; isStocked: boolean; tracking: ItemTracking }): string | null {
  if (!item.isStocked) return `${item.code} is not a stocked item: it is bought for use and never kept in a store`;
  return null;
}

/**
 * Why a line's batch and serial details do not fit the item, or null. Serial items: one unit per line, with its serial
 * number. Batch items: a batch is named where the stock is created (receipts); elsewhere it may be left out (earliest
 * expiry first). Untracked items take neither.
 */
export function trackingProblem(item: { code: string; tracking: ItemTracking }, line: { quantity: number; batchNo?: string; serialNo?: string },
  batchRequired: boolean): string | null {
  if (item.tracking !== 'serial' && line.serialNo) return `${item.code} has no serial numbers`;
  if (item.tracking !== 'batch' && line.batchNo) return `${item.code} has no batches`;
  if (item.tracking === 'serial' && (!line.serialNo || line.quantity !== 1)) return `${item.code} is serial-numbered: one unit per line, with its serial number`;
  if (item.tracking === 'batch' && batchRequired && !line.batchNo) return `${item.code} is tracked by batch: give the batch number`;
  return null;
}

/** Ticket statuses that still take parts (not completed or cancelled). */
export const TICKET_TAKES_PARTS = ['open', 'assigned', 'in_progress', 'on_hold'];

const PREFIX: Record<StockDocumentType | 'request', string> = { receipt: 'GRN', issue: 'ISS', return: 'RET', transfer: 'TRF', reversal: 'REV', request: 'REQ' };
/** A document's number within its company: GRN-00001, ISS-00042, REQ-00007 … */
export const documentNumber = (type: StockDocumentType | 'request', n: number): string => `${PREFIX[type]}-${String(n).padStart(5, '0')}`;

/** Why a document date is refused, or null: never in the future (IST), never in a month Accounts has closed. */
export function documentDateProblem(date: string, today: string, monthClosed: boolean): string | null {
  if (date > today) return 'A stock document cannot be dated in the future';
  if (monthClosed) return `Accounts has closed ${date.slice(0, 7)}: date the document in an open month`;
  return null;
}
