import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpTally, TallyUnavailable, decodeTally, namesRequest } from './tally';

let server: Server | undefined;
const sockets = new Set<import('node:net').Socket>();
/** A fake Tally on a free local port. */
async function fakeTally(handler: (req: IncomingMessage, body: string, res: ServerResponse) => void): Promise<string> {
  server = createServer((req, res) => { let body = ''; req.setEncoding('utf8'); req.on('data', (c) => (body += c)); req.on('end', () => handler(req, body, res)); });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => { for (const s of sockets) s.destroy(); await new Promise<void>((r) => (server ? server.close(() => r()) : r())); server = undefined; });

const utf16 = (s: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]);

describe('posting an import to Tally', () => {
  it('sends the XML as given and returns Tally\'s answer (UTF-8 or UTF-16)', async () => {
    let seen = '';
    const url = await fakeTally((req, body, res) => { seen = `${req.method} ${req.headers['content-type']} ${body}`; res.end('<RESPONSE><CREATED>1</CREATED></RESPONSE>'); });
    const out = await new HttpTally(url, 5000).postImport('<ENVELOPE>₹ ok</ENVELOPE>');
    expect(out).toEqual({ kind: 'answer', text: '<RESPONSE><CREATED>1</CREATED></RESPONSE>' });
    expect(seen).toBe('POST text/xml; charset=utf-8 <ENVELOPE>₹ ok</ENVELOPE>');

    await server!.close();
    sockets.forEach((s) => s.destroy());
    const url2 = await fakeTally((_r, _b, res) => res.end(utf16('<RESPONSE><CREATED>2</CREATED></RESPONSE>')));
    expect(await new HttpTally(url2, 5000).postImport('<E/>')).toEqual({ kind: 'answer', text: '<RESPONSE><CREATED>2</CREATED></RESPONSE>' });
  });

  it('nothing listening: unreachable (safe to try again)', async () => {
    const url = await fakeTally((_r, _b, res) => res.end('x'));
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    const out = await new HttpTally(url, 2000).postImport('<E/>');
    expect(out.kind).toBe('unreachable');
    expect((out as { message: string }).message).toMatch(/not listening/);
  });

  it('a connection that breaks after the request was sent is in doubt, never "unreachable"', async () => {
    const url = await fakeTally((req) => { req.socket.destroy(); });
    const out = await new HttpTally(url, 2000).postImport('<E/>');
    expect(out.kind).toBe('in_doubt');
  });

  it('no answer within the time limit is in doubt', async () => {
    const url = await fakeTally(() => { /* never answers */ });
    const out = await new HttpTally(url, 300).postImport('<E/>');
    expect(out).toEqual({ kind: 'in_doubt', message: 'No answer from Tally after 0 seconds' });
  });

  it('an HTTP error status is in doubt (Tally may have acted)', async () => {
    const url = await fakeTally((_r, _b, res) => { res.statusCode = 500; res.end('oops'); });
    expect((await new HttpTally(url, 2000).postImport('<E/>')).kind).toBe('in_doubt');
  });
});

describe('asking Tally for names', () => {
  const ledgerReply = '<ENVELOPE><BODY><DATA><COLLECTION><LEDGER NAME="Fuel &amp; Oil" RESERVEDNAME=""><NAME.LIST><NAME>Fuel &amp; Oil</NAME></NAME.LIST></LEDGER><LEDGER NAME="HDFC Current"/></COLLECTION></DATA></BODY></ENVELOPE>';

  it('returns the exact names (decoded) and asks for the right company and collection', async () => {
    let asked = '';
    const url = await fakeTally((_r, body, res) => { asked = body; res.end(ledgerReply); });
    expect(await new HttpTally(url, 5000).names('A & B "Co"', 'ledger')).toEqual(['Fuel & Oil', 'HDFC Current']);
    expect(asked).toBe(namesRequest('A & B "Co"', 'ledger'));
    expect(asked).toContain('<SVCURRENTCOMPANY>A &amp; B &quot;Co&quot;</SVCURRENTCOMPANY>');
    expect(asked).toContain('<TYPE>Ledger</TYPE>');
    expect(namesRequest('X', 'costcentre')).toContain('<TYPE>Cost Centre</TYPE>');
  });

  it('cost centres may be none; no ledgers at all means the company is not open; an unreachable Tally is "unavailable"', async () => {
    const url = await fakeTally((_r, body, res) => res.end(body.includes('Cost Centre') ? '<ENVELOPE><BODY><DATA><COLLECTION/></DATA></BODY></ENVELOPE>' : '<RESPONSE>Unknown Request</RESPONSE>'));
    const tally = new HttpTally(url, 2000);
    expect(await tally.names('Co', 'costcentre')).toEqual([]);
    await expect(tally.names('Co', 'ledger')).rejects.toThrow(/listed no ledgers/);
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    await expect(tally.names('Co', 'ledger')).rejects.toBeInstanceOf(TallyUnavailable);
  });
});

describe('decoding', () => {
  it('handles UTF-8, UTF-8 with a byte order mark, and UTF-16 with and without one', () => {
    expect(decodeTally(Buffer.from('<A>₹</A>', 'utf8'))).toBe('<A>₹</A>');
    expect(decodeTally(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<A/>')]))).toBe('<A/>');
    expect(decodeTally(utf16('<A>x</A>'))).toBe('<A>x</A>');
    expect(decodeTally(Buffer.from('<A>x</A>', 'utf16le'))).toBe('<A>x</A>');
  });
});
