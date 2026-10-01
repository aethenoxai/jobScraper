/**
 * The web UI's HTTP server. Next.js answers some requests before its proxy (src/proxy.ts) runs: dev endpoints such
 * as /__nextjs_*, static files and WebSocket upgrades. So the Host check (DNS-rebinding protection) runs here, in
 * front of everything, and every response forbids framing by other sites (clickjacking).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { hostAllowed } from './access';

export const SECURITY_HEADERS = {
  'X-Frame-Options': 'SAMEORIGIN',
  // Our own pages may frame our own documents (the CV preview); no other site may frame anything.
  'Content-Security-Policy': "frame-ancestors 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
} as const;

export interface NextLikeApp {
  getRequestHandler(): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}

const REFUSED = 'This address is not allowed. Open Job Scraper at http://127.0.0.1 (or add the host to APP_ALLOWED_HOSTS).';

/**
 * `upgrades` is the server object given to Next as `httpServer`: Next attaches its WebSocket handling (dev HMR) to
 * it, and upgrades that pass the Host check are handed to it there. Next never sees the real server's upgrades.
 */
export function createGatedServer(app: NextLikeApp, env: Record<string, string | undefined>, upgrades: Pick<Server, 'emit' | 'listenerCount'>): Server {
  const handle = app.getRequestHandler();
  const server = createServer((req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (!hostAllowed(req.headers.host, env)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end(REFUSED);
      return;
    }
    void handle(req, res);
  });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!hostAllowed(req.headers.host, env)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    // Next registers its listener when it handles its first request; a socket that arrives earlier is simply closed.
    if (!upgrades.listenerCount('upgrade')) socket.destroy();
    else upgrades.emit('upgrade', req, socket, head);
  });
  return server;
}
