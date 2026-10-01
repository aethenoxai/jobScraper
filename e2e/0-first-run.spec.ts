import { expect, test } from '@playwright/test';

// Runs first (file order): the database is still empty, as after a fresh install.
test('a fresh install opens on the setup steps, which follow what is really saved', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole('heading', { name: 'Get started' })).toBeVisible();
  const steps = page.getByTestId('setup-steps').locator('li');
  await expect(steps).toHaveCount(6);
  await expect(page.locator('[data-step="ai"]')).toHaveAttribute('data-done', 'false');

  await page.getByTestId('setup-next').click();
  await expect(page).toHaveURL(/\/settings\/ai$/);
  await page.getByLabel('Provider').selectOption('none');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('AI settings saved.')).toBeVisible();

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Get started' }).click();
  await expect(page.locator('[data-step="ai"]')).toHaveAttribute('data-done', 'true');
  await expect(page.locator('[data-step="ai"]')).toContainText(/without AI/i);
  // Next comes the CV; there is no profile yet.
  await expect(page.getByTestId('setup-next')).toHaveAttribute('href', '/profiles');
  await expect(page.locator('[data-step="cv"]')).toHaveAttribute('data-done', 'false');
});
