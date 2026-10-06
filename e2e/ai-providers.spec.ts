import { expect, test } from '@playwright/test';

test('settings list every provider with its key state, limit and usage, and test one', async ({ page }) => {
  await page.goto('/settings/ai');
  const card = page.getByRole('main');
  for (const name of ['OpenAI', 'Anthropic', 'Google Gemini', 'Ollama', 'OpenAI-compatible server']) await expect(card.getByText(name, { exact: false }).first()).toBeVisible();
  // Keys are named, never shown or typed.
  await expect(page.getByTestId('provider-openai')).toContainText('OPENAI_API_KEY');
  await expect(page.getByTestId('provider-openai').locator('input[type=password]')).toHaveCount(0);
  // Local servers ask for an address; keyed providers don't.
  await expect(page.getByTestId('provider-ollama').getByLabel('Server address')).toBeVisible();
  await expect(page.getByTestId('provider-openai').getByLabel('Server address')).toHaveCount(0);
  await expect(page.getByTestId('provider-used-openai')).toContainText('Used today');
  // A limit is saved and comes back after a reload.
  await page.getByTestId('provider-openai').getByLabel(/Daily budget/).fill('4');
  await page.getByRole('button', { name: 'Save providers' }).click();
  await expect(page.getByTestId('providers-saved')).toContainText('Providers saved');
  await page.reload();
  await expect(page.getByTestId('provider-openai').getByLabel(/Daily budget/)).toHaveValue('4');
  // A provider without a key explains itself when tested, in plain words.
  await page.getByTestId('test-anthropic').click();
  await expect(page.getByTestId('provider-anthropic').getByRole('status')).toContainText(/API key|Add ANTHROPIC_API_KEY/i, { timeout: 25_000 });
});
