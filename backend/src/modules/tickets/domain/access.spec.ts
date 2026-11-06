import { describe, expect, it } from 'vitest';
import { whyNotManage } from './access';

const own = { isStandard: false, ownerDepartmentId: 7 };

describe('who may manage a ticket type', () => {
  it('scope all manages everything, standard and company-wide included', () => {
    expect(whyNotManage('all', { isStandard: true, ownerDepartmentId: null }, false)).toBeNull();
    expect(whyNotManage('all', own, false)).toBeNull();
  });
  it('a head manages a non-standard type of their own department', () => {
    expect(whyNotManage('team', own, true)).toBeNull();
  });
  it('a head cannot change a standard type, even one their department owns', () => {
    expect(whyNotManage('team', { isStandard: true, ownerDepartmentId: 7 }, true)).toBe('STANDARD');
  });
  it('a head cannot change another department or a company-wide type', () => {
    expect(whyNotManage('team', own, false)).toBe('NOT_HEAD');
    expect(whyNotManage('team', { isStandard: false, ownerDepartmentId: null }, true)).toBe('NOT_HEAD');
  });
});
