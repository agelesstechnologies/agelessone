export interface PolicyVersion { legalEntityId: number | null; version: number; effectiveFrom: string }

/**
 * The version in force on `date`: among versions already effective, the company's own (newest version) wins over the
 * group default (legal entity null, newest version). undefined when nothing is in force yet. Pure: no database.
 */
export function versionInForce<T extends PolicyVersion>(versions: T[], companyId: number | null, date: string): T | undefined {
  const newest = (rows: T[]) => rows.reduce<T | undefined>((best, r) => (!best || r.version > best.version ? r : best), undefined);
  const effective = versions.filter((v) => v.effectiveFrom <= date);
  return (companyId !== null ? newest(effective.filter((v) => v.legalEntityId === companyId)) : undefined)
    ?? newest(effective.filter((v) => v.legalEntityId === null));
}
