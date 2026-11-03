import { describe, it, expect } from 'vitest';
import { issuedAfterPasswordChange, parseLogin, widestScopes } from './login';

describe('parseLogin', () => {
  it('a phone in any format becomes the stored form', () => expect(parseLogin(' +91 (00000) 000-01 ')).toEqual({ phone: '+910000000001' }));
  it('an email is lower case', () => expect(parseLogin('Demo.HR@Example.com')).toEqual({ email: 'demo.hr@example.com' }));
});

describe('widestScopes', () => {
  it('keeps the widest scope per permission', () => {
    expect(widestScopes([
      { code: 'hrms.people.view', scope: 'own' },
      { code: 'hrms.people.view', scope: 'team' },
      { code: 'hrms.employments.update', scope: 'team' },
    ])).toEqual({ 'hrms.people.view': 'team', 'hrms.employments.update': 'team' });
  });
  it('all beats team', () => expect(widestScopes([{ code: 'x', scope: 'all' }, { code: 'x', scope: 'team' }])).toEqual({ x: 'all' }));
});

describe('issuedAfterPasswordChange', () => {
  const changed = new Date('2026-11-03T10:00:00.500Z');
  it('a token from the same second or later is fine', () => {
    expect(issuedAfterPasswordChange(changed.getTime() / 1000 | 0, changed)).toBe(true);
    expect(issuedAfterPasswordChange((changed.getTime() / 1000 | 0) + 60, changed)).toBe(true);
  });
  it('an older token is refused', () => expect(issuedAfterPasswordChange((changed.getTime() / 1000 | 0) - 1, changed)).toBe(false));
});
