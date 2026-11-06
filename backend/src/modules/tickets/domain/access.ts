/** Who may change a ticket type. Pure rules; the service loads the facts. */
export type TypeScope = 'own' | 'team' | 'all' | undefined;

export interface TypeFacts {
  isStandard: boolean;
  /** null: company-wide */
  ownerDepartmentId: number | null;
}

export type Denied = 'STANDARD' | 'NOT_HEAD';

/**
 * Scope all (admin user, Management) manages every type, standard ones included. Anyone else (a department head) manages
 * only a non-standard type owned by a department they head; standard and company-wide types are not theirs to change.
 * Returns why not, or null when allowed.
 */
export function whyNotManage(scope: TypeScope, type: TypeFacts, callerHeadsOwnerDepartment: boolean): Denied | null {
  if (scope === 'all') return null;
  if (type.isStandard) return 'STANDARD';
  if (type.ownerDepartmentId === null || !callerHeadsOwnerDepartment) return 'NOT_HEAD';
  return null;
}
