import { z } from 'zod';
/** Holidays, weekly offs and each job's work calendar: shared by the API and the web app. Dates are IST. */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((d) => !Number.isNaN(Date.parse(d)), 'Not a real date');
const emptyToUndefined = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
const company = z.string().trim().min(1).max(12);
const weekday = z.number().int().min(0, '0 = Sunday').max(6, '6 = Saturday');

/**
 * Every weekday listed in `weekdays`, plus the nth time a weekday comes in the month (0 = Sunday … 6 = Saturday).
 * { weekdays: [0], nthWeekdays: [{ weekday: 6, nth: [2, 4] }] } = every Sunday and the 2nd and 4th Saturday.
 * Both lists empty = no weekly off.
 */
export const WeeklyOffRule = z.object({
  weekdays: z.array(weekday).max(7).default([]),
  nthWeekdays: z.array(z.object({ weekday, nth: z.array(z.number().int().min(1).max(5)).min(1).max(5) })).max(7).default([]),
});
export type WeeklyOffRule = z.infer<typeof WeeklyOffRule>;

/** GET /api/hrms/holidays?company=&year= — company optional (all companies). */
export const HolidaysQuery = z.object({ company: emptyToUndefined(company), year: z.coerce.number().int().min(2000).max(2100) });
export type HolidaysQuery = z.infer<typeof HolidaysQuery>;

/** POST /api/hrms/holidays — isOptional: a restricted holiday (a working day; staff may take it as leave). */
export const CreateHolidayRequest = z.object({
  publicId: z.string().uuid().optional(),
  company,
  date: isoDate,
  name: z.string().trim().min(2).max(100),
  isOptional: z.boolean().default(false),
});
export type CreateHolidayRequest = z.infer<typeof CreateHolidayRequest>;

export interface Holiday { publicId: string; company: string; date: string; name: string; isOptional: boolean }

/** GET /api/hrms/weekly-offs?company=&employment= — company defaults and person overrides. */
export const WeeklyOffsQuery = z.object({ company: emptyToUndefined(company), employment: emptyToUndefined(z.string().uuid()) });
export type WeeklyOffsQuery = z.infer<typeof WeeklyOffsQuery>;

/**
 * POST /api/hrms/weekly-offs — a company default (company) or one person's override (employmentPublicId).
 * A rule still open (no validTo) that started earlier is ended the day before validFrom; any other overlap is refused.
 */
export const CreateWeeklyOffRequest = z.object({
  publicId: z.string().uuid().optional(),
  company: company.optional(),
  employmentPublicId: z.string().uuid().optional(),
  validFrom: isoDate,
  validTo: isoDate.optional(),
  rule: WeeklyOffRule,
}).refine((r) => (r.company === undefined) !== (r.employmentPublicId === undefined), { message: 'Give company or employmentPublicId', path: ['company'] })
  .refine((r) => r.validTo === undefined || r.validTo >= r.validFrom, { message: '`validTo` is before `validFrom`', path: ['validTo'] });
export type CreateWeeklyOffRequest = z.infer<typeof CreateWeeklyOffRequest>;

export interface WeeklyOff {
  publicId: string;
  company: string;
  /** null for the company default */
  employment: { publicId: string; employeeCode: string; person: { publicId: string; displayName: string } } | null;
  validFrom: string; validTo: string | null;
  rule: WeeklyOffRule;
}

/** GET /api/hrms/calendar?employment=&from=&to= — at most 366 days. */
export const CalendarQuery = z.object({ employment: z.string().uuid(), from: isoDate, to: isoDate })
  .refine((q) => q.to >= q.from, { message: '`to` is before `from`', path: ['to'] })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 365, { message: 'At most 366 days at a time', path: ['to'] });
export type CalendarQuery = z.infer<typeof CalendarQuery>;

export interface CalendarDay {
  date: string;
  kind: 'working' | 'weekly_off' | 'holiday';
  holiday: string | null;          // name, when kind is holiday
  optionalHoliday: string | null;  // name of a restricted holiday on a working day
}
export interface WorkCalendar { employment: { publicId: string; company: string }; from: string; to: string; days: CalendarDay[] }
