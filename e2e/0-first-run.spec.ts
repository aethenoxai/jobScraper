import { expect, test } from '@playwright/test';

// Runs first (file order): the database is still empty, as after a fresh install.
test('a fresh install shows only the setup wizard, one step at a time, until the job search is started', async ({ page }) => {
  test.setTimeout(120_000);
  const step = page.getByTestId('wizard-progress');

  // Every page leads to setup; nothing else opens yet.
  for (const url of ['/', '/feed', '/jobs', '/settings/scheduling', '/setup']) {
    await page.goto(url);
    await expect(page).toHaveURL(/\/welcome$/);
  }
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
  await expect(step).toHaveText('Step 1 of 5');

  // The plan sign-ins: ChatGPT goes to OpenAI's page (not followed here); Claude Code says whether it is ready.
  await page.getByLabel(/ChatGPT \(sign in with your plan\)/).check();
  await expect(page.getByTestId('chatgpt-panel').getByRole('link', { name: 'Sign in with ChatGPT' })).toHaveAttribute('href', '/api/oauth/chatgpt/start');
  await expect(page.getByRole('button', { name: 'Test and continue' })).toBeDisabled();
  const start = await page.request.get('/api/oauth/chatgpt/start', { maxRedirects: 0 });
  expect(start.status()).toBe(302);
  expect(new URL(start.headers().location).searchParams.get('redirect_uri')).toBe('http://127.0.0.1:3100/callback');
  expect(start.headers().location).toMatch(/^https:\/\/auth\.openai\.com\/api\/accounts\/authorize\?/);
  await page.getByLabel(/Claude \(through your Claude Code\)/).check();
  await expect(page.getByTestId('claude-code-panel')).toContainText(/Claude Code/);

  // 1. AI model: a key-less local server (the fixture), tested before going on.
  await page.getByLabel(/OpenAI-compatible server/).check();
  await page.getByLabel('Server address').fill('http://127.0.0.1:3199/v1');
  await page.getByLabel('Model for CVs and cover letters').fill('fixture-model');
  await page.getByLabel('Model for reading and matching jobs').fill('fixture-model');
  await page.getByRole('button', { name: 'Test and continue' }).click();
  await expect(step).toHaveText('Step 2 of 5');

  // 2. CV: uploaded, then read in the background while the page waits.
  await page.getByLabel(/Your CV/).setInputFiles('tests/fixtures/cvs/files/software-engineer-india.pdf');
  await page.getByRole('button', { name: 'Upload and read' }).click();
  await expect(step).toHaveText('Step 3 of 5', { timeout: 45_000 });

  // 3. Profile: what was read, to check. (The fixture model only answers health checks: read offline, and said so.)
  await expect(page.getByText(/read with simple rules/)).toBeVisible();
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(step).toHaveText('Step 4 of 5');

  // 4. Jobs wanted: nothing goes on without the required answers.
  await page.getByTestId('pref-salary').fill('');
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page.getByRole('alert').filter({ hasText: /expected salary/i })).toBeVisible();
  await page.getByLabel('Job titles you want *').fill('Backend Engineer');
  await page.getByLabel('Job titles you want *').press('Enter');
  await page.getByTestId('pref-country').selectOption('IN');
  await page.getByLabel('State or region (optional)').fill('Karnataka');
  await page.getByLabel('State or region (optional)').press('Enter');
  await page.getByTestId('pref-salary').fill('2400000');
  await expect(page.getByTestId('pref-currency')).toHaveValue('INR');
  await page.getByTestId('pref-negotiable').check();
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(step).toHaveText('Step 5 of 5');

  // 5. Start: a summary, then the dashboard.
  const dialog = page.getByRole('dialog', { name: 'Start your job search' });
  await expect(dialog.getByTestId('start-summary')).toContainText('Backend Engineer');
  await expect(dialog.getByTestId('start-summary')).toContainText('Karnataka, India');
  await expect(dialog.getByTestId('start-summary')).toContainText('2,400,000 INR per year (negotiable)');
  await dialog.getByRole('button', { name: 'Start job search' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();

  // Setup stays done; the wizard sends the user back to the app.
  await page.goto('/welcome');
  await expect(page).toHaveURL(/\/$/);
  await page.goto('/settings/scheduling');
  await expect(page.getByTestId('scheduler-status')).toHaveText('Running');

  // The rest of the suite runs offline with discovery paused, as it was written for.
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByTestId('scheduler-status')).toHaveText('Paused');
  await page.goto('/settings/ai');
  await page.getByLabel('Provider').selectOption('none');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('AI settings saved.')).toBeVisible();
});
