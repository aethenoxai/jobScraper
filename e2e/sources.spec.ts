import { expect, test } from '@playwright/test';

test('find a platform in the catalog, add it, disable it and delete it', async ({ page }) => {
  await page.goto('/sources');
  // The catalog is searchable: typing narrows it to one platform.
  await page.getByLabel('Search platforms').fill('greenhouse');
  const greenhouse = page.getByTestId('platform-greenhouse');
  await expect(greenhouse).toBeVisible();
  await expect(page.getByTestId('platform-remotive')).toHaveCount(0);

  // Capabilities are shown before anything is connected, and only ones the adapter really has.
  await expect(greenhouse.getByText('Scanned automatically')).toBeVisible();
  await expect(greenhouse.getByText('Notices when a job closes')).toBeVisible();
  await expect(greenhouse.getByText('Reads job pages in a browser')).toHaveCount(0);

  await greenhouse.getByRole('button', { name: 'Add' }).click();
  await greenhouse.getByLabel('Name', { exact: true }).fill('Acme careers');
  await greenhouse.getByLabel(/^Board name/).fill('acme');
  await greenhouse.getByRole('button', { name: 'Add source' }).click();
  await expect(page.getByText('Source added.')).toBeVisible();

  await page.reload();
  const row = page.locator('li', { hasText: 'Acme careers' }).first();
  await expect(row.getByText('Not run yet')).toBeVisible();
  await expect(row.getByText('0 active jobs')).toBeVisible();

  await row.getByRole('button', { name: 'Disable' }).click();
  await expect(page.locator('li', { hasText: 'Acme careers' }).first().getByText('Disabled')).toBeVisible();
  await page.locator('li', { hasText: 'Acme careers' }).first().getByRole('button', { name: 'Enable' }).click();
  await expect(page.locator('li', { hasText: 'Acme careers' }).first().getByText('Not run yet')).toBeVisible();

  page.once('dialog', (d) => d.accept());
  await page.locator('li', { hasText: 'Acme careers' }).first().getByRole('button', { name: 'Delete Acme careers' }).click();
  await expect(page.locator('li', { hasText: 'Acme careers' })).toHaveCount(0);
});

test('invalid source settings are explained before anything is saved', async ({ page }) => {
  await page.goto('/sources');
  await page.getByLabel('Search platforms').fill('greenhouse');
  const greenhouse = page.getByTestId('platform-greenhouse');
  await greenhouse.getByRole('button', { name: 'Add' }).click();
  await greenhouse.getByLabel(/^Board name/).fill('not a valid board!');
  await greenhouse.getByRole('button', { name: 'Add source' }).click();
  await expect(page.getByRole('status')).toContainText('Board name: Use the short name');
});

test('"Test" says what is wrong without saving the source', async ({ page }) => {
  await page.goto('/sources');
  await page.getByLabel('Search platforms').fill('adzuna');
  const adzuna = page.getByTestId('platform-adzuna');
  // The catalog warns about the key before the user fills anything in.
  await expect(adzuna.getByText(/Needs ADZUNA_APP_ID and ADZUNA_APP_KEY/)).toBeVisible();
  await adzuna.getByRole('button', { name: 'Add' }).click();
  // Required fields are still required when testing: the browser blocks the submit until they are filled.
  await adzuna.getByLabel(/^Country code/).fill('in');
  await adzuna.getByRole('button', { name: 'Test' }).click();
  await expect(page.getByRole('status')).toContainText('ADZUNA_APP_ID');
  // Nothing was created by testing.
  await page.reload();
  await expect(page.getByRole('heading', { name: /^Connected/ })).toHaveCount(0);
});

test('a page-reading source is never tested from the web process', async ({ page }) => {
  await page.goto('/sources');
  await page.getByLabel('Search platforms').fill('web discovery');
  const web = page.getByTestId('platform-web');
  await expect(web.getByText('Adds company boards it finds')).toBeVisible();
  await web.getByRole('button', { name: 'Add' }).click();
  await web.getByLabel(/^Search provider/).fill('brave');
  await web.getByRole('button', { name: 'Test' }).click();
  await expect(page.getByRole('status')).toContainText('next scan');
});

test('restricted platforms are listed with the supported way in, not as scan targets', async ({ page }) => {
  await page.goto('/sources');
  await page.getByLabel('Search platforms').fill('linkedin');
  const linkedin = page.getByTestId('platform-linkedin');
  await expect(linkedin.getByText('Manual only')).toBeVisible();
  await expect(linkedin.getByText(/terms forbid automated reading/)).toBeVisible();
  // LinkedIn is never fetched, so "Add by link" is not offered for it; pasting is.
  await expect(linkedin.getByText('Paste a job', { exact: true })).toBeVisible();
  await expect(linkedin.getByText('Add by link', { exact: true })).toHaveCount(0);
  await expect(linkedin.getByText('Scanned automatically', { exact: true })).toHaveCount(0);
  // No connector exists, so there is nothing to configure.
  await expect(linkedin.getByRole('button', { name: 'Add' })).toHaveCount(0);

  // A platform with no API but no ban can still be read one page at a time.
  await page.getByLabel('Search platforms').fill('internshala');
  const internshala = page.getByTestId('platform-internshala');
  await expect(internshala.getByText('Add by link', { exact: true })).toBeVisible();
  await expect(internshala.getByText('Paste a job', { exact: true })).toBeVisible();
});

test('any site can be added by link or pasted from the Job sources page', async ({ page }) => {
  await page.goto('/sources');
  await expect(page.getByRole('heading', { name: 'Add a job yourself' })).toBeVisible();
  await page.getByLabel('Job link').fill('http://127.0.0.1:3199/nurse.html');
  await expect(page.getByRole('button', { name: 'Add job' })).toBeVisible();
  await page.locator('summary', { hasText: 'Paste a job' }).click();
  await expect(page.getByLabel('Job title')).toBeVisible();
});
