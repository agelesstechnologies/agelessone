import { parseTallyResponse, type TallyResponseFields } from '@ageless/shared';

/**
 * What a Tally import answer means for a batch. Reading the text is shared with the connector (parseTallyResponse in
 * @ageless/shared); this adds the batch's side: which entry an error is about. An error is blamed on an entry only when its
 * text names that entry's REMOTEID. Anything else is reported as unattributed so a person decides.
 */
export interface TallyResult extends TallyResponseFields {
  /** Errors that name one of the batch's entries. */
  failed: { remoteId: string; error: string }[];
  /** Error text that names no entry of the batch. */
  unattributed: string[];
}

/** Fields as Tally gave them (from the connector, or parsed from uploaded text) plus the batch's REMOTEIDs. */
export function attributeResult(fields: TallyResponseFields, remoteIds: readonly string[]): TallyResult {
  const failed: TallyResult['failed'] = [];
  const unattributed: string[] = [];
  const ids = remoteIds.map((id) => [id, id.toLowerCase()] as const);
  for (const line of fields.lineErrors) {
    const lower = line.toLowerCase();
    const hits = ids.filter(([, l]) => lower.includes(l));
    if (!hits.length) unattributed.push(line);
    for (const [id] of hits) if (!failed.some((f) => f.remoteId === id)) failed.push({ remoteId: id, error: line.slice(0, 500) });
  }
  return { ...fields, failed, unattributed };
}

export const parseTallyResult = (text: string, remoteIds: readonly string[]): TallyResult => attributeResult(parseTallyResponse(text), remoteIds);

/**
 * What the result means for a batch of `total` entries: which entries failed, or why a person has to decide.
 * With no `unclear` reasons, `failed` is the full answer and every other entry was created.
 */
export function judgeResult(r: TallyResult, total: number): { failed: { remoteId: string; error: string }[]; unclear: string[] } {
  const unclear: string[] = [];
  if (!r.readable) return { failed: [], unclear: ['This does not look like a Tally import result (no CREATED, ALTERED, ERRORS or LINEERROR)'] };
  if (r.unattributed.length) unclear.push(...r.unattributed.map((l) => `Error that names no entry: ${l}`));
  if ((r.errors ?? 0) > r.lineErrors.length && !r.unattributed.length) unclear.push(`Tally reports ${r.errors} errors but the text lists only ${r.lineErrors.length}`);
  if (r.created !== null) {
    const done = r.created + (r.altered ?? 0);
    const expected = total - r.failed.length;
    if (done !== expected && !unclear.length) unclear.push(`Tally created or altered ${done} vouchers but ${expected} were expected`);
  }
  return { failed: r.failed, unclear };
}
