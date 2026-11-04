import { describe, expect, it } from 'vitest';
import { pickApprover } from './approver';

describe('pickApprover', () => {
  const people = { managerId: 10, departmentHeadId: 20, hrIds: [30, 31], ceoIds: [40] };
  const none = { managerId: null, departmentHeadId: null };
  it('the manager first, then the department head, then HR, then the CEO', () => {
    expect(pickApprover([1], people)).toBe(10);
    expect(pickApprover([1], { ...people, managerId: null })).toBe(20);
    expect(pickApprover([1], { ...people, ...none })).toBe(30);
    expect(pickApprover([1], { ...none, hrIds: [], ceoIds: [40] })).toBe(40);
  });
  it("an HR person's own request goes to the next HR person, or to the CEO when they are the only one", () => {
    expect(pickApprover([30], { ...none, hrIds: [30, 31], ceoIds: [40] })).toBe(31);
    expect(pickApprover([30], { ...none, hrIds: [30], ceoIds: [40] })).toBe(40);
  });
  it('a manager who filed the request for their team member does not decide it', () => {
    expect(pickApprover([1, 10], people)).toBe(20);
  });
  it('nobody left: no approver', () => {
    expect(pickApprover([40], { ...none, hrIds: [], ceoIds: [40] })).toBeNull();
  });
});
