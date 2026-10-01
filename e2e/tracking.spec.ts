import { expect, test } from '@playwright/test';

test('after applying: move to interview, schedule it (shown on the dashboard), add a note; inbox tracking settings', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/profiles');
  await page.getByLabel('Profile name').fill('Tracking Tester');
  await page.getByRole('button', { name: 'Create profile' }).click();
  await expect(page).toHaveURL(/\/profiles\/\d+$/);
  const profileId = page.url().split('/').pop();
  await page.getByLabel('Current title / profession').fill('QA Engineer');
  await page.getByLabel('Years of experience').fill('3');
  await page.getByPlaceholder(/Add skills/).fill('Selenium, Cypress');
  await page.getByPlaceholder(/Add skills/).press('Enter');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByText('Profile saved.')).toBeVisible();
  await page.getByLabel('Job titles to look for').fill('QA Engineer');
  await page.getByLabel('Where you want to work').fill('Pune');
  await page.getByRole('button', { name: 'Save preferences' }).click();
  await expect(page.getByText('Preferences saved.')).toBeVisible();

  await page.goto('/jobs');
  await page.getByText(/Paste a job/).click();
  await page.getByLabel('Job title').fill('QA Engineer');
  await page.getByLabel('Company').fill('Trackco');
  await page.getByLabel('Location').fill('Pune, India');
  await page.getByLabel('Job description').fill('Requirements\n• Selenium\n• Cypress');
  await page.getByRole('button', { name: 'Save job' }).click();
  const card = page.getByTestId('match-card').filter({ hasText: 'Trackco' });
  await expect(async () => {
    await page.goto(`/feed?profile=${profileId}`);
    await expect(card).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  await card.getByRole('link', { name: 'View' }).click();
  await page.getByRole('button', { name: 'Approve & prepare' }).click();
  await page.getByRole('link', { name: 'open application' }).click();
  await expect(page.getByText('Ready to apply', { exact: true })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Mark as applied' }).click();
  await expect(page.getByText('Applied', { exact: true })).toBeVisible();

  const progress = page.getByTestId('progress');
  await progress.getByLabel('New status').selectOption({ label: 'Interview' });
  await progress.getByLabel('Note (optional)').fill('Recruiter called');
  await progress.getByRole('button', { name: 'Update status' }).click();
  await expect(page.getByText('Interview', { exact: true }).first()).toBeVisible();
  await progress.getByLabel('Interview on').fill('2099-03-15T10:30');
  await progress.getByLabel('Details').fill('Panel with the QA lead');
  await progress.getByRole('button', { name: 'Add interview' }).click();
  await expect(page.getByTestId('timeline')).toContainText('Video interview on 15 Mar 2099');
  await page.getByLabel('Note', { exact: true }).fill('Prepare the Cypress demo');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByTestId('timeline')).toContainText('Prepare the Cypress demo');

  const appUrl = page.url();
  await page.goto('/');
  await expect(page.getByTestId('upcoming-interviews')).toContainText('QA Engineer at Trackco');
  await expect(page.getByTestId('upcoming-interviews')).toContainText('Video');

  // A final status asks first; cancelling keeps the application as it was.
  await page.goto(appUrl);
  await progress.getByLabel('New status').selectOption({ label: 'Rejected' });
  page.once('dialog', (d) => void d.dismiss());
  await progress.getByRole('button', { name: 'Update status' }).click();
  await expect(page.getByText('Interview', { exact: true }).first()).toBeVisible();
  page.once('dialog', (d) => {
    expect(d.message()).toMatch(/can't be undone/);
    void d.accept();
  });
  await progress.getByRole('button', { name: 'Update status' }).click();
  await expect(progress).toContainText('This application is closed (rejected)');
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'QA Engineer at Trackco' })).toHaveCount(0);

  await page.goto('/settings/tracking');
  await expect(page.getByTestId('mailbox')).toContainText('Not ready: Add IMAP_HOST');
  // Without a mailbox, tracking can't be switched on and there's nothing to check.
  await expect(page.getByRole('button', { name: 'Check now' })).toBeDisabled();
  await page.getByLabel(/Read my inbox/).check();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status')).toContainText('Inbox tracking can’t be turned on yet. Add IMAP_HOST');
});
