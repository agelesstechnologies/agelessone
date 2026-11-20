import { describe, expect, it } from 'vitest';
import { DEDUCTION_LEDGER_KEYS, LEDGER_KEYS, deductionLedgerKey } from '@ageless/shared';
import { balances, DEFAULT_RULES, isFixedKey, reverseLines, ruleInForce, StoredRule, unbalanced } from './ledger';

const L = (ledgerKey: string, debitMinor: number, creditMinor: number) => ({ ledgerKey, debitMinor, creditMinor });

describe('journal lines', () => {
  it('balanced lines pass', () => expect(unbalanced([L('a', 500, 0), L('b', 0, 500)])).toBeNull());
  it('debits and credits that differ fail', () => expect(unbalanced([L('a', 500, 0), L('b', 0, 499)])).toMatch(/differ/));
  it('one line, both sides on a line, negative or fractional amounts fail', () => {
    expect(unbalanced([L('a', 5, 0)])).toMatch(/two lines/);
    expect(unbalanced([L('a', 5, 5), L('b', 0, 0)])).toMatch(/not both/);
    expect(unbalanced([L('a', -5, 0), L('b', 0, -5)])).toMatch(/never negative/);
    expect(unbalanced([L('a', 5.5, 0), L('b', 0, 5.5)])).toMatch(/whole paise/);
  });
  it('a reversal restores every balance to zero', () => {
    const lines = [L('expense.fuel', 1200, 0), L('payable.reimbursements', 0, 1200)];
    expect([...balances([...lines, ...reverseLines(lines)]).values()]).toEqual([0, 0]);
    expect(unbalanced(reverseLines(lines))).toBeNull();
  });
});

describe('posting rules', () => {
  const stored = (companyId: number | null, version: number, effectiveFrom: string, debit: string): StoredRule =>
    ({ ...DEFAULT_RULES.expense_paid, companyId, version, effectiveFrom, debitLedgerKey: debit });
  it('with nothing stored the built-in default applies', () => {
    expect(ruleInForce([], 1, 'expense_paid', '2026-11-07')).toEqual({ rule: DEFAULT_RULES.expense_paid, stored: null });
  });
  it('the company\'s newest version in force beats the group\'s; a future version waits', () => {
    const rules = [stored(null, 1, '2026-01-01', 'g1'), stored(1, 1, '2026-01-01', 'c1'), stored(1, 2, '2026-12-01', 'c2')];
    expect(ruleInForce(rules, 1, 'expense_paid', '2026-11-07').rule.debitLedgerKey).toBe('c1');
    expect(ruleInForce(rules, 1, 'expense_paid', '2026-12-01').rule.debitLedgerKey).toBe('c2');
    expect(ruleInForce(rules, 2, 'expense_paid', '2026-11-07').rule.debitLedgerKey).toBe('g1');
  });
  it('every key a built-in rule names is on the fixed list (the expense.<category> placeholder is filled from the category)', () => {
    for (const r of Object.values(DEFAULT_RULES)) {
      for (const k of [r.debitLedgerKey, r.creditLedgerKey]) expect(isFixedKey(k) ? (LEDGER_KEYS as readonly string[]).includes(k) : k === 'expense.<category>', k).toBe(true);
      expect(r.deductionLedgerKey).toBeNull();   // deductions use the stat.* key of their label, not a label
    }
  });
});

describe('payroll deductions', () => {
  it('post to stat.* (or asset) keys by label, whatever the case; an unknown label has no key', () => {
    expect(deductionLedgerKey('PT')).toBe('stat.pt');
    expect(deductionLedgerKey(' Tds ')).toBe('stat.tds');
    expect(deductionLedgerKey('Advance')).toBe('asset.staff_advance');
    expect(deductionLedgerKey('Canteen')).toBeNull();
    for (const k of Object.values(DEDUCTION_LEDGER_KEYS)) expect((LEDGER_KEYS as readonly string[]).includes(k)).toBe(true);
  });
});
