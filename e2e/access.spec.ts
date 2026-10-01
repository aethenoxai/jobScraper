import { expect, test } from '@playwright/test';

test('only this computer’s addresses are served (DNS rebinding protection)', async ({ request, baseURL }) => {
  expect((await request.get('/api/health')).status()).toBe(200);
  const port = new URL(baseURL!).port;
  expect((await request.get(`http://localhost:${port}/api/health`)).status()).toBe(200);
  const evil = await request.get('/api/health', { headers: { host: `attacker.example:${port}` } });
  expect(evil.status()).toBe(403);
  const page = await request.get('/feed', { headers: { host: `attacker.example:${port}` } });
  expect(page.status()).toBe(403);
});
