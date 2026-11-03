import { z } from 'zod';
/** Shared by the API and the web app, so both validate a punch the same way. */
export const PunchRequest = z.object({
  publicId: z.string().uuid(),               // made in the browser (UUIDv7), so a resend is stored once
  employmentPublicId: z.string().uuid(),     // which of your jobs (company) the punch is for
  kind: z.enum(['in', 'out']),
  occurredAt: z.string().datetime({ offset: true }), // device time, ISO with Z or +05:30
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  accuracyM: z.number().int().nonnegative().optional(),
}).refine((p) => (p.latitude === undefined) === (p.longitude === undefined), { message: 'Send latitude and longitude together', path: ['longitude'] });
export type PunchRequest = z.infer<typeof PunchRequest>;
