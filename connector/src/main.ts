import { BackendClient, ApiError } from './api';
import { ConfigError, loadConfig } from './config';
import { Redactor, createLogger, errorText } from './log';
import { runOnce } from './run';
import { FileState } from './state';
import { HttpTally } from './tally';

/**
 * The Tally connector. Runs as a Windows service on the Tally server PC. It only calls out: to the Ageless API over HTTPS and to
 * Tally on this PC. It opens no port and has no way to be reached from outside.
 */
async function main(): Promise<void> {
  const redactor = new Redactor();
  const log = createLogger(redactor);
  let config;
  try { config = loadConfig(); }
  catch (e) {
    log.error(e instanceof ConfigError ? `Configuration problem: ${e.message}` : 'Configuration problem');
    process.exit(2);
  }
  redactor.add(config.secret);
  const deps = { backend: new BackendClient(config, redactor), tally: new HttpTally(config.tallyUrl, config.tallyTimeoutSeconds * 1000), state: new FileState(config.stateFile), log, memory: new Map() };

  let stopping = false;
  let wake: (() => void) | null = null;
  const stop = () => { stopping = true; wake?.(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const sleep = (ms: number) => new Promise<void>((resolve) => { const t = setTimeout(resolve, ms); wake = () => { clearTimeout(t); resolve(); }; });

  log.info('Tally connector started', { api: new URL(config.apiUrl).host, pollSeconds: config.pollSeconds });
  let failures = 0;
  while (!stopping) {
    try {
      const s = await runOnce(deps);
      if (s.posted || s.completed || s.held || s.notPosted || s.recovered || s.mismatches) log.info('Run finished', { ...s });
      failures = 0;
    } catch (e) {
      failures++;
      const status = e instanceof ApiError ? e.status : null;
      log.error('Run failed', { message: errorText(e), status, failures });
    }
    // after a failure wait longer each time (up to 10 minutes) so a down API or a locked credential is not hammered
    await sleep(Math.min(config.pollSeconds * 1000 * 2 ** Math.min(failures, 5), 10 * 60_000));
  }
  log.info('Tally connector stopped');
}

void main();
