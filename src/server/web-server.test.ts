import { EventEmitter } from 'node:events';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createGatedServer, SECURITY_HEADERS } from './web-server';

let server: ReturnType<typeof createGatedServer> | null = null;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

/** A stand-in for the Next.js app: records what reached it. Like Next, it handles upgrades on its `httpServer`. */
function fakeApp() {
  const seen: string[] = [];
  const upgrades: string[] = [];
  const httpServer = new EventEmitter();
  httpServer.on('upgrade', (req: { url?: string }, socket: { end: (s: string) => void }) => {
    upgrades.push(req.url ?? '');
    socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  });
  return {
    seen,
    upgrades,
    httpServer,
    app: {
      getRequestHandler: () => async (req: { url?: string }, res: { end: (s: string) => void }) => {
        seen.push(req.url ?? '');
        res.end('next');
      },
    },
  };
}

async function listen(f: ReturnType<typeof fakeApp>, env: Record<string, string | undefined> = {}) {
  server = createGatedServer(f.app as never, env, f.httpServer as never);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  return (server.address() as AddressInfo).port;
}

/** A raw HTTP request, so the Host header can be anything (as a DNS-rebinding page would send). */
function raw(port: number, lines: string[]): Promise<string> {
  return new Promise((resolve) => {
    const s = connect(port, '127.0.0.1', () => s.write(`${lines.join('\r\n')}\r\n\r\n`));
    let out = '';
    s.on('data', (d) => (out += d));
    s.on('close', () => resolve(out));
    s.on('error', () => resolve(out));
    setTimeout(() => s.destroy(), 1500);
  });
}

describe('the web server gate (before Next.js sees anything)', () => {
  it('refuses requests for another host name, including Next.js dev endpoints, and serves this computer', async () => {
    const f = fakeApp();
    const port = await listen(f);
    const evil = await raw(port, ['GET /__nextjs_attach-nodejs-inspector HTTP/1.1', 'Host: evil.example:3000', 'Connection: close']);
    expect(evil).toMatch(/^HTTP\/1\.1 403/);
    expect(f.seen).toEqual([]);
    const ok = await raw(port, ['GET /feed HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Connection: close']);
    expect(ok).toMatch(/^HTTP\/1\.1 200/);
    expect(f.seen).toEqual(['/feed']);
  });

  it('refuses WebSocket upgrades for another host name, and passes this computer’s on', async () => {
    const f = fakeApp();
    const port = await listen(f);
    const upgrade = (host: string) => raw(port, ['GET /_next/hmr HTTP/1.1', `Host: ${host}`, 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13']);
    expect(await upgrade('evil.example')).not.toMatch(/101/);
    expect(f.upgrades).toEqual([]);
    expect(await upgrade(`localhost:${port}`)).toMatch(/101/);
    expect(f.upgrades).toEqual(['/_next/hmr']);
  });

  it('allows extra host names from APP_ALLOWED_HOSTS', async () => {
    const f = fakeApp();
    const port = await listen(f, { APP_ALLOWED_HOSTS: 'jobs.home.lan' });
    expect(await raw(port, ['GET / HTTP/1.1', 'Host: jobs.home.lan', 'Connection: close'])).toMatch(/^HTTP\/1\.1 200/);
  });

  it('every response forbids framing by other sites and content sniffing', async () => {
    const f = fakeApp();
    const port = await listen(f);
    const res = await raw(port, ['GET / HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Connection: close']);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(res.toLowerCase()).toContain(`${k.toLowerCase()}: ${v.toLowerCase()}`);
    expect(SECURITY_HEADERS['Content-Security-Policy']).toBe("frame-ancestors 'self'");
  });
});
