// Stands in for python/scrapling_helper.py in the client's tests: same protocol, behaviour chosen by the URL.
// FAKE_MODE=fatal sends a fatal event; FAKE_MODE=silent never says ready. Received lines are appended to FAKE_LOG.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const note = (line) => process.env.FAKE_LOG && appendFileSync(process.env.FAKE_LOG, `${line}\n`);
note(`start ${process.pid}`);

if (process.env.FAKE_MODE === 'fatal') {
  send({ event: 'fatal', error: { code: 'NOT_INSTALLED', message: 'Scrapling could not be loaded' } });
  process.exit(3);
}
if (process.env.FAKE_MODE !== 'silent') send({ event: 'ready', scrapling: '0.4.15', python: '3.12.7' });
process.stderr.write('helper says hello on stderr\n');

const timers = new Map();
createInterface({ input: process.stdin }).on('line', (line) => {
  note(line);
  const msg = JSON.parse(line);
  if (msg.method === 'cancel') {
    clearTimeout(timers.get(msg.params.target));
    return;
  }
  const url = msg.params.url;
  if (url.includes('crash')) process.exit(1);
  if (url.includes('slow')) {
    timers.set(msg.id, setTimeout(() => send({ id: msg.id, ok: true, result: { status: 200, finalUrl: url, html: 'late' } }), 60_000));
    return;
  }
  if (url.includes('blocked')) return send({ id: msg.id, ok: false, error: { code: 'BLOCKED', message: 'bot check' } });
  if (url.includes('weird')) return send({ id: msg.id, ok: false, error: { code: 'SOMETHING_NEW', message: 'odd' } });
  const delay = Number(new URL(url).searchParams.get('delay') ?? 0);
  setTimeout(() => send({ id: msg.id, ok: true, result: { status: 200, finalUrl: url, html: `<p>${url}</p>` } }), delay);
});
process.stdin.on('end', () => {
  note('eof');
  // FAKE_EXIT_DELAY: a helper that takes a while to shut its browser down.
  setTimeout(() => process.exit(0), Number(process.env.FAKE_EXIT_DELAY ?? 0));
});
