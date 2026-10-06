import { expect, test } from '@playwright/test';

test('each task gets its own provider and model; apply to all fills every row', async ({ page }) => {
  await page.goto('/settings/ai');
  await expect(page.getByTestId('ai-state')).toBeVisible();
  // Each account control appears once on the page.
  await expect(page.getByTestId('chatgpt-account')).toHaveCount(1);
  await expect(page.getByTestId('claude-code-status')).toHaveCount(1);
  const rows = page.locator('[data-testid^=task-]:not([data-testid^=task-note])');
  await expect(rows).toHaveCount(8);
  // Remember what the earlier specs set up (setup chose the fixture model) and put it back at the end.
  const before = await rows.evaluateAll((els) =>
    els.map((el) => ({
      id: el.getAttribute('data-testid')!,
      provider: (el.querySelector('select[name$=".provider"]') as HTMLSelectElement).value,
      model: (el.querySelector('input[type=hidden][name$=".model"], input[name$=".model"]') as HTMLInputElement | null)?.value ?? '',
    })),
  );
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
  // Put every row back as the earlier specs left it.
  for (const r of before) {
    const row = page.getByTestId(r.id);
    await row.getByLabel(/^Provider for/).selectOption(r.provider);
    if (r.provider === 'none') continue;
    const list = row.getByLabel(/^Model for/);
    if (await list.locator(`option[value="${r.model}"]`).count()) await list.selectOption(r.model);
    else if (!(await list.count())) await row.getByLabel(/^Model name for/).fill(r.model); // a server with no model list
    else {
      await list.selectOption('__other');
      await row.getByLabel(/^Model name for/).fill(r.model);
    }
  }
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('tasks-saved')).toContainText('saved');
  await page.reload();
  for (const r of before) await expect(page.getByTestId(r.id).getByLabel(/^Provider for/)).toHaveValue(r.provider);
});
