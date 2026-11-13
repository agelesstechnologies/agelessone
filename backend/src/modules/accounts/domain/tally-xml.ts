/**
 * Pure builder for the Tally "Import Data" envelope. No database, no NestJS: entries and ledger names go in, one XML
 * string comes out. One call = one company = one envelope.
 *
 * Tally's sign rule for a voucher line: a debit is ISDEEMEDPOSITIVE Yes with a NEGATIVE amount; a credit is
 * ISDEEMEDPOSITIVE No with a POSITIVE amount. So the amounts of a balanced voucher add up to zero.
 * Amounts are whole paise in, rupees with exactly two decimals out (integer arithmetic only, no floating point).
 */

export type VoucherKind = 'journal' | 'payment';
export const VOUCHER_TYPE: Record<VoucherKind, string> = { journal: 'Platform Journal', payment: 'Platform Payment' };

/** Money leaving the bank is a payment; everything else (accruals, reversals of accruals) is a journal. A reversal follows the entry it reverses. */
export function voucherKindOf(sourceType: string, reversesSourceType?: string | null): VoucherKind {
  const t = sourceType === 'reversal' ? reversesSourceType ?? '' : sourceType;
  return t === 'expense_paid' || t === 'salary_paid' ? 'payment' : 'journal';
}

export interface TallyLine { ledgerKey: string; debitMinor: number; creditMinor: number }
export interface TallyEntry {
  publicId: string;          // becomes REMOTEID
  entryDate: string;         // YYYY-MM-DD (IST date)
  voucherKind: VoucherKind;
  narration?: string | null;
  lines: TallyLine[];
}
/** What the Tally ledger map says about a ledger key. Only an approved name may be sent. */
export type LedgerNames = ReadonlyMap<string, { tallyLedgerName: string; approved: boolean }>;

export interface ReadinessProblem { entryPublicId: string; ledgerKey: string; reason: 'unmapped' | 'not_approved' }

/**
 * Which entries cannot be sent yet, and why. Empty list = ready. A draft mapping counts as not ready:
 * Tally never gets a name nobody approved.
 */
export function readinessProblems(entries: readonly TallyEntry[], names: LedgerNames): ReadinessProblem[] {
  const out: ReadinessProblem[] = [];
  for (const e of entries) {
    for (const key of new Set(e.lines.map((l) => l.ledgerKey))) {
      const m = names.get(key);
      if (!m || !m.tallyLedgerName.trim()) out.push({ entryPublicId: e.publicId, ledgerKey: key, reason: 'unmapped' });
      else if (!m.approved) out.push({ entryPublicId: e.publicId, ledgerKey: key, reason: 'not_approved' });
    }
  }
  return out;
}

export type TallyBuildErrorCode = 'TALLY_NOT_READY' | 'TALLY_UNBALANCED' | 'TALLY_BAD_ENTRY' | 'TALLY_NOTHING_TO_SEND';
export class TallyBuildError extends Error {
  constructor(readonly code: TallyBuildErrorCode, message: string, readonly problems: ReadinessProblem[] = []) { super(message); }
}

/** Whole paise to rupees with two decimals, sign kept: 12345 gives "123.45", 5 gives "0.05", -250 gives "-2.50". */
export function rupees(paise: number): string {
  if (!Number.isSafeInteger(paise)) throw new TallyBuildError('TALLY_BAD_ENTRY', `Amount ${paise} is not a whole number of paise`);
  const abs = Math.abs(paise);
  return `${paise < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Escapes text for XML and drops the control characters XML 1.0 cannot hold at all (they would make Tally refuse the whole file). */
export function xmlEscape(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

const tallyDate = (isoDate: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) throw new TallyBuildError('TALLY_BAD_ENTRY', `Date ${isoDate} is not YYYY-MM-DD`);
  return isoDate.replace(/-/g, '');
};

/** One line, signed the Tally way. */
function lineXml(ledgerName: string, l: TallyLine): string {
  const debit = l.debitMinor > 0;
  return `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${xmlEscape(ledgerName)}</LEDGERNAME>`
    + `<ISDEEMEDPOSITIVE>${debit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE><AMOUNT>${rupees(debit ? -l.debitMinor : l.creditMinor)}</AMOUNT></ALLLEDGERENTRIES.LIST>`;
}

/** Checks one entry on its own: at least two lines, each on one side only, whole paise, adding up to zero the Tally way. */
function checkEntry(e: TallyEntry): void {
  if (e.lines.length < 2) throw new TallyBuildError('TALLY_BAD_ENTRY', `Entry ${e.publicId} needs at least two lines`);
  let signed = 0;
  for (const l of e.lines) {
    if (!Number.isSafeInteger(l.debitMinor) || !Number.isSafeInteger(l.creditMinor) || l.debitMinor < 0 || l.creditMinor < 0 || (l.debitMinor > 0) === (l.creditMinor > 0)) {
      throw new TallyBuildError('TALLY_BAD_ENTRY', `Entry ${e.publicId} has a line (${l.ledgerKey}) that is not one positive whole-paise amount on one side`);
    }
    signed += l.creditMinor - l.debitMinor;     // what Tally sees: credits positive, debits negative
  }
  if (signed !== 0) throw new TallyBuildError('TALLY_UNBALANCED', `Entry ${e.publicId} does not add up to zero (off by ${rupees(signed)})`);
}

/**
 * The whole envelope for one company. Refuses (TALLY_NOT_READY, every problem listed) when any line's ledger key has no
 * approved Tally ledger, so a half-mapped batch is never produced. Entries are written in the order given.
 */
export function buildTallyXml(input: { tallyCompanyName: string; entries: readonly TallyEntry[]; names: LedgerNames }): string {
  const { tallyCompanyName, entries, names } = input;
  if (!tallyCompanyName.trim()) throw new TallyBuildError('TALLY_BAD_ENTRY', 'The Tally company name is empty');
  if (!entries.length) throw new TallyBuildError('TALLY_NOTHING_TO_SEND', 'There are no entries to send');
  const problems = readinessProblems(entries, names);
  if (problems.length) {
    const keys = [...new Set(problems.map((p) => p.ledgerKey))].join(', ');
    throw new TallyBuildError('TALLY_NOT_READY', `These ledger keys have no approved Tally ledger: ${keys}`, problems);
  }
  const seen = new Set<string>();
  const vouchers = entries.map((e) => {
    if (seen.has(e.publicId)) throw new TallyBuildError('TALLY_BAD_ENTRY', `Entry ${e.publicId} appears twice`);
    seen.add(e.publicId);
    checkEntry(e);
    const type = xmlEscape(VOUCHER_TYPE[e.voucherKind]);
    const narration = e.narration?.trim() ? `<NARRATION>${xmlEscape(e.narration.trim())}</NARRATION>` : '';
    return `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER REMOTEID="${xmlEscape(e.publicId)}" VCHTYPE="${type}" ACTION="Create">`
      + `<DATE>${tallyDate(e.entryDate)}</DATE><VOUCHERTYPENAME>${type}</VOUCHERTYPENAME>${narration}`
      + e.lines.map((l) => lineXml(names.get(l.ledgerKey)!.tallyLedgerName, l)).join('')
      + '</VOUCHER></TALLYMESSAGE>';
  });
  return '<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA>'
    + `<REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${xmlEscape(tallyCompanyName)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>`
    + `<REQUESTDATA>${vouchers.join('')}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
}
