import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
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
