/**
 * Part requests and batch allocation: pure rules. Quantities are scaled integers (×10⁴), as in valuation.ts.
 */

/** Statuses in which a request still holds or may still get stock. */
export const OPEN_REQUEST = ['pending', 'approved'];

/** Above the company's limit (policy inventory.requests.head_approval_above_paise) the department head approves too. */
export const needsHeadApproval = (estimatedValueMinor: bigint, limitMinor: number): boolean => estimatedValueMinor > BigInt(limitMinor);

/** Approved once the store in-charge has approved, and the head too when the request needs it. */
export const fullyApproved = (r: { needsHead: boolean; storeApproved: boolean; headApproved: boolean }): boolean =>
  r.storeApproved && (!r.needsHead || r.headApproved);

/**
 * What a caller may approve on a pending request: as the store (store in-charge of the company) and/or as the head (the
 * ticket's department head, or scope all) when the request needs it — each only once, and never their own request.
 */
export function approvalRoles(caller: { isRequester: boolean; canStore: boolean; canHead: boolean },
  r: { needsHead: boolean; storeApproved: boolean; headApproved: boolean }): { asStore: boolean; asHead: boolean } {
  if (caller.isRequester) return { asStore: false, asHead: false };
  return { asStore: caller.canStore && !r.storeApproved, asHead: r.needsHead && caller.canHead && !r.headApproved };
}

/** A batch of an item in one place, and how much of it is free to take. */
export interface BatchStock { batchId: number; batchNo: string; expiryDate: string | null; available: bigint }

/** Earliest expiry first, batches without an expiry last, then the oldest batch. */
export function fefoOrder(a: BatchStock, b: BatchStock): number {
  if (a.expiryDate !== b.expiryDate) {
    if (a.expiryDate === null) return 1;
    if (b.expiryDate === null) return -1;
    return a.expiryDate < b.expiryDate ? -1 : 1;
  }
  return a.batchId - b.batchId;
}

/** Takes a quantity from batches earliest expiry first; null when they do not hold enough between them. */
export function allocateFefo(batches: BatchStock[], qty: bigint): { batchId: number; qty: bigint }[] | null {
  const out: { batchId: number; qty: bigint }[] = [];
  let left = qty;
  for (const b of [...batches].sort(fefoOrder)) {
    if (left === 0n) break;
    if (b.available <= 0n) continue;
    const take = b.available < left ? b.available : left;
    out.push({ batchId: b.batchId, qty: take });
    left -= take;
  }
  return left === 0n ? out : null;
}
