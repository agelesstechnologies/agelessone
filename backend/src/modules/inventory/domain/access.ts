/** Which companies' inventory a person may use. Pure rules; the service loads the facts. */
export type Scope = 'own' | 'team' | 'all' | undefined;

/**
 * Companies are kept apart: with scope all (Management) a person reaches every company of the tenant; with any narrower
 * scope only the companies they have a current job in; without the permission, none. `scopes` are the person's scopes
 * for the permissions that allow the action (any one is enough).
 */
export function reachableCompanies(scopes: Scope[], allCompanies: number[], companiesWorkedIn: number[]): number[] {
  if (scopes.includes('all')) return allCompanies;
  if (!scopes.some((s) => s !== undefined)) return [];
  return allCompanies.filter((c) => companiesWorkedIn.includes(c));
}

export function mayUseCompany(scopes: Scope[], worksInCompany: boolean): boolean {
  if (scopes.includes('all')) return true;
  return worksInCompany && scopes.some((s) => s !== undefined);
}

/** How far a person reaches into one company's locations (and, later, its stock and documents). */
export type LocationReach = 'every' | 'responsible' | 'none';

/**
 * Scope all: every location of every company. Team, in a company the person works in: every location of it. Own, in a
 * company they work in: only the locations they are responsible for (a storekeeper and the stores they look after).
 * Otherwise none. The widest scope among the permissions wins.
 */
export function locationReach(scopes: Scope[], worksInCompany: boolean): LocationReach {
  if (scopes.includes('all')) return 'every';
  if (!worksInCompany) return 'none';
  if (scopes.includes('team')) return 'every';
  return scopes.includes('own') ? 'responsible' : 'none';
}
