import { expect, test } from '@playwright/test';

test('health endpoint reports the running worker', async ({ request }) => {
  await expect
    .poll(async () => (await (await request.get('/api/health')).json()).worker.online, { timeout: 20_000 })
    .toBe(true);
  const body = await (await request.get('/api/health')).json();
  expect(body.ok).toBe(true);
  expect(body.scheduler).toMatchObject({ intervalMinutes: expect.any(Number) });
});

test('user configures, starts, runs and stops job discovery', async ({ page }) => {
  await page.goto('/settings/scheduling');
  await expect(page.getByRole('heading', { name: 'Job discovery' })).toBeVisible();
  await expect(page.getByTestId('scheduler-status')).toHaveText('Paused');

  await page.getByLabel('Frequency').selectOption('60');
  await page.getByRole('button', { name: 'Save frequency' }).click();
  await expect(page.getByTestId('scheduler-interval')).toHaveText('Every 1 hour');

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByTestId('scheduler-status')).toHaveText('Running');

  await page.getByRole('button', { name: 'Run now' }).click();
  await expect(page.getByRole('status')).toContainText(/Scan queued|already queued/);

  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByTestId('scheduler-status')).toHaveText('Paused');
  // The "Scan queued" message belonged to Run now; it doesn't stay after Stop.
  await expect(page.getByRole('status')).toHaveCount(0);

  // Typing minutes is enough: no need to pick "Custom…" first.
  await page.getByLabel('Custom (minutes)').fill('45');
  await page.getByRole('button', { name: 'Save frequency' }).click();
  await expect(page.getByTestId('scheduler-interval')).toHaveText('Every 45 minutes');
});

test('dashboard shows the worker online', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Online')).toBeVisible();
});
