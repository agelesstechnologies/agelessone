import { describe, expect, it } from 'vitest';
import { LedgerNames, TallyBuildError, TallyEntry, buildTallyXml, readinessProblems, rupees, voucherKindOf, xmlEscape } from './tally-xml';

const names: LedgerNames = new Map([
  ['expense.fuel', { tallyLedgerName: 'Fuel Expenses', approved: true }],
  ['payable.reimbursements', { tallyLedgerName: 'Staff Reimbursements Payable', approved: true }],
  ['bank.operating', { tallyLedgerName: 'HDFC Current', approved: true }],
]);
const id1 = '11111111-1111-4111-8111-111111111111';
const id2 = '22222222-2222-4222-8222-222222222222';
const entry = (over: Partial<TallyEntry> = {}): TallyEntry => ({
  publicId: id1, entryDate: '2026-11-07', voucherKind: 'journal', narration: null,
  lines: [{ ledgerKey: 'expense.fuel', debitMinor: 123_45, creditMinor: 0 }, { ledgerKey: 'payable.reimbursements', debitMinor: 0, creditMinor: 123_45 }], ...over,
});
const build = (entries: TallyEntry[], n: LedgerNames = names, company = 'Ageless Technologies') => buildTallyXml({ tallyCompanyName: company, entries, names: n });
const failure = (fn: () => unknown): TallyBuildError => { try { fn(); } catch (e) { return e as TallyBuildError; } throw new Error('did not throw'); };
/** Every AMOUNT of one voucher, in paise. */
const amounts = (xml: string) => [...xml.matchAll(/<AMOUNT>(-?\d+)\.(\d\d)<\/AMOUNT>/g)].map((m) => Number(m[1] + m[2]));

describe('Tally XML: signs', () => {
  it('a debit is ISDEEMEDPOSITIVE Yes with a negative amount; a credit is No with a positive amount', () => {
    const xml = build([entry()]);
    expect(xml).toContain('<LEDGERNAME>Fuel Expenses</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-123.45</AMOUNT>');
    expect(xml).toContain('<LEDGERNAME>Staff Reimbursements Payable</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>123.45</AMOUNT>');
  });
  it('the envelope names the company, the report, the date, the REMOTEID and the voucher type', () => {
    const xml = build([entry()]);
    expect(xml.startsWith('<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>')).toBe(true);
    expect(xml).toContain('<REPORTNAME>Vouchers</REPORTNAME>');
    expect(xml).toContain('<SVCURRENTCOMPANY>Ageless Technologies</SVCURRENTCOMPANY>');
    expect(xml).toContain(`<VOUCHER REMOTEID="${id1}" VCHTYPE="Platform Journal" ACTION="Create">`);
    expect(xml).toContain('<DATE>20261107</DATE><VOUCHERTYPENAME>Platform Journal</VOUCHERTYPENAME>');
  });
  it('payments use "Platform Payment"; a reversal follows the entry it reverses', () => {
    expect(build([entry({ voucherKind: 'payment' })])).toContain('VCHTYPE="Platform Payment"');
    expect([voucherKindOf('expense_approved'), voucherKindOf('payroll_approved'), voucherKindOf('expense_paid'), voucherKindOf('salary_paid')]).toEqual(['journal', 'journal', 'payment', 'payment']);
    expect([voucherKindOf('reversal', 'salary_paid'), voucherKindOf('reversal', 'expense_approved'), voucherKindOf('reversal')]).toEqual(['payment', 'journal', 'journal']);
  });
  it('many entries go into one envelope, in the order given', () => {
    const xml = build([entry(), entry({ publicId: id2, voucherKind: 'payment' })]);
    expect(xml.match(/<ENVELOPE>/g)).toHaveLength(1);
    expect(xml.match(/<VOUCHER /g)).toHaveLength(2);
    expect(xml.indexOf(id1)).toBeLessThan(xml.indexOf(id2));
  });
});

describe('Tally XML: rounding (whole paise to rupees, two decimals)', () => {
  it('formats paise exactly', () => {
    expect([rupees(0), rupees(5), rupees(99), rupees(100), rupees(12_345), rupees(-250), rupees(100_000_000_00)]).toEqual(['0.00', '0.05', '0.99', '1.00', '123.45', '-2.50', '100000000.00']);
  });
  it('never uses floating point: amounts that floats get wrong stay exact', () => {
    expect([rupees(1_005), rupees(29), rupees(1_000_000_000_07), rupees(Number.MAX_SAFE_INTEGER)]).toEqual(['10.05', '0.29', '1000000000.07', '90071992547409.91']);
  });
  it('refuses a fraction of a paisa', () => {
    expect(failure(() => rupees(10.5)).code).toBe('TALLY_BAD_ENTRY');
    expect(failure(() => build([entry({ lines: [{ ledgerKey: 'expense.fuel', debitMinor: 10.5, creditMinor: 0 }, { ledgerKey: 'bank.operating', debitMinor: 0, creditMinor: 10.5 }] })])).code).toBe('TALLY_BAD_ENTRY');
  });
});

describe('Tally XML: escaping', () => {
  const tricky = 'Smith & Sons <"Fuel"> \'A\'';
  it('escapes & < > " \' in ledger names, narration and the company name', () => {
    const n: LedgerNames = new Map([...names, ['expense.fuel', { tallyLedgerName: tricky, approved: true }]]);
    const xml = build([entry({ narration: 'Fuel & oil <May>' })], n, 'A & B "Pvt" Ltd');
    expect(xml).toContain('<LEDGERNAME>Smith &amp; Sons &lt;&quot;Fuel&quot;&gt; &apos;A&apos;</LEDGERNAME>');
    expect(xml).toContain('<NARRATION>Fuel &amp; oil &lt;May&gt;</NARRATION>');
    expect(xml).toContain('<SVCURRENTCOMPANY>A &amp; B &quot;Pvt&quot; Ltd</SVCURRENTCOMPANY>');
    expect(xml).not.toContain('Smith & Sons');
  });
  it('does not double-escape, and drops characters XML cannot hold', () => {
    expect(xmlEscape('&amp;')).toBe('&amp;amp;');
    expect(xmlEscape('a\u0000b\u0008c\u000Bd\ne\tf')).toBe('abcd\ne\tf');
  });
});

describe('Tally XML: zero-sum', () => {
  it('the signed amounts of every voucher add up to exactly zero', () => {
    const three = entry({ publicId: '33333333-3333-4333-8333-333333333333', lines: [{ ledgerKey: 'expense.fuel', debitMinor: 100_01, creditMinor: 0 }, { ledgerKey: 'expense.fuel', debitMinor: 0, creditMinor: 33_34 }, { ledgerKey: 'bank.operating', debitMinor: 0, creditMinor: 66_67 }] });
    for (const e of [entry(), three]) expect(amounts(build([e])).reduce((a, b) => a + b, 0)).toBe(0);
    const both = amounts(build([entry(), three, entry({ publicId: id2 })]));
    expect(both.reduce((a, b) => a + b, 0)).toBe(0);
  });
  it('refuses an entry whose debits and credits differ, and one-sided or empty lines', () => {
    const off = entry({ lines: [{ ledgerKey: 'expense.fuel', debitMinor: 100, creditMinor: 0 }, { ledgerKey: 'bank.operating', debitMinor: 0, creditMinor: 99 }] });
    expect(failure(() => build([off])).code).toBe('TALLY_UNBALANCED');
    expect(failure(() => build([entry({ lines: [{ ledgerKey: 'expense.fuel', debitMinor: 100, creditMinor: 0 }] })])).code).toBe('TALLY_BAD_ENTRY');
    expect(failure(() => build([entry({ lines: [{ ledgerKey: 'expense.fuel', debitMinor: 100, creditMinor: 100 }, { ledgerKey: 'bank.operating', debitMinor: 0, creditMinor: 0 }] })])).code).toBe('TALLY_BAD_ENTRY');
    expect(failure(() => build([entry({ lines: [{ ledgerKey: 'expense.fuel', debitMinor: -5, creditMinor: 0 }, { ledgerKey: 'bank.operating', debitMinor: 0, creditMinor: -5 }] })])).code).toBe('TALLY_BAD_ENTRY');
  });
  it('refuses nothing to send, a repeated entry, a bad date and an empty company', () => {
    expect(failure(() => build([])).code).toBe('TALLY_NOTHING_TO_SEND');
    expect(failure(() => build([entry(), entry()])).code).toBe('TALLY_BAD_ENTRY');
    expect(failure(() => build([entry({ entryDate: '07/11/2026' })])).code).toBe('TALLY_BAD_ENTRY');
    expect(failure(() => build([entry()], names, '  ')).code).toBe('TALLY_BAD_ENTRY');
  });
});

describe('Tally readiness', () => {
  it('an unmapped key refuses the whole batch and lists every problem; nothing is built', () => {
    const partial: LedgerNames = new Map([['expense.fuel', { tallyLedgerName: 'Fuel Expenses', approved: true }]]);
    const err = failure(() => build([entry(), entry({ publicId: id2 })], partial));
    expect(err.code).toBe('TALLY_NOT_READY');
    expect(err.message).toContain('payable.reimbursements');
    expect(err.problems).toEqual([
      { entryPublicId: id1, ledgerKey: 'payable.reimbursements', reason: 'unmapped' },
      { entryPublicId: id2, ledgerKey: 'payable.reimbursements', reason: 'unmapped' },
    ]);
  });
  it('a draft (not yet approved) mapping is not ready; a blank Tally name counts as unmapped', () => {
    const n: LedgerNames = new Map([...names, ['expense.fuel', { tallyLedgerName: 'Fuel', approved: false }], ['bank.operating', { tallyLedgerName: '  ', approved: true }]]);
    const e = entry({ lines: [...entry().lines, { ledgerKey: 'bank.operating', debitMinor: 1, creditMinor: 0 }, { ledgerKey: 'payable.reimbursements', debitMinor: 0, creditMinor: 1 }] });
    expect(readinessProblems([e], n).map((p) => [p.ledgerKey, p.reason])).toEqual([['expense.fuel', 'not_approved'], ['bank.operating', 'unmapped']]);
  });
  it('a fully approved, mapped batch has no problems', () => expect(readinessProblems([entry()], names)).toEqual([]));
});
