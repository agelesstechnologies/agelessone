import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** Where uploaded files live: UPLOAD_DIR if set, else backend/uploads (git-ignored). */
export function uploadRoot(): string {
  return process.env.UPLOAD_DIR ? resolve(process.env.UPLOAD_DIR) : resolve(__dirname, '../../uploads');
}

/**
 * Saves bytes as <folder>/<yyyy>/<mm>/<random uuid>.<ext> under the upload root and returns that relative path,
 * which is what the database stores. The original file name is never used (it may contain anything).
 */
export async function saveUpload(folder: string, ext: string, data: Buffer, now = new Date()): Promise<string> {
  const rel = [folder, String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, '0'), `${randomUUID()}.${ext}`].join('/');
  const abs = join(uploadRoot(), rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, data, { flag: 'wx' });
  return rel;
}

/** Removes a file saved moments ago when the record that would point to it could not be stored. */
export async function discardUpload(rel: string): Promise<void> {
  await rm(join(uploadRoot(), rel), { force: true });
}

export type DocumentType = 'jpg' | 'png' | 'pdf';
export const CONTENT_TYPES: Record<DocumentType, string> = { jpg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf' };

/** A JPEG, PNG or PDF told apart by its first bytes (never by the file name the client sent); null for anything else. */
export function detectDocumentType(bytes: Uint8Array): DocumentType | null {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts(0xff, 0xd8, 0xff)) return 'jpg';
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png';
  if (starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return 'pdf'; // %PDF-
  return null;
}

/** The bytes of a stored upload (path as stored in the database). */
export function readUpload(rel: string): Promise<Buffer> {
  return readFile(join(uploadRoot(), rel));
}
