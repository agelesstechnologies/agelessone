import { request } from 'node:http';
import { parseTallyNames } from '@ageless/shared';

/**
 * Talking to Tally on this PC (HTTP, XML). Every way an import can end is one of three, because what to do next differs:
 *   answer       Tally replied; its text says what it did.
 *   unreachable  Nothing was sent (connection refused / host not found). Safe to try again later.
 *   in_doubt     The request may have reached Tally but no usable answer came (timeout, reset, error status). Never retried by the connector.
 */
export type PostOutcome = { kind: 'answer'; text: string } | { kind: 'unreachable'; message: string } | { kind: 'in_doubt'; message: string };

/** Tally could not give the names (not running, company not open). */
export class TallyUnavailable extends Error {}

export interface TallyPort {
  postImport(xml: string): Promise<PostOutcome>;
  /** The exact ledger or cost centre names of a company in Tally. Throws TallyUnavailable. */
  names(company: string, kind: 'ledger' | 'costcentre'): Promise<string[]>;
}

class Exchange extends Error {
  constructor(message: string, readonly connected: boolean) { super(message); }
}

/** Tally answers in UTF-8 or UTF-16 (little endian, with or without a byte order mark). */
export function decodeTally(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 4 && buf[1] === 0 && buf[3] === 0) return buf.toString('utf16le');
  return buf.toString('utf8').replace(/^﻿/, '');
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** The request that asks Tally for every name of one kind in a company. */
export function namesRequest(company: string, kind: 'ledger' | 'costcentre'): string {
  const type = kind === 'ledger' ? 'Ledger' : 'Cost Centre';
  return '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>AgelessNames</ID></HEADER><BODY><DESC>'
    + `<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>`
    + `<TDL><TDLMESSAGE><COLLECTION NAME="AgelessNames" ISMODIFY="No"><TYPE>${type}</TYPE><FETCH>Name</FETCH></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

export class HttpTally implements TallyPort {
  constructor(private readonly url: string, private readonly timeoutMs: number) {}

  private exchange(xml: string): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      let connected = false;
      const body = Buffer.from(xml, 'utf8');
      const req = request(this.url, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8', 'Content-Length': body.length } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: decodeTally(Buffer.concat(chunks)) }));
        res.on('error', () => reject(new Exchange('The connection to Tally broke while it was answering', true)));
      });
      req.on('socket', (s) => { s.once('connect', () => { connected = true; }); if (!s.connecting) connected = true; });
      req.setTimeout(this.timeoutMs, () => req.destroy(new Error('timeout')));
      req.on('error', (e: NodeJS.ErrnoException) => {
        const timedOut = e.message === 'timeout';
        reject(new Exchange(timedOut ? `No answer from Tally after ${Math.round(this.timeoutMs / 1000)} seconds` : connected ? 'The connection to Tally broke' : e.code === 'ECONNREFUSED' ? 'Tally is not listening on that port (is Tally running with its XML server on?)' : 'Tally could not be reached', connected));
      });
      req.end(body);
    });
  }

  async postImport(xml: string): Promise<PostOutcome> {
    try {
      const { status, text } = await this.exchange(xml);
      if (status < 200 || status >= 300) return { kind: 'in_doubt', message: `Tally answered HTTP ${status}` };
      return { kind: 'answer', text };
    } catch (e) {
      const x = e as Exchange;
      return x.connected ? { kind: 'in_doubt', message: x.message } : { kind: 'unreachable', message: x.message };
    }
  }

  async names(company: string, kind: 'ledger' | 'costcentre'): Promise<string[]> {
    let text: string;
    try {
      const res = await this.exchange(namesRequest(company, kind));
      if (res.status < 200 || res.status >= 300) throw new Exchange(`Tally answered HTTP ${res.status}`, true);
      text = res.text;
    } catch (e) { throw new TallyUnavailable((e as Error).message); }
    const names = parseTallyNames(text, kind === 'ledger' ? 'LEDGER' : 'COSTCENTRE');
    // Every company has built-in ledgers, so an empty list means Tally did not give us this company (not open, or a different name).
    if (kind === 'ledger' && !names.length) throw new TallyUnavailable(`Tally listed no ledgers for the company "${company}" (is it open in Tally, with exactly that name?)`);
    return names;
  }
}
