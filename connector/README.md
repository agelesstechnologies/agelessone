# Tally connector

A small program that runs as a Windows service **on the Tally server PC**. It posts the batches the Accounts checker has approved
into Tally and tells the Ageless API what Tally answered. It is our own code (CLAUDE.md rule 8), with no runtime packages except
`@ageless/shared`.

```
Ageless API  <--- HTTPS, outbound only ---  connector  --- http://localhost:9000 --->  Tally (same PC)
```

- **Opens no port.** It only makes outbound calls: to the API over HTTPS, and to Tally on this PC.
- **Signs in with a machine credential** (`POST /api/auth/machine-token`): a client id and a secret bound to one tenant and to one
  permission, `accounts.tally.connector`. Its 15-minute token opens only `GET /api/accounts/tally/outbox`, `POST .../results` and
  `POST .../mapping-report`. It cannot approve, build, read people or anything else.
- **No secrets in logs.** The secret lives in a file only the service account can read. Every log line passes a redactor, and the
  program logs ids and counts only (never voucher XML or amounts).

## What each run does (every minute by default)
1. Finishes what an earlier run left: a result the API had not received yet is sent; a batch the connector was *in the middle of
   posting* when it stopped is reported **in doubt** (nobody knows if Tally took it) and is never posted again by the connector.
2. Reads the outbox: approved batches, not imported, not on hold.
3. For each Tally company, asks Tally for its ledger and cost centre names and reports every name the books expect that Tally
   does not have **exactly** (spelling, capitals and spaces count) to `POST /mapping-report`. A batch that uses a missing ledger is
   not posted (it would only fail inside Tally); the API is told why.
4. Posts each remaining batch to Tally **once**, parses `CREATED`, `ALTERED`, `ERRORS`, `LASTVCHID` and every `LINEERROR`, and
   reports to `POST /results`. An error that names an entry's REMOTEID returns that entry to the queue with Tally's text. A result
   that does not say which entries failed puts the batch **on hold** for a person (nothing is guessed).

How a batch can end: `completed` (Tally answered), `not_posted` (nothing reached Tally: not running, company not open, a name
missing; it is tried again), `in_doubt` (the request may have reached Tally, no usable answer; held for a person).

## Settings (environment variables of the service)
| Variable | Meaning |
| --- | --- |
| `ATPL_API_URL` | The API, e.g. `https://api.example.com/api`. Must be `https://` (`http://localhost` is allowed for development). |
| `CONNECTOR_CLIENT_ID` | The credential's client id (`mc_...`). |
| `CONNECTOR_SECRET_FILE` | Path of a file holding the secret (`mcs_...`) and nothing else. |
| `TALLY_URL` | Default `http://localhost:9000`. Must be a local address. |
| `POLL_SECONDS` | Default 60 (at least 10). After failures it waits longer, up to 10 minutes. |
| `TALLY_TIMEOUT_SECONDS` | Default 120. No answer within this time makes the batch *in doubt*. |
| `STATE_FILE` | Default `connector-state.json`. Holds batch ids and Tally result text only. Keep it between restarts. |

## Set up
1. **Tally:** the company must be open, and Tally's XML/HTTP server must be on (port 9000). Voucher types `Platform Journal` and
   `Platform Payment` must exist in the company, and the ledgers must exist with the exact names approved in Ageless
   (Accounts, Ledger mapping). The first run reports any that do not match.
2. **Credential:** an admin makes it once: `POST /api/core/machine-credentials {"name":"Tally server PC"}`. The secret is in that
   answer **only**. Save it to a file on the Tally PC, e.g. `C:\ProgramData\AgelessTallyConnector\secret.txt`. Revoke it with
   `POST /api/core/machine-credentials/:publicId/revoke` (it stops working at once).
3. **Build and copy** (on a developer PC, from the repository root):
   ```
   pnpm install
   pnpm --filter @ageless/connector build
   pnpm --filter @ageless/connector --prod deploy C:\build\ageless-connector
   ```
   Copy that folder to the Tally PC (for example `C:\ageless-connector`). Node.js 22 must be installed there.
4. **Install the service** (elevated PowerShell on the Tally PC; needs [NSSM](https://nssm.cc), a free service wrapper, because
   Node cannot register itself as a service):
   ```
   cd C:\ageless-connector
   .\scripts\install-service.ps1 -ApiUrl https://api.example.com/api -ClientId mc_xxxx -SecretFile C:\ProgramData\AgelessTallyConnector\secret.txt
   nssm start AgelessTallyConnector
   ```
   The script runs the service as `LocalService`, limits the data folder and the secret file to it and administrators, keeps a
   rotating log in `C:\ProgramData\AgelessTallyConnector\connector.log`, and restarts the program 30 seconds after a crash.
5. **Check:** the log says `Tally connector started`. In Ageless, Accounts → Tally sync shows batches as *imported by the Tally
   connector*, or *on hold* with the reason.

## When a batch is on hold
The connector will not post it again by itself. Open Tally and look for the vouchers (their REMOTEID is the journal entry's id),
then in Accounts → Tally sync open the batch and use **Upload Tally result** or **Mark imported** (tick the entries that
failed), or **Cancel batch** to return its entries to the queue.

## Develop
```
pnpm --filter @ageless/connector typecheck
pnpm --filter @ageless/connector test      # fake Tally and fake API; needs no database
```
