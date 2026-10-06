import { expect, test } from '@playwright/test';

test('each task gets its own provider and model; apply to all fills every row', async ({ page }) => {
  await page.goto('/settings/ai');
  await expect(page.getByTestId('ai-state')).toBeVisible();
  // Each account control appears once on the page.
  await expect(page.getByTestId('chatgpt-account')).toHaveCount(1);
  await expect(page.getByTestId('claude-code-status')).toHaveCount(1);
  await expect(page.locator('[data-testid^=task-]')).toHaveCount(8);
  // Apply to all, then change one row.
  await page.getByLabel('Provider for all tasks').selectOption('openai');
  await page.getByLabel('Model for all tasks').selectOption('gpt-5-mini');
  await page.getByRole('button', { name: 'Apply to all tasks' }).click();
  for (const t of ['cv-extract', 'cover-letter']) await expect(page.getByTestId(`task-${t}`).getByLabel(/^Provider for/)).toHaveValue('openai');
  await page.getByTestId('task-cv-extract').getByLabel(/^Provider for/).selectOption('none');
  // An unlisted model can be typed.
  await page.getByTestId('task-cover-letter').getByLabel(/^Model for/).selectOption('__other');
  await page.getByTestId('task-cover-letter').getByLabel(/^Model name for/).fill('my-local-model');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('tasks-saved')).toContainText('saved');
  await page.reload();
  await expect(page.getByTestId('task-cv-extract').getByLabel(/^Provider for/)).toHaveValue('none');
  await expect(page.getByTestId('task-jd-analysis').getByLabel(/^Model for/)).toHaveValue('gpt-5-mini');
  await expect(page.getByTestId('task-cover-letter').getByLabel(/^Model name for/)).toHaveValue('my-local-model');
  // Put it back offline for the specs that follow.
  await page.getByLabel('Provider for all tasks').selectOption('none');
  await page.getByRole('button', { name: 'Apply to all tasks' }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('tasks-saved')).toContainText('saved');
});
