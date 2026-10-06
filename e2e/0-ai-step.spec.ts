import { expect, test } from '@playwright/test';

// Runs before 0-first-run (file order): the install is still fresh. It changes nothing that spec relies on except the saved routes.
test('the setup wizard sets every AI task, and a task whose provider has no key holds the step', async ({ page }) => {
  await page.goto('/welcome');
  await expect(page.getByTestId('wizard-progress')).toHaveText('Step 1 of 5');
  // The same eight-row table as Settings → AI provider.
  await expect(page.locator('[data-testid^=task-]:not([data-testid^=task-note])')).toHaveCount(8);
  await expect(page.getByTestId('ai-keys')).toContainText('.env');
  // A provider with no key can't be continued with: the reason is shown and the step stays.
  await page.getByLabel('Provider for all tasks').selectOption('anthropic');
  await page.getByRole('button', { name: 'Apply to all tasks' }).click();
  await page.getByRole('button', { name: 'Test and continue' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'ANTHROPIC_API_KEY' })).toBeVisible({ timeout: 25_000 });
  await expect(page.getByTestId('wizard-progress')).toHaveText('Step 1 of 5');
});
