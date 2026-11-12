import { LETTER_FIELDS, LetterField } from '@ageless/shared';

/** The built-in joining letter, used until HR saves a company's own. Plain text; blank lines separate paragraphs. */
export const DEFAULT_JOINING = {
  title: 'Letter of appointment',
  body: [
    'Dear {{fullName}},',
    'We are pleased to confirm your appointment with {{company}} as {{designation}} in the {{department}} department, with effect from {{joiningDate}}.',
    'Your employee ID is {{employeeCode}} and your engagement is {{engagementType}}. You will report to {{manager}}.',
    'Please bring this letter, your ID proof and your bank details on your first day.',
    'We look forward to working with you.',
    'Yours sincerely,\n\nFor {{company}}\nHuman Resources',
  ].join('\n\n'),
};

const FIELD = /\{\{\s*([A-Za-z]+)\s*\}\}/g;

/** Fill-ins used in the text that are not known fields (a typo such as {{nmae}}). Pure. */
export function unknownFields(text: string): string[] {
  const known = new Set<string>(LETTER_FIELDS);
  return [...new Set([...text.matchAll(FIELD)].map((m) => m[1]).filter((f) => !known.has(f)))];
}

/** Replaces every {{field}} with its value; a field with no value becomes a dash. Pure. */
export function fillLetter(text: string, values: Record<LetterField, string | null>): string {
  return text.replace(FIELD, (whole, name: string) => (name in values ? (values[name as LetterField] || '-') : whole));
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** 2026-11-09 → "9 November 2026". Pure. */
export function longDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}
