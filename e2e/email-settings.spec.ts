import { expect, test } from '@playwright/test';

test('email settings show the sender, send a real test email, and explain what OAuth needs', async ({ page, request }) => {
  await page.goto('/settings/email');
  await expect(page.getByTestId('email-status')).toContainText('Ready: sending as e2e@example.com via smtp');
  await expect(page.getByText(/Add GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Send a test email to yourself' }).click();
  await expect(page.getByRole('status')).toContainText(/Sent to e2e@example\.com/, { timeout: 15_000 });
  const mails = (await (await request.get('http://127.0.0.1:3199/__mail')).json()) as Array<{ to: string[]; secure: boolean; raw: string }>;
  const test = mails.find((m) => m.raw.includes('Subject: Job Scraper test email'));
  expect(test?.to).toEqual(['e2e@example.com']);
  expect(test?.secure).toBe(true); // STARTTLS was used
  // Without a client id, starting OAuth comes back with an explanation instead of an error page.
  await page.goto('/api/oauth/gmail/start');
  await expect(page).toHaveURL(/\/settings\/email\?error=/);
  await expect(page.getByText(/Add GMAIL_CLIENT_ID/).first()).toBeVisible();
  // A forged callback is refused.
  await page.goto('/api/oauth/gmail/callback?code=x&state=forged');
  await expect(page.getByText(/expired or did not start here/)).toBeVisible();
});
