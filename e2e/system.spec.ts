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
