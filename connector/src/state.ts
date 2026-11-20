import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TallyResultReport } from '@ageless/shared';

/**
 * What the connector must remember across restarts so it never posts a batch to Tally twice:
 *   posting   written BEFORE the request goes to Tally. If the connector stops here nobody knows whether Tally took it,
 *             so on the next start it reports "in doubt" and never posts it again by itself.
 *   answered  Tally's answer (or the decision to report) is saved until the API has it.
 * The file holds batch ids and Tally's result text only: no secret, no voucher data.
 */
export type BatchPhase = { phase: 'posting'; since: string } | { phase: 'answered'; report: TallyResultReport };
export type StateData = Record<string, BatchPhase>;

export interface StateStore {
  all(): StateData;
  get(batchId: string): BatchPhase | undefined;
  set(batchId: string, value: BatchPhase): void;
  clear(batchId: string): void;
}

export class FileState implements StateStore {
  private data: StateData;

  constructor(private readonly path: string) {
    try { this.data = JSON.parse(readFileSync(path, 'utf8')) as StateData; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('The state file is unreadable; fix or move it (the connector will not guess)');
      this.data = {};
    }
  }

  all(): StateData { return { ...this.data }; }
  get(batchId: string): BatchPhase | undefined { return this.data[batchId]; }
  set(batchId: string, value: BatchPhase): void { this.data[batchId] = value; this.save(); }
  clear(batchId: string): void { delete this.data[batchId]; this.save(); }

  /** Written to a temporary file and renamed, so a crash never leaves half a file. */
  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

export class MemoryState implements StateStore {
  private data: StateData = {};
  all(): StateData { return { ...this.data }; }
  get(batchId: string): BatchPhase | undefined { return this.data[batchId]; }
  set(batchId: string, value: BatchPhase): void { this.data[batchId] = value; }
  clear(batchId: string): void { delete this.data[batchId]; }
}
