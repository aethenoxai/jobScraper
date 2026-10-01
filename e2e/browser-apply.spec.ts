import { expect, test, type Page } from '@playwright/test';

const SITE = 'http://127.0.0.1:3197';

async function approveAndOpen(page: Page, profileId: string, title: string, company: string, link: string) {
  await page.goto('/jobs');
  await page.getByText(/Paste a job/).click();
  await page.getByLabel('Job title').fill(title);
  await page.getByLabel('Company').fill(company);
  await page.getByLabel('Location').fill('Pune, India');
  await page.getByLabel('Link (optional)').fill(link);
  await page.getByLabel('Job description').fill('Requirements\n• Go\n• PostgreSQL');
  await page.getByRole('button', { name: 'Save job' }).click();
  await expect(page.getByText('Job added.')).toBeVisible();
  const card = page.getByTestId('match-card').filter({ hasText: company });
  await expect(async () => {
    await page.goto(`/feed?profile=${profileId}`);
    await expect(card).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  await card.getByRole('link', { name: 'View' }).click();
  await page.getByRole('button', { name: 'Approve & prepare' }).click();
  await page.getByRole('link', { name: 'open application' }).click();
  await expect(page.getByText('Ready to apply', { exact: true })).toBeVisible({ timeout: 60_000 });
}

test('apply in the browser: a form is filled and submitted with proof; a CAPTCHA is skipped without submitting', async ({ page, request }) => {
  test.setTimeout(180_000);
  await request.get(`${SITE}/__reset`);
  await page.goto('/profiles');
  await page.getByLabel('Profile name').fill('Browser Tester');
  await page.getByRole('button', { name: 'Create profile' }).click();
  await expect(page).toHaveURL(/\/profiles\/\d+$/);
  const profileId = page.url().split('/').pop()!;
  await page.getByLabel(/^Full name/).fill('Meera Iyer');
  await page.getByLabel(/^Email/).fill('meera@example.com');
  await page.getByLabel(/^Phone/).fill('+91 90000 00000');
  await page.getByLabel(/^Country/).fill('India');
  await page.getByLabel(/^Work authorization/).fill('Indian citizen');
  await page.getByLabel('Current title / profession').fill('Backend Engineer');
  await page.getByLabel('Years of experience').fill('4');
  await page.getByPlaceholder(/Add skills/).fill('Go, PostgreSQL');
  await page.getByPlaceholder(/Add skills/).press('Enter');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByText('Profile saved.')).toBeVisible();
  await page.getByLabel('Job titles to look for').fill('Backend Engineer');
  await page.getByLabel('Where you want to work').fill('Pune');
  await page.getByRole('button', { name: 'Save preferences' }).click();
  await expect(page.getByText('Preferences saved.')).toBeVisible();

  await approveAndOpen(page, profileId, 'Backend Engineer', 'Greenhouse Acme', `${SITE}/greenhouse/acme/jobs/123`);
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Apply in browser' }).click();
  await expect(page.getByText('Applied', { exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('timeline')).toContainText('Uploaded');
  await expect(page.getByTestId('timeline')).toContainText(/The site confirmed the application/);
  await expect(page.getByTestId('screenshot')).toBeVisible();
  const subs = (await (await request.get(`${SITE}/__submissions`)).json()) as Array<{ path: string; fields: Array<{ name: string; value: string | null; filename: string | null }> }>;
  const gh = subs.find((s) => s.path === '/greenhouse/acme/jobs/123/submit')!;
  expect(gh.fields.find((f) => f.name === 'job_application[first_name]')?.value).toBe('Meera');
  expect(gh.fields.find((f) => f.name === 'job_application[resume]')?.filename).toMatch(/_CV\.pdf$/);

  await approveAndOpen(page, profileId, 'Backend Engineer', 'Captcha Corp', `${SITE}/captcha/job`);
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Apply in browser' }).click();
  await expect(page.getByTestId('failure-reason')).toContainText(/captcha/i, { timeout: 90_000 });
  await expect(page.getByTestId('failure-help')).toContainText('never solves CAPTCHAs');
  await expect(page.getByTestId('failure-reason')).toContainText('No application was submitted');
  const after = (await (await request.get(`${SITE}/__submissions`)).json()) as Array<{ path: string }>;
  expect(after.some((s) => s.path.startsWith('/captcha'))).toBe(false);
});
