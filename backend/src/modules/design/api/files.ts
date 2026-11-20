import { z } from 'zod';
import { ZodValidationPipe } from '../../../platform/http/zod-validation.pipe';

export const PublicIdParam = new ZodValidationPipe(z.string().uuid());
export type Created = { status(code: number): void };
export type FileReply = { setHeader(k: string, v: string): void; send(b: Buffer): void };

/** Sends a stored or generated file as a download (never shown inline; the browser must not guess its type). */
export function sendFile(res: FileReply, f: { name: string; contentType: string; data: Buffer }): void {
  res.setHeader('Content-Type', f.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${f.name.replace(/["\\\r\n]/g, '')}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(f.data);
}

export const SEES = 'The Designing head, Admin users (design.jobs.manage), Design QC, design.view, and the people assigned to the job\'s tickets; for anyone else it does not exist (404).';
export const MANAGES = 'The Designing head (head of the job\'s department) or an Admin user (design.jobs.manage). Audited.';
export const DRAWS = 'People assigned to the job\'s tickets, the Designing head or an Admin user. Audited.';
