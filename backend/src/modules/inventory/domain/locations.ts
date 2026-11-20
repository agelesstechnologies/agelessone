import type { LocationType } from '@ageless/shared';

/** The types that sit inside another location, and what they may sit in. Every other type stands on its own. */
const INSIDE: Partial<Record<LocationType, LocationType[]>> = { rack: ['store'], bin: ['store', 'rack'] };

const LABEL: Record<LocationType, string> = {
  store: 'store', rack: 'rack', bin: 'bin', work_area: 'work area', testing: 'testing space', transit: 'transit location',
  quarantine: 'quarantine location', scrap: 'scrap location',
};
const article = (word: string) => (/^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`);
export const locationLabel = (type: LocationType): string => LABEL[type];

/** Why a location of this type cannot have this parent (null: no parent), or null when it can. */
export function placementProblem(type: LocationType, parentType: LocationType | null): string | null {
  const allowed = INSIDE[type];
  if (!allowed) return parentType === null ? null : `${article(LABEL[type])} stands on its own; it cannot be inside another location`;
  const inside = allowed.map((k) => LABEL[k]).join(' or ');
  if (parentType === null) return `${article(LABEL[type])} goes inside ${article(inside)}: give its parent`;
  return allowed.includes(parentType) ? null : `${article(LABEL[type])} goes inside ${article(inside)}, not ${article(LABEL[parentType])}`;
}

/** Racks and bins may leave the custodian empty (their parent's answers for them); every other type needs one. */
export function needsCustodian(type: LocationType): boolean {
  return INSIDE[type] === undefined;
}

/** Where received stock may be kept by default: not in transit, quarantine or scrap. */
export function canHoldNewStock(type: LocationType): boolean {
  return !['transit', 'quarantine', 'scrap'].includes(type);
}

/** Order for creating locations so parents come first: stand-alone types, then racks, then bins. */
export const creationOrder = (type: LocationType): number => (type === 'bin' ? 2 : type === 'rack' ? 1 : 0);

/**
 * The locations a person is responsible for: those whose responsible custodian (their own, else the nearest parent's) is
 * one of the person's jobs. A storekeeper of a store is responsible for its racks and bins unless those name someone else.
 */
export function responsibleLocations(all: { id: number; parentId: number | null; custodianEmploymentId: number | null }[], jobIds: number[]): Set<number> {
  const byId = new Map(all.map((l) => [l.id, { parentId: l.parentId, custodian: l.custodianEmploymentId }]));
  return new Set(all.filter((l) => { const r = responsibleFor(l.id, byId); return r !== null && jobIds.includes(r); }).map((l) => l.id));
}

/** The custodian who answers for a location: its own, else the nearest parent's (racks and bins sit at most two deep). */
export function responsibleFor<T>(id: number, byId: Map<number, { parentId: number | null; custodian: T | null }>): T | null {
  for (let at = byId.get(id), depth = 0; at && depth < 5; at = at.parentId === null ? undefined : byId.get(at.parentId), depth++) {
    if (at.custodian !== null) return at.custodian;
  }
  return null;
}
