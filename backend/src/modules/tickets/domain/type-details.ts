/** Checks a ticket's type details against the fields of its type version. Pure. */
export interface FieldDef { key: string; label: string; type: string; required: boolean }

export interface DetailsCheck {
  /** the cleaned values (trimmed text), only known keys */
  value: Record<string, unknown>;
  /** one line per problem, e.g. "vendor: required" */
  errors: string[];
  /** person publicIds and attachment publicIds the caller must still check exist */
  personIds: string[];
  attachmentIds: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const empty = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/**
 * Each value must fit its field's type: text / customer (text until the customer register exists, 1–1000 / 1–200
 * characters), number (finite), money (whole paise, 0 or more), date (YYYY-MM-DD), person and file (a publicId; a file is
 * an attachment of the same ticket). Unknown keys are refused. Required fields must be filled — except files while
 * filesLater (creating or editing: files are uploaded to the ticket first); completion checks every required field (see missingRequired).
 */
export function checkDetails(fields: FieldDef[], details: Record<string, unknown>, opts: { filesLater: boolean }): DetailsCheck {
  const out: DetailsCheck = { value: {}, errors: [], personIds: [], attachmentIds: [] };
  const byKey = new Map(fields.map((f) => [f.key, f]));
  for (const key of Object.keys(details)) if (!byKey.has(key)) out.errors.push(`${key}: not a field of this ticket type`);
  for (const f of fields) {
    const v = details[f.key];
    if (empty(v)) {
      if (f.required && !(opts.filesLater && f.type === 'file')) out.errors.push(`${f.key}: required`);
      continue;
    }
    const bad = (why: string) => out.errors.push(`${f.key}: ${why}`);
    switch (f.type) {
      case 'text':
      case 'customer': {
        const max = f.type === 'text' ? 1000 : 200;
        if (typeof v !== 'string') bad('must be text');
        else if (v.trim().length > max) bad(`at most ${max} characters`);
        else out.value[f.key] = v.trim();
        break;
      }
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) bad('must be a number');
        else out.value[f.key] = v;
        break;
      case 'money':
        if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) bad('must be whole paise, 0 or more');
        else out.value[f.key] = v;
        break;
      case 'date':
        if (typeof v !== 'string' || !DATE.test(v) || Number.isNaN(Date.parse(v))) bad('must be a date (YYYY-MM-DD)');
        else out.value[f.key] = v;
        break;
      case 'person':
      case 'file':
        if (typeof v !== 'string' || !UUID.test(v)) bad(f.type === 'person' ? "must be a person's publicId" : "must be an attachment's publicId");
        else {
          out.value[f.key] = v.toLowerCase();
          (f.type === 'person' ? out.personIds : out.attachmentIds).push(v.toLowerCase());
        }
        break;
      default:
        bad(`unknown field type ${f.type}`);
    }
  }
  return out;
}

/** Required fields still empty (for completion). */
export function missingRequired(fields: FieldDef[], details: Record<string, unknown>): string[] {
  return fields.filter((f) => f.required && empty(details[f.key])).map((f) => f.key);
}
