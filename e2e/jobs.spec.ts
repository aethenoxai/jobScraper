import { expect, test } from '@playwright/test';

test('add a job by link from a page with structured job data', async ({ page }) => {
  await page.goto('/jobs');
  await page.getByLabel('Job link').fill('http://127.0.0.1:3199/nurse.html');
  await page.getByRole('button', { name: 'Add job' }).click();
  await expect(page.getByText('Adding the job in the background')).toBeVisible();
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole('link', { name: 'Staff Nurse (Night Shifts)' })).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });
  await page.getByRole('link', { name: 'Staff Nurse (Night Shifts)' }).click();
  await expect(page.getByText('Care for patients on an acute medical ward')).toBeVisible();
  await expect(page.getByText('Fixture City Clinic')).toBeVisible();
});

test('paste a job that cannot be read automatically', async ({ page }) => {
  await page.goto('/jobs');
  await page.getByText(/Paste a job/).click();
  await page.getByLabel('Job title').fill('Product Designer');
  await page.getByLabel('Company').fill('Pasted Studio');
  await page.getByLabel('Location').fill('Remote');
  await page.getByLabel('Link (optional)').fill('https://www.linkedin.com/jobs/view/123');
  await page.getByLabel('Job description').fill('Design mobile onboarding flows in Figma.');
  await page.getByRole('button', { name: 'Save job' }).click();
  await expect(page.getByText('Job added.')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('link', { name: 'Product Designer' })).toBeVisible();
  await page.getByLabel('Search jobs').fill('pasted studio');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByRole('link', { name: 'Product Designer' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Staff Nurse (Night Shifts)' })).toHaveCount(0);
});

test('add, disable and delete a job source', async ({ page }) => {
  await page.goto('/sources');
  await page.getByLabel('Source type').selectOption('greenhouse');
  await page.getByLabel('Name', { exact: true }).first().fill('Acme careers');
  await page.getByLabel(/^Board name/).first().fill('acme');
  await page.getByRole('button', { name: 'Add source' }).click();
  await expect(page.getByText('Source added.')).toBeVisible();
  const row = page.locator('li', { hasText: 'Acme careers' });
  await expect(row.getByText('Not run yet')).toBeVisible();
  await row.getByRole('button', { name: 'Disable' }).click();
  await expect(row.getByText('Disabled')).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await row.getByRole('button', { name: 'Delete Acme careers' }).click();
  await expect(page.locator('li', { hasText: 'Acme careers' })).toHaveCount(0);
});

test('invalid source settings are explained', async ({ page }) => {
  await page.goto('/sources');
  await page.getByLabel('Source type').selectOption('greenhouse');
  await page.getByLabel(/^Board name/).first().fill('not a valid board!');
  await page.getByRole('button', { name: 'Add source' }).click();
  await expect(page.getByRole('status')).toContainText('Board name: Use the short name');
});
