import { expect, test } from '@playwright/test';

test('approve → tailored CV with PDF → edit and re-render → mark applied → delete', async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.goto('/profiles');
  await page.getByLabel('Profile name').fill('Apply Tester');
  await page.getByRole('button', { name: 'Create profile' }).click();
  await expect(page).toHaveURL(/\/profiles\/\d+$/);
  const profileId = page.url().split('/').pop();
  await page.getByLabel('Current title / profession').fill('Payments Engineer');
  await page.getByLabel('Years of experience').fill('6');
  await page.getByPlaceholder(/Add skills/).fill('Go, PostgreSQL, Kafka');
  await page.getByPlaceholder(/Add skills/).press('Enter');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByText('Profile saved.')).toBeVisible();
  await page.getByLabel('Job titles to look for').fill('Payments Engineer');
  await page.getByLabel('Where you want to work').fill('Bangalore');
  await page.getByRole('button', { name: 'Save preferences' }).click();
  await expect(page.getByText('Preferences saved.')).toBeVisible();

  await page.goto('/jobs');
  await page.getByText(/Paste a job/).click();
  await page.getByLabel('Job title').fill('Senior Payments Engineer');
  await page.getByLabel('Company').fill('Payco');
  await page.getByLabel('Location').fill('Bengaluru, India');
  await page.getByLabel('Job description').fill('Requirements\n• 5+ years of experience\n• Go\n• PostgreSQL\nNice to have\n• Kafka');
  await page.getByRole('button', { name: 'Save job' }).click();
  await expect(page.getByText('Job added.')).toBeVisible();

  const card = page.getByTestId('match-card').filter({ hasText: 'Senior Payments Engineer' });
  await expect(async () => {
    await page.goto(`/feed?profile=${profileId}`);
    await expect(card).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  await card.getByRole('link', { name: 'View' }).click();
  await page.getByRole('button', { name: 'Approve & prepare' }).click();
  await page.getByRole('link', { name: 'open application' }).click();
  await expect(page).toHaveURL(/\/applications\/\d+$/);

  // The worker tailors the CV and renders the PDF; the page refreshes itself.
  await expect(page.getByText('Ready to apply', { exact: true })).toBeVisible({ timeout: 60_000 });
  const href = await page.getByTestId('download-cv').getAttribute('href');
  const pdf = await request.get(href!);
  expect(pdf.headers()['content-type']).toBe('application/pdf');
  expect(pdf.headers()['content-disposition']).toContain('Payco_Senior_Payments_Engineer_CV.pdf');
  expect((await pdf.body()).subarray(0, 4).toString()).toBe('%PDF');
  await expect(page.getByTestId('change-report')).toBeVisible();
  await expect(page.getByTitle('CV preview')).toBeVisible();

  // Edits must stay grounded in the profile.
  await page.getByText('Edit the tailored CV').click();
  const skills = page.getByLabel(/^Skills/);
  await skills.fill(`${await skills.inputValue()}, Kubernetes`);
  await page.getByRole('button', { name: 'Save CV' }).click();
  await expect(page.getByText(/Not saved/)).toBeVisible();
  await expect(page.getByRole('list', { name: 'Problems' })).toContainText('Kubernetes');
  await page.getByRole('button', { name: 'Undo changes' }).click();
  await page.getByLabel('Summary').fill('Payments engineer who builds reliable Go services on PostgreSQL.');
  await page.getByRole('button', { name: 'Save CV' }).click();
  await expect(page.getByText('Saved. The PDF is being updated…')).toBeVisible();
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId('timeline')).toContainText('PDFs updated: CV', { timeout: 1000 });
  }).toPass({ timeout: 30_000 });

  await page.getByPlaceholder('e.g. applied on the company site').fill('applied on the Payco careers site');
  await page.getByRole('button', { name: 'Mark as applied' }).click();
  await expect(page.getByText('Applied', { exact: true })).toBeVisible();
  await expect(page.getByTestId('timeline')).toContainText('Marked as applied: applied on the Payco careers site');

  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Delete application' }).click();
  await expect(page).toHaveURL(/\/applications\?msg=deleted/);
  await expect(page.getByText(/Application deleted/)).toBeVisible();
  await expect(page.getByTestId('application-row').filter({ hasText: 'Senior Payments Engineer' })).toHaveCount(0);
  expect((await request.get(href!)).status()).toBe(404);
});
