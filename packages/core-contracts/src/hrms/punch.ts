import { z } from 'zod';
/** Shared by the API and the mobile app, so both validate a punch the same way. */
export const PunchRequest = z.object({
  publicId: z.string().uuid(),               // made on the phone (UUIDv7)
  kind: z.enum(['in', 'out']),
  occurredAt: z.string().datetime(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  accuracyM: z.number().int().nonnegative().optional(),
});
export type PunchRequest = z.infer<typeof PunchRequest>;
