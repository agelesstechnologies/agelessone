import type { PersonRef } from '@ageless/shared';
import { violatedConstraint } from '../../../platform/db/db.module';

/** A create that lost the race to the same create sent twice at once (the public id is already stored). */
export const isResentCreate = (err: unknown): boolean => violatedConstraint(err)?.endsWith('_public_id_unique') ?? false;

export const personRef = (publicId: string, displayName: string): PersonRef => ({ publicId, displayName });
export const maybePersonRef = (publicId: string | null, displayName: string | null): PersonRef | null =>
  (publicId === null ? null : { publicId, displayName: displayName ?? '' });
