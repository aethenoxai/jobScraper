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
  // Within the page: Next's screen-reader announcement of the new page ("… at Fixture City Clinic") also has the name.
  const main = page.getByRole('main');
  await expect(main.getByText('Care for patients on an acute medical ward')).toBeVisible();
  await expect(main.getByText('Fixture City Clinic')).toBeVisible();
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
