export type ClaimStatus = 'submitted' | 'approved' | 'rejected' | 'paid';
export type ClaimAction = 'approve' | 'reject' | 'pay';
export type ReceiptType = 'jpg' | 'png' | 'pdf';

/** Largest receipt accepted, in bytes. */
export const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;

/** The receipt's real type from its first bytes (what the browser claims is not trusted). */
export function detectReceiptType(bytes: Uint8Array): ReceiptType | null {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts(0xff, 0xd8, 0xff)) return 'jpg';
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png';
  if (starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return 'pdf'; // %PDF-
  return null;
}

/**
 * Why an action is not allowed in the claim's current state, as an error code; null when it is allowed.
 * submitted → approve | reject; approved → pay; a paid claim never changes.
 */
export function stepNotAllowed(status: ClaimStatus, action: ClaimAction): string | null {
  if (status === 'paid') return 'HRMS_CLAIM_PAID';
  if ((action === 'approve' || action === 'reject') && status !== 'submitted') return 'HRMS_CLAIM_NOT_PENDING';
  if (action === 'pay' && status !== 'approved') return 'HRMS_CLAIM_NOT_APPROVED';
  return null;
}

/** The amount to approve: the claimed amount unless a lower one is given. Null when the given amount is too high. */
export function amountToApprove(claimedPaise: number, requestedPaise?: number): number | null {
  if (requestedPaise === undefined) return claimedPaise;
  return requestedPaise <= claimedPaise ? requestedPaise : null;
}
