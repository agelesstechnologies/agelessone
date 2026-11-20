/**
 * Reads what Tally answers after an Import Data request. Pure text in, facts out, so the backend (a person uploads the
 * text) and the connector (it just got the answer from Tally) read it the same way. Only what the text says is claimed.
 */
export interface TallyResponseFields {
  /** The text had at least one of Tally's result tags. */
  readable: boolean;
  created: number | null;
  altered: number | null;
  errors: number | null;
  lastVchId: string | null;
  /** Every LINEERROR text, decoded and on one line. */
  lineErrors: string[];
}

export const unescapeXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const intTag = (xml: string, tag: string): number | null => {
  const m = new RegExp(`<${tag}>\\s*(\\d+)(?:\\.\\d+)?\\s*</${tag}>`, 'i').exec(xml);
  return m ? Number(m[1]) : null;
};

export function parseTallyResponse(text: string): TallyResponseFields {
  const created = intTag(text, 'CREATED');
  const altered = intTag(text, 'ALTERED');
  const errors = intTag(text, 'ERRORS');
  const vch = /<LASTVCHID>\s*([^<\s][^<]*?)\s*<\/LASTVCHID>/i.exec(text);
  const lineErrors = [...text.matchAll(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/gi)]
    .map((m) => unescapeXml(m[1]!).replace(/\s+/g, ' ').trim()).filter(Boolean);
  return { readable: created !== null || altered !== null || errors !== null || lineErrors.length > 0, created, altered, errors, lastVchId: vch ? unescapeXml(vch[1]!) : null, lineErrors };
}

/** The names Tally lists for a collection export: each <LEDGER NAME="..."> (or COSTCENTRE) element, decoded, in order, without repeats. */
export function parseTallyNames(text: string, element: 'LEDGER' | 'COSTCENTRE'): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(new RegExp(`<${element}\\s[^>]*?\\bNAME="([^"]*)"`, 'gi'))) {
    const name = unescapeXml(m[1]!);
    if (name) out.add(name);
  }
  return [...out];
}

/** The ledger names an import envelope uses (every <LEDGERNAME>), decoded, in order, without repeats. */
export function ledgerNamesUsed(importXml: string): string[] {
  return [...new Set([...importXml.matchAll(/<LEDGERNAME>([\s\S]*?)<\/LEDGERNAME>/g)].map((m) => unescapeXml(m[1]!)))];
}
