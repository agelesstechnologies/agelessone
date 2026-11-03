export interface Contact { kind: string; value: string; label?: string; isPrimary?: boolean }

const PHONE_LIKE = /^[+\d\s\-().]+$/;
const strip = (v: string) => v.replace(/[\s\-().]/g, '');

/** Stored form: phones without spaces, dashes or brackets ('+91 00000-11111' → '+910000011111'); emails lower case. */
export function normalizeContactValue(kind: string, value: string): string {
  const v = value.trim();
  if (kind === 'phone') return strip(v);
  if (kind === 'email') return v.toLowerCase();
  return v;
}

/** Normalises values and makes sure each kind has exactly one primary: the one marked, else the first. */
export function prepareContacts(contacts: Contact[]): (Contact & { isPrimary: boolean })[] {
  const marked = new Set(contacts.filter((c) => c.isPrimary).map((c) => c.kind));
  const seen = new Set<string>();
  return contacts.map((c) => {
    const isPrimary = marked.has(c.kind) ? c.isPrimary === true : !seen.has(c.kind);
    seen.add(c.kind);
    return { ...c, value: normalizeContactValue(c.kind, c.value), isPrimary };
  });
}

/** A search term that looks like a phone number, in stored form; null for names, codes and emails. */
export function phoneSearchTerm(term: string): string | null {
  const t = term.trim();
  if (!PHONE_LIKE.test(t)) return null;
  const digits = strip(t);
  return digits.replace(/\D/g, '').length >= 3 ? digits : null;
}
