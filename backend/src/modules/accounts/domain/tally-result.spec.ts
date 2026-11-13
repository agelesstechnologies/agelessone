import { describe, expect, it } from 'vitest';
import { judgeResult, parseTallyResult } from './tally-result';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const ok = '<RESPONSE><CREATED>2</CREATED><ALTERED>0</ALTERED><DELETED>0</DELETED><LASTVCHID>5</LASTVCHID><ERRORS>0</ERRORS></RESPONSE>';

describe('Tally import result', () => {
  it('a clean result: nothing failed, nothing unclear', () => {
    const r = parseTallyResult(ok, [A, B]);
    expect([r.readable, r.created, r.errors, r.lineErrors]).toEqual([true, 2, 0, []]);
    expect(judgeResult(r, 2)).toEqual({ failed: [], unclear: [] });
  });

  it('an error that names the entry\'s REMOTEID sends that entry back, with the text decoded', () => {
    const text = `<RESPONSE><CREATED>1</CREATED><ERRORS>1</ERRORS><LINEERROR>Voucher ${A.toUpperCase()}: Ledger &quot;Fuel &amp; Oil&quot; does not exist!</LINEERROR></RESPONSE>`;
    const r = parseTallyResult(text, [A, B]);
    expect(r.failed).toEqual([{ remoteId: A, error: `Voucher ${A.toUpperCase()}: Ledger "Fuel & Oil" does not exist!` }]);
    expect(judgeResult(r, 2)).toEqual({ failed: r.failed, unclear: [] });
  });

  it('an error that names no entry is unclear: a person must say which entries failed', () => {
    const r = parseTallyResult('<RESPONSE><CREATED>1</CREATED><ERRORS>1</ERRORS><LINEERROR>Ledger does not exist</LINEERROR></RESPONSE>', [A, B]);
    expect(r.unattributed).toEqual(['Ledger does not exist']);
    expect(judgeResult(r, 2).unclear[0]).toMatch(/names no entry/);
  });

  it('counts that do not add up are unclear rather than guessed', () => {
    expect(judgeResult(parseTallyResult('<RESPONSE><CREATED>1</CREATED><ERRORS>0</ERRORS></RESPONSE>', [A, B]), 2).unclear[0]).toMatch(/expected/);
    expect(judgeResult(parseTallyResult('<RESPONSE><CREATED>1</CREATED><ERRORS>2</ERRORS></RESPONSE>', [A, B]), 2).unclear[0]).toMatch(/lists only 0/);
  });

  it('text that is not a Tally result is refused', () => {
    const r = parseTallyResult('<html>hello</html>', [A]);
    expect(r.readable).toBe(false);
    expect(judgeResult(r, 1).unclear[0]).toMatch(/does not look like/);
  });

  it('the same entry named twice fails once', () => {
    const r = parseTallyResult(`<RESPONSE><CREATED>0</CREATED><ERRORS>2</ERRORS><LINEERROR>${A} bad date</LINEERROR><LINEERROR>${A} bad ledger</LINEERROR></RESPONSE>`, [A]);
    expect(r.failed).toHaveLength(1);
  });
});
