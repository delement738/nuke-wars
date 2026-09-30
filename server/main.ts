// SERVER — entry point. `npm run server` runs this; so does Railway (`railway.json`).
//
// Settings come from environment variables, set on Railway's Variables tab:
//   PORT             set by the host itself; locally 8787, which is what the
//                    client's development build looks for.
//   ALLOWED_ORIGINS  comma-separated sites whose pages may connect; `*` matches
//                    any run of characters (Vercel's preview links). Unset: any
//                    site — fine locally, never in production.
//   TRUST_PROXY      `1` behind the host's proxy, so per-address limits see the
//                    visitor's address rather than the proxy's.
// See `docs/deploy.md`, Part 2.

import { parseOrigins } from './guard';
import { startServer } from './server';

const port = Number(process.env.PORT ?? 8787);
const allowedOrigins = parseOrigins(process.env.ALLOWED_ORIGINS);
const trustProxy = process.env.TRUST_PROXY === '1';

/** One line per event, stamped with the time, so a log read later still makes sense. */
function log(line: string): void {
  console.log(`${new Date().toISOString()} ${line}`);
}

startServer(port, { log, allowedOrigins, trustProxy }).then((server) => {
  log(
    `Nuke Wars server listening on port ${server.port}; ` +
      (allowedOrigins.length > 0 ? `origins: ${allowedOrigins.join(', ')}` : 'any origin (development)') +
      (trustProxy ? '; behind a proxy' : ''),
  );

  // Railway sends SIGTERM before stopping the old copy during a redeploy. Close
  // cleanly rather than being killed mid-write. Matches live only in this
  // process's memory, so any in progress end here (see `docs/deploy.md`).
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`${signal}: shutting down with ${server.lobby.roomCount()} rooms open`);
    server.close().then(() => process.exit(0));
    // Never hang a redeploy on a connection that will not close.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
});
