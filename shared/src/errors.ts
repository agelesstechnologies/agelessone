import { z, type ZodIssue } from 'zod';

/**
 * Plain-language validation messages, the same in the backend (API answers) and the web app (form checks).
 * A message written in a schema (e.g. .min(2, 'Give their name')) is kept; only zod's defaults are replaced.
 */

/** "employmentPublicId" → "Employment"; ["items", 0, "ticketPublicId"] → "Item 1 ticket". */
export function fieldLabel(path: (string | number)[]): string {
  const parts = path.map((p, i) => {
    if (typeof p === 'number') return String(p + 1);
    const w = p.replace(/PublicIds?$/, '').replace(/([Aa]mount)Paise$/, '$1').replace(/Paise$/, ' amount').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase().trim();
    return typeof path[i + 1] === 'number' && w.endsWith('s') ? w.slice(0, -1) : w;   // "items", 0 → "item 1"
  }).filter(Boolean);
  const text = parts.join(' ');
  return text ? text[0]!.toUpperCase() + text.slice(1) : 'Value';
}

const KIND: Record<string, string> = { string: 'text', number: 'a number', integer: 'a whole number', boolean: 'yes or no', date: 'a date',
  array: 'a list', object: 'details', bigint: 'a number' };

/** zod's default messages, rewritten with the field's name: "Title must have at least 3 characters". */
export const friendlyErrorMap: z.ZodErrorMap = (issue, ctx) => {
  const f = fieldLabel(issue.path);
  switch (issue.code) {
    case 'invalid_type':
      if (issue.received === 'undefined' || issue.received === 'null') return { message: `${f} is required` };
      return { message: `${f} must be ${KIND[issue.expected] ?? issue.expected}` };
    case 'too_small':
      if (issue.type === 'string') return { message: Number(issue.minimum) <= 1 ? `${f} is required` : `${f} must have at least ${issue.minimum} characters` };
      if (issue.type === 'array') return { message: Number(issue.minimum) <= 1 ? `Add at least one ${f.toLowerCase()}` : `${f}: add at least ${issue.minimum}` };
      if (issue.type === 'date') return { message: `${f} is too early` };
      return { message: `${f} must be ${issue.inclusive ? 'at least' : 'more than'} ${issue.minimum}` };
    case 'too_big':
      if (issue.type === 'string') return { message: `${f} can have at most ${issue.maximum} characters` };
      if (issue.type === 'array') return { message: `${f}: at most ${issue.maximum}` };
      if (issue.type === 'date') return { message: `${f} is too late` };
      return { message: `${f} must be ${issue.inclusive ? 'at most' : 'less than'} ${issue.maximum}` };
    case 'invalid_string':
      if (issue.validation === 'email') return { message: `${f} must be a valid email address` };
      if (issue.validation === 'uuid') return { message: `${f}: choose one from the list` };
      if (issue.validation === 'datetime') return { message: `${f} must be a date and time` };
      if (issue.validation === 'url') return { message: `${f} must be a web address` };
      return { message: `${f} has the wrong format` };
    case 'invalid_enum_value':
      return { message: `${f} must be one of: ${issue.options.join(', ')}` };
    case 'invalid_literal':
      return { message: `${f} must be ${JSON.stringify(issue.expected)}` };
    case 'invalid_date':
      return { message: `${f} is not a valid date` };
    case 'not_multiple_of':
      return { message: `${f} must be a multiple of ${issue.multipleOf}` };
    case 'unrecognized_keys':
      return { message: `Unknown field${issue.keys.length > 1 ? 's' : ''}: ${issue.keys.join(', ')}` };
    case 'invalid_union':
    case 'invalid_union_discriminator':
      return { message: `${f} is not valid` };
    default:
      return { message: ctx.defaultError };
  }
};
z.setErrorMap(friendlyErrorMap);

/** One issue as a sentence. A message written in a schema without the field's name gets it in front: "Name: Give their name". */
export function issueText(issue: Pick<ZodIssue, 'path' | 'message'>): string {
  if (!issue.path.length) return issue.message;
  const f = fieldLabel(issue.path);
  return issue.message.toLowerCase().startsWith(f.toLowerCase()) || /^(add|unknown)/i.test(issue.message) ? issue.message : `${f}: ${issue.message}`;
}

/** Several issues as one line for a banner: the first three, then "and N more". */
export function issuesText(issues: Pick<ZodIssue, 'path' | 'message'>[]): string {
  const seen = new Set<string>();
  const one = issues.filter((i) => { const k = i.path.join('.'); if (seen.has(k)) return false; seen.add(k); return true; });   // one message per field
  const shown = one.slice(0, 3).map(issueText);
  return shown.join('. ') + (one.length > 3 ? `. And ${one.length - 3} more.` : '');
}
