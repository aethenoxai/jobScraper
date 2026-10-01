// Serves the static fixture pages used by the E2E suite (job pages with JSON-LD), and runs a local SMTP server
// (STARTTLS with smtp-server's self-signed localhost certificate) that keeps every message for /__mail.
import { createServer } from 'node:http';
import { SMTPServer } from 'smtp-server';
import { createApplyServer } from './apply-server.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('e2e/fixtures/site');
const port = Number(process.env.FIXTURE_PORT ?? 3199);
// Job application site replicas for browser-apply tests.
await createApplyServer().listen(Number(process.env.FIXTURE_APPLY_PORT ?? 3197));

const mails = [];
new SMTPServer({
  authMethods: ['PLAIN', 'LOGIN'],
  onAuth: (auth, _session, cb) => (auth.password === 'e2e-pass' ? cb(null, { user: auth.username }) : cb(new Error('Invalid login'))),
  onData(stream, session, cb) {
    let raw = '';
    stream.on('data', (c) => (raw += c));
    stream.on('end', () => {
      mails.push({ from: session.envelope.mailFrom && session.envelope.mailFrom.address, to: session.envelope.rcptTo.map((r) => r.address), secure: session.secure, raw });
      cb(null, 'OK: queued');
    });
  },
}).listen(Number(process.env.FIXTURE_SMTP_PORT ?? 3198), '127.0.0.1');

/**
 * A stand-in OpenAI-compatible model for the setup wizard's connection test: it answers the health check and
 * refuses everything else, so CV reading and matching fall back to the offline rules the rest of the suite expects.
 */
async function fakeModel(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body || '{}');
  const healthCheck = JSON.stringify(request.messages ?? []).includes('health check');
  if (!healthCheck) return res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'The fixture model only answers health checks.' } }));
  res.writeHead(200, { 'content-type': 'application/json' }).end(
    JSON.stringify({
      id: 'chatcmpl-fixture',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: request.model,
      choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
    }),
  );
}

createServer(async (req, res) => {
  if (req.url === '/__mail') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(mails));
  if (req.method === 'POST' && req.url === '/v1/chat/completions') return fakeModel(req, res);
  const file = path.join(root, path.normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, ''));
  if (!file.startsWith(root)) return res.writeHead(403).end();
  try {
    const body = await readFile(file.endsWith('/') ? `${file}index.html` : file);
    res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : 'text/plain' }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, '127.0.0.1');
