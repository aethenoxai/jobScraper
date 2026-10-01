import { expect, test } from '@playwright/test';

test('a job that takes email applications: review the email, edit it and the letter, send, and see it applied', async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.goto('/profiles');
  await page.getByLabel('Profile name').fill('Email Tester');
  await page.getByRole('button', { name: 'Create profile' }).click();
  await expect(page).toHaveURL(/\/profiles\/\d+$/);
  const profileId = page.url().split('/').pop();
  await page.getByLabel(/^Full name/).fill('Ravi Kumar');
  await page.getByLabel(/^Email/).fill('ravi@example.com');
  await page.getByLabel('Current title / profession').fill('Data Engineer');
  await page.getByLabel('Years of experience').fill('5');
  await page.getByPlaceholder(/Add skills/).fill('Python, Airflow, SQL');
  await page.getByPlaceholder(/Add skills/).press('Enter');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByText('Profile saved.')).toBeVisible();
  await page.getByLabel('Job titles to look for').fill('Data Engineer');
  await page.getByLabel('Where you want to work').fill('Pune');
  await page.getByRole('button', { name: 'Save preferences' }).click();
  await expect(page.getByText('Preferences saved.')).toBeVisible();

  await page.goto('/jobs');
  await page.getByText(/Paste a job/).click();
  await page.getByLabel('Job title').fill('Data Engineer');
  await page.getByLabel('Company').fill('Mailco');
  await page.getByLabel('Location').fill('Pune, India');
  await page.getByLabel('Job description').fill('Requirements\n• Python\n• Airflow\n• SQL\n\nTo apply, email your CV to careers@mailco.example');
  await page.getByRole('button', { name: 'Save job' }).click();
  await expect(page.getByText('Job added.')).toBeVisible();

  const card = page.getByTestId('match-card').filter({ hasText: 'Mailco' });
  await expect(async () => {
    await page.goto(`/feed?profile=${profileId}`);
    await expect(card).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  await card.getByRole('link', { name: 'View' }).click();
  await page.getByRole('button', { name: 'Approve & prepare' }).click();
  await page.getByRole('link', { name: 'open application' }).click();
  await expect(page.getByText('Ready to apply', { exact: true })).toBeVisible({ timeout: 60_000 });

  // The letter is grounded: an invented employer is refused, a real edit is kept.
  await expect(page.getByTestId('cover-letter')).toContainText('Data Engineer');
  await page.getByText('Edit the cover letter').click();
  const letter = page.getByLabel(/^Letter/);
  await letter.fill(`${await letter.inputValue()}\n\nAt Google I ran Airflow for the whole company.`);
  await page.getByRole('button', { name: 'Save letter' }).click();
  await expect(page.getByRole('list', { name: 'Letter problems' })).toContainText('Google');
  await page.getByRole('button', { name: 'Undo changes' }).click();
  await letter.fill(`${await letter.inputValue()}\n\nI enjoy building reliable Airflow pipelines.`);
  await page.getByRole('button', { name: 'Save letter' }).click();
  await expect(page.getByText('Saved. The PDF is being updated…')).toBeVisible();

  // No reload: the email card picks up the edited letter by itself once the PDF is updated.
  await expect(page.getByRole('button', { name: 'Send application' })).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByLabel('To', { exact: true })).toHaveValue('careers@mailco.example');
  await expect(page.getByRole('textbox', { name: /^Message/ })).toHaveValue(/I enjoy building reliable Airflow pipelines\./);
  await page.getByLabel('Subject', { exact: true }).fill('Data Engineer application – Ravi Kumar');
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Send application' }).click();
  await expect(page.getByText('Applied', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('timeline')).toContainText(/Email accepted by the mail server for careers@mailco\.example/);
  await expect(page.getByTestId('sent-emails')).toContainText('Sent');

  const mails = (await (await request.get('http://127.0.0.1:3199/__mail')).json()) as Array<{ to: string[]; raw: string }>;
  const sent = mails.find((m) => m.to.includes('careers@mailco.example'))!;
  // Undo quoted-printable line folding; the subject is MIME-encoded because of the en dash.
  const raw = sent.raw.replace(/=\r?\n/g, '');
  expect(raw).toMatch(/Subject: =\?UTF-8\?Q\?Data_Engineer_application/);
  expect(raw).toContain('Mailco_Data_Engineer_CV.pdf');
  expect(raw).toContain('I enjoy building reliable Airflow pipelines.');
  // Sent exactly once.
  expect(mails.filter((m) => m.to.includes('careers@mailco.example'))).toHaveLength(1);
});
