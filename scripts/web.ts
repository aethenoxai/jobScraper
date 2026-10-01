/**
 * Starts the Next.js web UI with HOST/PORT from .env. Usage: tsx scripts/web.ts dev|start
 * Next runs behind our own HTTP server, which refuses any request or WebSocket upgrade for a host name other than
 * this computer's before Next sees it (Next answers its dev endpoints before src/proxy.ts runs).
 */
import { createServer } from 'node:http';
import { loadConfig } from '../src/server/config';
import { loadEnvFiles, runMode } from '../src/server/config/env-files';
import { requirePasswordForHost } from '../src/server/access';
import { createGatedServer } from '../src/server/web-server';

// Next.js would otherwise send usage telemetry to Vercel; Job Scraper sends nothing it doesn't list in PRIVACY.md.
process.env.NEXT_TELEMETRY_DISABLED ??= '1';
const mode = process.argv[2] === 'start' ? 'start' : 'dev';
// The files Next reads too (.env.local, .env.production, …), so HOST, PORT and the password check agree with it.
loadEnvFiles(runMode(mode === 'dev'));
(process.env as Record<string, string>).NODE_ENV ??= mode === 'start' ? 'production' : 'development';
let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (err) {
  // A mistake in .env: say what it is, without a stack trace.
  console.error(`✗ ${(err as Error).message}`);
  process.exit(1);
}
const refusal = requirePasswordForHost(config.host, process.env);
if (refusal) {
  console.error(`✗ ${refusal}`);
  process.exit(1);
}

async function main() {
  const { default: next } = await import('next');
  // Next attaches its WebSocket handling (dev HMR) to `httpServer`. It gets a server object that never listens;
  // the real server hands it only the upgrades that pass the Host check.
  const upgrades = createServer();
  const app = next({ dev: mode === 'dev', hostname: config.host, port: config.port, httpServer: upgrades });
  await app.prepare();
  const server = createGatedServer(app, process.env, upgrades);
  server.listen(config.port, config.host, () => console.log(`▲ Job Scraper web UI on http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${config.port} (${mode})`));
  // Open keep-alive and HMR connections would keep close() waiting forever: end them, and don't wait long.
  const stop = () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
