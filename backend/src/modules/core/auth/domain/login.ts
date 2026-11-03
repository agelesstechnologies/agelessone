export type Scope = 'own' | 'team' | 'all';
const RANK: Record<Scope, number> = { own: 1, team: 2, all: 3 };

/** What the person typed to sign in: an email (contains @) or a phone number, in stored form. */
export function parseLogin(login: string): { email: string } | { phone: string } {
  const v = login.trim();
  return v.includes('@') ? { email: normalizeEmail(v) } : { phone: normalizePhone(v) };
}

/** Same stored form as contacts: no spaces, dashes, dots or brackets. */
export function normalizePhone(phone: string): string {
  return phone.trim().replace(/[\s\-().]/g, '');
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** One person may hold a permission through several roles: keep the widest scope for each permission. */
export function widestScopes(grants: { code: string; scope: Scope }[]): Record<string, Scope> {
  const out: Record<string, Scope> = {};
  for (const g of grants) {
    if (!out[g.code] || RANK[g.scope] > RANK[out[g.code]]) out[g.code] = g.scope;
  }
  return out;
}

/** A token is only good if it was issued after the last password change (both in whole seconds). */
export function issuedAfterPasswordChange(issuedAtSeconds: number, passwordChangedAt: Date): boolean {
  return issuedAtSeconds >= Math.floor(passwordChangedAt.getTime() / 1000);
}
