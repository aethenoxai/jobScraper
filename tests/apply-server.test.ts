import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApplyServer } from '../e2e/fixtures/apply-server.mjs';

const server = createApplyServer();
let base = '';
beforeAll(async () => (base = await server.listen(0)));
afterAll(() => server.close());

describe('apply-site fixtures', () => {
  it('serves each flow', async () => {
    for (const path of ['/greenhouse/acme/jobs/123', '/lever/acme/abc', '/lever/acme/abc/apply', '/ashby/acme/xyz/application', '/wizard/job', '/captcha/job', '/otp/job', '/unanswerable/job', '/error/job']) {
      expect((await fetch(base + path)).status, path).toBe(200);
    }
    const wall = await fetch(`${base}/login-wall/job`, { redirect: 'manual' });
    expect(wall.headers.get('location')).toMatch(/signin/);
  });

  it('records submissions with their fields and uploaded file names', async () => {
    const form = new FormData();
    form.set('job_application[email]', 'a@example.com');
    form.set('job_application[resume]', new Blob(['%PDF']), 'Acme_CV.pdf');
    const r = await fetch(`${base}/greenhouse/acme/jobs/123/submit`, { method: 'POST', body: form, redirect: 'manual' });
    expect(r.headers.get('location')).toBe('/greenhouse/acme/jobs/123/confirmation');
    const subs = await (await fetch(`${base}/__submissions`)).json();
    expect(subs.at(-1)).toMatchObject({ path: '/greenhouse/acme/jobs/123/submit' });
    expect(subs.at(-1).fields).toEqual(expect.arrayContaining([{ name: 'job_application[email]', filename: null, value: 'a@example.com' }, expect.objectContaining({ name: 'job_application[resume]', filename: 'Acme_CV.pdf' })]));
    await fetch(`${base}/__reset`);
    expect(await (await fetch(`${base}/__submissions`)).json()).toEqual([]);
  });
});
