import { describe, expect, it } from 'vitest';
import { nextEmployeeCode } from './employee-codes';

describe('nextEmployeeCode', () => {
  it('starts at 001 for a new prefix', () => expect(nextEmployeeCode('ATS', [])).toBe('ATS001'));
  it('follows the highest number, including codes typed when importing', () => {
    expect(nextEmployeeCode('ATS', ['ATS001', 'ATS002'])).toBe('ATS003');
    expect(nextEmployeeCode('ATS', ['ATS001', 'ATS050'])).toBe('ATS051');
  });
  it('counts only its own prefix, even when another starts the same way', () => {
    expect(nextEmployeeCode('ATH', ['ATHR007', 'ATS009', 'ATH002'])).toBe('ATH003');
    expect(nextEmployeeCode('ATHR', ['ATH002'])).toBe('ATHR001');
  });
  it('goes past 999 without losing digits', () => expect(nextEmployeeCode('ATS', ['ATS999'])).toBe('ATS1000'));
});
