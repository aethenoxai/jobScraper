import { expect, test } from '@playwright/test';

test('the System page shows what ran and what went wrong (PRD §52)', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'System' }).click();
  await expect(page.getByRole('heading', { name: 'System' })).toBeVisible();
  await expect(page.getByTestId('system-overview')).toContainText('Online');
  for (const id of ['system-problems', 'system-discovery', 'system-failures', 'system-emails', 'system-queue', 'system-ai']) await expect(page.getByTestId(id)).toBeVisible();
  // The browser-apply spec skipped a CAPTCHA job earlier in this run.
  await expect(page.getByTestId('system-failures')).toContainText('The site showed a CAPTCHA (CAPTCHA_DETECTED, browser)');
});

test('the System page shows the installed version and how to update', async ({ page }) => {
  await page.goto('/system');
  const version = page.getByTestId('system-version');
  await expect(version).toContainText(/Job Scraper \d+\.\d+\.\d+/);
  await expect(version.getByRole('link', { name: 'See the latest release' })).toHaveAttribute('href', /\/releases\/latest$/);
  await expect(version.getByRole('link', { name: 'How to update' })).toHaveAttribute('href', /\/docs\/INSTALL\.md#updating$/);
});
