import { describe, expect, it } from 'vitest';
import { versionInForce } from './in-force';

const AE = 1;
const ATPL = 2;
const versions = [
  { legalEntityId: null, version: 1, effectiveFrom: '2025-04-01', value: 480 },
  { legalEntityId: null, version: 2, effectiveFrom: '2026-01-01', value: 450 },
  { legalEntityId: AE, version: 1, effectiveFrom: '2026-06-01', value: 420 },
  { legalEntityId: AE, version: 2, effectiveFrom: '2026-09-01', value: 400 },
  { legalEntityId: AE, version: 3, effectiveFrom: '2026-07-01', value: 410 }, // added later, takes effect earlier
];
const valueOn = (company: number | null, date: string) => versionInForce(versions, company, date)?.value;

describe('versionInForce', () => {
  it('the newest group version already in force', () => {
    expect(valueOn(null, '2025-12-31')).toBe(480);
    expect(valueOn(null, '2026-01-01')).toBe(450);
  });
  it('a company\'s own version comes before the group default once it is in force', () => {
    expect(valueOn(AE, '2026-05-31')).toBe(450);
    expect(valueOn(AE, '2026-06-15')).toBe(420);
    expect(valueOn(ATPL, '2026-06-15')).toBe(450);
  });
  it('among versions in force, the highest version number wins', () => {
    expect(valueOn(AE, '2026-08-01')).toBe(410); // v3 in force, v2 not yet
    expect(valueOn(AE, '2026-10-01')).toBe(410); // v2 and v3 in force: v3 is newer
  });
  it('nothing in force before the first version', () => {
    expect(valueOn(AE, '2025-01-01')).toBeUndefined();
  });
});
