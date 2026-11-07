import type { PostingEvent } from '@ageless/shared';

export interface Line { ledgerKey: string; debitMinor: number; creditMinor: number }

/** A rule as the posting code needs it: which ledgers an event debits and credits. */
export interface Rule {
  eventType: PostingEvent; debitLedgerKey: string; creditLedgerKey: string; deductionLedgerKey: string | null;
}

/**
 * Built-in rules, used when no version is stored. // CA TO CONFIRM: every ledger below is a placeholder until the
 * accounts team and the CA say which entries are debited and credited. <category> and <label> are filled at posting.
 */
export const DEFAULT_RULES: Record<PostingEvent, Rule> = {
  expense_approved: { eventType: 'expense_approved', debitLedgerKey: 'expense:<category>', creditLedgerKey: 'staff_reimbursements_payable', deductionLedgerKey: null },
  expense_paid: { eventType: 'expense_paid', debitLedgerKey: 'staff_reimbursements_payable', creditLedgerKey: 'bank', deductionLedgerKey: null },
  payroll_approved: { eventType: 'payroll_approved', debitLedgerKey: 'salary_expense', creditLedgerKey: 'salary_payable', deductionLedgerKey: 'deduction:<label>' },
  salary_paid: { eventType: 'salary_paid', debitLedgerKey: 'salary_payable', creditLedgerKey: 'bank', deductionLedgerKey: null },
};

/** Fills the variable part of a ledger key: ("expense:<category>", "category", "fuel") → "expense:fuel". */
export function fillKey(template: string, name: string, value: string): string {
  return template.replace(`<${name}>`, value.trim().toLowerCase().replace(/[^a-z0-9_ -]+/g, '_'));
}

/** Ledger keys that need no variable part (these can be mapped to Tally before any entry exists). */
export const isFixedKey = (key: string) => !key.includes('<');

export interface StoredRule extends Rule { companyId: number | null; version: number; effectiveFrom: string }

/** The rule in force for an event on a date: the company's newest stored version, else the group's, else the built-in default. */
export function ruleInForce(stored: StoredRule[], companyId: number, event: PostingEvent, onDate: string): { rule: Rule; stored: StoredRule | null } {
  const pick = (id: number | null) => stored
    .filter((r) => r.eventType === event && r.companyId === id && r.effectiveFrom <= onDate)
    .sort((a, b) => b.version - a.version)[0];
  const found = pick(companyId) ?? pick(null);
  return found ? { rule: found, stored: found } : { rule: DEFAULT_RULES[event], stored: null };
}

/** Debits equal credits, at least two lines, every line on one side only. Returns what is wrong, or null. */
export function unbalanced(lines: Line[]): string | null {
  if (lines.length < 2) return 'An entry needs at least two lines';
  for (const l of lines) {
    if (!Number.isSafeInteger(l.debitMinor) || !Number.isSafeInteger(l.creditMinor) || l.debitMinor < 0 || l.creditMinor < 0) return 'Amounts are whole paise, never negative';
    if ((l.debitMinor > 0) === (l.creditMinor > 0)) return `Line ${l.ledgerKey} must debit or credit, not both or neither`;
  }
  const debit = lines.reduce((s, l) => s + l.debitMinor, 0);
  const credit = lines.reduce((s, l) => s + l.creditMinor, 0);
  return debit === credit ? null : `Debits ${debit} and credits ${credit} differ`;
}

/** The lines of a reversing entry: every debit becomes a credit and the other way round. */
export const reverseLines = (lines: Line[]): Line[] => lines.map((l) => ({ ledgerKey: l.ledgerKey, debitMinor: l.creditMinor, creditMinor: l.debitMinor }));

/** Net balance per ledger (debits minus credits). */
export function balances(lines: Line[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lines) out.set(l.ledgerKey, (out.get(l.ledgerKey) ?? 0) + l.debitMinor - l.creditMinor);
  return out;
}
