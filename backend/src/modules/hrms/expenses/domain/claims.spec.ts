import { describe, it, expect } from 'vitest';
import { amountToApprove, detectReceiptType, stepNotAllowed } from './claims';

describe('detectReceiptType', () => {
  it('knows JPEG, PNG and PDF by their first bytes', () => {
    expect(detectReceiptType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg');
    expect(detectReceiptType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('png');
    expect(detectReceiptType(new TextEncoder().encode('%PDF-1.7'))).toBe('pdf');
  });
  it('refuses anything else, whatever its name says', () => {
    expect(detectReceiptType(new TextEncoder().encode('hello'))).toBeNull();
    expect(detectReceiptType(new Uint8Array())).toBeNull();
  });
});

describe('stepNotAllowed', () => {
  it('a submitted claim can be approved or rejected, not paid', () => {
    expect(stepNotAllowed('submitted', 'approve')).toBeNull();
    expect(stepNotAllowed('submitted', 'reject')).toBeNull();
    expect(stepNotAllowed('submitted', 'pay')).toBe('HRMS_CLAIM_NOT_APPROVED');
  });
  it('an approved claim can only be paid', () => {
    expect(stepNotAllowed('approved', 'pay')).toBeNull();
    expect(stepNotAllowed('approved', 'reject')).toBe('HRMS_CLAIM_NOT_PENDING');
  });
  it('a paid claim never changes', () => {
    for (const action of ['approve', 'reject', 'pay'] as const) expect(stepNotAllowed('paid', action)).toBe('HRMS_CLAIM_PAID');
  });
  it('a rejected claim is final', () => expect(stepNotAllowed('rejected', 'approve')).toBe('HRMS_CLAIM_NOT_PENDING'));
});

describe('amountToApprove', () => {
  it('defaults to the claimed amount', () => expect(amountToApprove(50000)).toBe(50000));
  it('allows a lower amount', () => expect(amountToApprove(50000, 42000)).toBe(42000));
  it('refuses a higher amount', () => expect(amountToApprove(50000, 50001)).toBeNull());
});
