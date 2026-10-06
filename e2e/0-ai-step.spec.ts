import { expect, test } from '@playwright/test';

const KEYS = [
  { provider: 'anthropic', envVar: 'ANTHROPIC_API_KEY' },
  { provider: 'openai', envVar: 'OPENAI_API_KEY' },
  { provider: 'google', envVar: 'GOOGLE_GENERATIVE_AI_API_KEY' },
];

// Sorts before 0-first-run (file order), so the install is still fresh. What it saves (every task on a key-less provider) stays in the
// database until 0-first-run submits the same form, which rewrites all eight tasks. It never gets past step 1, so the wizard is still at step 1.
test('the setup wizard sets every AI task, and a task whose provider has no key holds the step', async ({ page }) => {
  await page.goto('/welcome');
  await expect(page.getByTestId('wizard-progress')).toHaveText('Step 1 of 5');
  // The same eight-row table as Settings → AI provider (notes under a row are task-note-*, not rows).
  await expect(page.locator('[data-testid^=task-]:not([data-testid^=task-note])')).toHaveCount(8);
  const keys = page.getByTestId('ai-keys');
  await expect(keys).toContainText('.env');
  // Use a provider whose key is not set on this machine (a developer's .env or shell may define some).
  const text = (await keys.textContent()) ?? '';
  const missing = KEYS.find((k) => text.includes(`missing (${k.envVar})`));
  test.skip(!missing, 'every API key is set on this machine, so no provider is without a key');
  const { provider, envVar } = missing!;
  await page.getByLabel('Provider for all tasks').selectOption(provider);
  await page.getByRole('button', { name: 'Apply to all tasks' }).click();
  await page.getByRole('button', { name: 'Test and continue' }).click();
  // The reason names the key to add, and the step stays.
  await expect(page.getByRole('status').filter({ hasText: envVar })).toBeVisible({ timeout: 25_000 });
  await expect(page.getByTestId('wizard-progress')).toHaveText('Step 1 of 5');
});
