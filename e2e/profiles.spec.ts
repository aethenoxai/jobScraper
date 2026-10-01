import path from 'node:path';
import { expect, test } from '@playwright/test';

const CV = path.resolve('tests/fixtures/cvs/files/software-engineer-india.pdf');

test('upload a CV to create a profile, review and edit it', async ({ page }) => {
  await page.goto('/profiles');
  // A blank name with no CV creates nothing.
  await page.getByLabel('Profile name').fill('   ');
  await page.getByRole('button', { name: 'Create profile' }).click();
  await expect(page.getByText('Enter a name for the profile, or upload your CV.')).toBeVisible();
  await expect(page).toHaveURL(/\/profiles$/);
  await page.getByLabel('Profile name').fill('Software Engineer');
  await page.getByLabel(/Latest CV/).setInputFiles(CV);
  await page.getByRole('button', { name: 'Create profile' }).click();

  await expect(page).toHaveURL(/\/profiles\/\d+$/);
  // The worker extracts the CV in the background; the page refreshes itself.
  await expect(page.getByLabel('Full name')).toHaveValue('Asha Rao', { timeout: 30_000 });
  await expect(page.getByLabel('Email')).toHaveValue('asha.rao@example.com');
  await expect(page.getByText('Applied to profile')).toBeVisible();

  await page.getByLabel('Current title / profession').fill('Senior Full Stack Engineer');
  await page.getByLabel('Notice period').fill('30 days');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByText('Profile saved.')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Current title / profession')).toHaveValue('Senior Full Stack Engineer');
  await expect(page.getByLabel('Notice period')).toHaveValue('30 days');
});

test('set job-search preferences and matching level', async ({ page }) => {
  await page.goto('/profiles');
  await page.getByRole('link', { name: 'Software Engineer' }).click();
  await page.getByLabel(/Matching and tailoring level/).fill('150');
  await expect(page.getByTestId('slider-description')).toContainText('deep');
  // Places the app can't place are flagged as name-only matches.
  await page.getByLabel('Where you want to work').fill('Bangalore, Mangalore');
  await expect(page.getByText(/Not recognised.*Mangalore/)).toBeVisible();
  // Typing a list and pressing Enter must save what was typed.
  await page.getByLabel('Where you want to work').fill('Bangalore, Remote');
  await expect(page.getByText(/Not recognised/)).toHaveCount(0);
  await page.getByLabel('Where you want to work').press('Enter');
  await expect(page.getByText('Preferences saved.')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Where you want to work')).toHaveValue('Bangalore, Remote');
  await expect(page.getByLabel(/Matching and tailoring level: 150%/)).toBeVisible();
});

test('a second profile can be created and deleted', async ({ page }) => {
  await page.goto('/profiles');
  await page.getByLabel('Profile name').fill('Product Manager');
  await page.getByRole('button', { name: 'Create profile' }).click();
  await expect(page).toHaveURL(/\/profiles\/\d+$/);
  await page.goto('/profiles');
  await expect(page.getByRole('link', { name: 'Product Manager' })).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Delete Product Manager' }).click();
  await expect(page.getByRole('link', { name: 'Product Manager' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Software Engineer' })).toBeVisible();
});

test('AI settings show offline mode without leaking keys', async ({ page }) => {
  await page.goto('/settings/ai');
  await expect(page.getByTestId('ai-state')).toContainText('Offline (no AI)');
  await page.getByLabel('Provider').selectOption('openai');
  // "Test connection" checks what is selected, before saving.
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByRole('status').filter({ hasText: /Add OPENAI_API_KEY to your .env/ })).toBeVisible();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('AI settings saved.')).toBeVisible();
  await page.reload();
  await expect(page.getByText(/Add OPENAI_API_KEY to your .env/).first()).toBeVisible();
  await expect(page.getByTestId('ai-state')).toContainText('Not configured');
  await page.getByLabel('Provider').selectOption('none');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('AI settings saved.')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('ai-state')).toContainText('Offline (no AI)');
});
