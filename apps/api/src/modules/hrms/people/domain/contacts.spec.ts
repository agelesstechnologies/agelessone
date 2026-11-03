import { describe, it, expect } from 'vitest';
import { normalizeContactValue, phoneSearchTerm, prepareContacts } from './contacts';

describe('normalizeContactValue', () => {
  it('phone loses spaces, dashes and brackets', () => expect(normalizeContactValue('phone', ' +91 (00000) 111-11 ')).toBe('+910000011111'));
  it('email is lower case', () => expect(normalizeContactValue('email', 'Demo.User@Example.COM')).toBe('demo.user@example.com'));
});

describe('prepareContacts', () => {
  it('first contact of each kind is primary when none is marked', () => {
    const out = prepareContacts([{ kind: 'phone', value: '000 001' }, { kind: 'phone', value: '000 002' }, { kind: 'email', value: 'a@example.com' }]);
    expect(out.map((c) => c.isPrimary)).toEqual([true, false, true]);
  });
  it('a marked contact stays the only primary of its kind', () => {
    const out = prepareContacts([{ kind: 'phone', value: '000 001' }, { kind: 'phone', value: '000 002', isPrimary: true }]);
    expect(out.map((c) => c.isPrimary)).toEqual([false, true]);
  });
});

describe('phoneSearchTerm', () => {
  it('formatted number becomes stored form', () => expect(phoneSearchTerm('00000 111')).toBe('00000111'));
  it('names and codes are not phone searches', () => {
    expect(phoneSearchTerm('Demo')).toBeNull();
    expect(phoneSearchTerm('AE-D001')).toBeNull();
  });
});
