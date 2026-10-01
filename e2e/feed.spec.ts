import { expect, test, type Page } from '@playwright/test';

async function pasteJob(page: Page, title: string, company: string, location: string, description: string) {
  await page.goto('/jobs');
  await page.getByText(/Paste a job/).click();
  await page.getByLabel('Job title').fill(title);
  await page.getByLabel('Company').fill(company);
  await page.getByLabel('Location').fill(location);
  await page.getByLabel('Job description').fill(description);
  await page.getByRole('button', { name: 'Save job' }).click();
  await expect(page.getByText('Job added.')).toBeVisible();
}

test('matching jobs appear in the feed with reasons; approve, skip and undo', async ({ page }) => {
  await page.goto('/profiles');
  await page.getByLabel('Profile name').fill('Feed Tester');
  await page.getByRole('button', { name: 'Create profile' }).click();
  await expect(page).toHaveURL(/\/profiles\/\d+$/);
  const profileUrl = page.url();

  await page.getByLabel('Current title / profession').fill('Backend Engineer');
  await page.getByLabel('Years of experience').fill('5');
  await page.getByPlaceholder(/Add skills/).fill('Go, PostgreSQL, Docker');
  await page.getByPlaceholder(/Add skills/).press('Enter');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByText('Profile saved.')).toBeVisible();
  await page.getByLabel('Job titles to look for').fill('Backend Engineer');
  await page.getByLabel('Where you want to work').fill('Bangalore');
  await page.getByRole('button', { name: 'Save preferences' }).click();
  await expect(page.getByText('Preferences saved.')).toBeVisible();

  await pasteJob(page, 'Senior Backend Engineer', 'Feedco', 'Bengaluru, India', 'Requirements\n• 3+ years of experience\n• Strong Go skills\n• PostgreSQL\nNice to have\n• Docker');
  await pasteJob(page, 'Staff Nurse', 'City Clinic', 'Manchester, UK', 'Care for patients on the ward.');

  const profileId = profileUrl.split('/').pop();
  await expect(async () => {
    await page.goto(`/feed?profile=${profileId}`);
    await expect(page.getByTestId('match-card').filter({ hasText: 'Senior Backend Engineer' })).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  const card = page.getByTestId('match-card').filter({ hasText: 'Senior Backend Engineer' });
  await expect(card.getByText(/Match \d+%/)).toBeVisible();

  await expect(card.getByText('New', { exact: true })).toBeVisible();
  await card.getByRole('link', { name: 'View' }).click();
  await expect(page.getByText('Why it matched')).toBeVisible();
  // Once seen, the match is no longer marked new.
  await expect(async () => {
    await page.goto(`/feed?profile=${profileId}`);
    await expect(card.getByText('New', { exact: true })).toHaveCount(0, { timeout: 1000 });
  }).toPass({ timeout: 10_000 });
  await card.getByRole('link', { name: 'View' }).click();
  await expect(page.getByRole('cell', { name: /Strong Go skills/ })).toBeVisible();
  await page.getByRole('button', { name: 'Approve & prepare' }).click();
  await expect(page.getByText('Approved ✓')).toBeVisible();
  // The worker prepares the package right away, so it may already be ready.
  await expect(page.getByText(/Preparing|Ready to apply/).first()).toBeVisible();

  await expect(async () => {
    await page.goto(`/feed?profile=${profileId}&view=filtered`);
    await expect(page.getByTestId('match-card').filter({ hasText: 'Staff Nurse' })).toContainText(/Manchester, UK isn't one of your locations|target roles/, { timeout: 1000 });
  }).toPass({ timeout: 30_000 });

  await expect(async () => {
    await page.goto('/');
    await expect(page.getByTestId('metric-Ready to apply')).toContainText(/[1-9]/, { timeout: 1000 });
  }).toPass({ timeout: 60_000 });

  // The new match was announced in the in-app inbox.
  await page.getByTestId('inbox-link').click();
  await expect(page.getByTestId('notification').filter({ hasText: 'New matching job: Senior Backend Engineer' }).first()).toBeVisible();
});

test('skip and undo a match', async ({ page }) => {
  await pasteJob(page, 'Backend Engineer II', 'Skipco', 'Bangalore', 'Requirements\n• Go\n• PostgreSQL');
  await expect(async () => {
    await page.goto('/feed?state=pending');
    const profileSelect = page.getByLabel('Profile');
    if (await profileSelect.count()) {
      await profileSelect.selectOption({ label: 'Feed Tester' });
      await page.getByRole('button', { name: 'Apply filters' }).click();
    }
    await expect(page.getByTestId('match-card').filter({ hasText: 'Backend Engineer II' })).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  const card = page.getByTestId('match-card').filter({ hasText: 'Backend Engineer II' });
  await card.getByRole('button', { name: 'Skip' }).click();
  await expect(page.getByTestId('match-card').filter({ hasText: 'Backend Engineer II' })).toHaveCount(0);
  await page.getByLabel('Show').selectOption('SKIPPED');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await page.getByTestId('match-card').filter({ hasText: 'Backend Engineer II' }).getByRole('button', { name: 'Undo skip' }).click();
  await expect(page.getByTestId('match-card').filter({ hasText: 'Backend Engineer II' })).toHaveCount(0);
});
