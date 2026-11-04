export interface ApproverCandidates { managerId: number | null; departmentHeadId: number | null; hrIds: number[]; ceoIds: number[] }

/**
 * Who decides a request: the job's manager, then the department head, then HR, then the CEO — never anyone in
 * `notAllowed` (the person it is about and whoever filed it). null when nobody is left. Pure: no database.
 */
export function pickApprover(notAllowed: number[], c: ApproverCandidates): number | null {
  return [c.managerId, c.departmentHeadId, ...c.hrIds, ...c.ceoIds].find((id): id is number => id !== null && !notAllowed.includes(id)) ?? null;
}
