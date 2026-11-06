import { describe, expect, it } from 'vitest';
import { maskAadhaar, maskAccount, maskPan } from './private-details';

describe('private details masking', () => {
  it('keeps only the last 4 characters', () => {
    expect(maskAadhaar('999988887777')).toBe('XXXX XXXX 7777');
    expect(maskPan('ABCDE1234F')).toBe('XXXXXX234F');
    expect(maskAccount('001234567890')).toBe('XXXXXXXX7890');
  });
});
