import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApplyServer } from '../../../e2e/fixtures/apply-server.mjs';
import { assignIds, emptyProfile, type ProfileData } from '../profile/model';
import { runApplication, type ApplyOutcome } from './apply';

function profile(): ProfileData {
  const p = emptyProfile();
  p.personal = { fullName: 'Asha Rao', email: 'asha@example.com', phone: '+91 98765 43210', location: 'Pune, India', country: 'India', timezone: null, links: [{ id: '', label: 'LinkedIn', url: 'https://www.linkedin.com/in/asha-rao-example' }] };
  p.headline = 'Backend Engineer';
  p.yearsExperience = 5;
  p.experience = [{ id: '', title: 'Backend Engineer', company: 'Example Payments', location: null, startDate: '2021-01', endDate: null, current: true, summary: null, bullets: [] }];
  p.application = { workAuthorization: 'Indian citizen', visaStatus: null, noticePeriod: '30 days', relocation: null, travel: null, currentlyEmployed: true, currentSalary: null, expectedSalary: null };
  return assignIds(p);
}

const server = createApplyServer();
let base = '';
let browser: Browser;
let dir = '';
let cvFile = '';
beforeAll(async () => {
  base = await server.listen(0);
  browser = await chromium.launch({ headless: true });
  dir = mkdtempSync(path.join(tmpdir(), 'js-apply-'));
  cvFile = path.join(dir, 'Acme_Backend_Engineer_CV.pdf');
  writeFileSync(cvFile, '%PDF-1.7 test');
});
afterAll(async () => {
  await browser?.close();
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => void (server.submissions.length = 0));

async function apply(pathname: string, opts: { allowPrivateUrls?: boolean; url?: string } = {}): Promise<{ outcome: ApplyOutcome; steps: string[]; submitting: number; submittingAt: number }> {
  const page: Page = await browser.newPage();
  // Offline: third-party scripts and frames (e.g. CAPTCHA providers) are not loaded.
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  const steps: string[] = [];
  let submitting = 0;
  let submittingAt = 0;
  try {
    const outcome = await runApplication(page, {
      url: opts.url ?? base + pathname,
      allowPrivateUrls: opts.allowPrivateUrls ?? true,
      profile: profile(),
      cvFile,
      coverLetterFile: null,
      ai: null,
      job: { title: 'Backend Engineer', company: 'Acme' },
      jobCountry: 'IN',
      log: (s) => void steps.push(s),
      onSubmitting: () => {
        submitting++;
        submittingAt = Date.now();
      },
    });
    return { outcome, steps, submitting, submittingAt };
  } finally {
    await page.close();
  }
}

describe('applying on a website (fixture suite)', () => {
  it('Greenhouse-like form → applied, with the CV uploaded, truthful answers and proof', async () => {
    const { outcome, steps, submitting } = await apply('/greenhouse/acme/jobs/123');
    expect(outcome).toMatchObject({ result: 'applied' });
    if (outcome.result !== 'applied') return;
    expect(outcome.evidence).toMatch(/thank you for applying/i);
    expect(outcome.screenshot.subarray(1, 4).toString()).toBe('PNG');
    expect(submitting).toBe(1);
    const [sub] = server.submissions;
    const value = (n: string) => sub.fields.find((x: { name: string }) => x.name === n);
    expect(value('job_application[first_name]').value).toBe('Asha');
    expect(value('job_application[email]').value).toBe('asha@example.com');
    expect(value('job_application[resume]').filename).toBe('Acme_Backend_Engineer_CV.pdf');
    expect(value('job_application[answers_attributes][1][boolean_value]').value).toBe('1');
    expect(value('job_application[gender]').value).toBe('Decline to self-identify');
    expect(steps.join('\n')).toMatch(/Uploaded Acme_Backend_Engineer_CV\.pdf/);
  }, 60_000);

  it('Lever-like (Apply button first), Ashby-like (no page change) and a multi-step wizard → applied', async () => {
    for (const p of ['/lever/acme/abc', '/ashby/acme/xyz/application', '/wizard/job']) {
      server.submissions.length = 0;
      const { outcome } = await apply(p);
      expect(outcome.result, p).toBe('applied');
      expect(server.submissions, p).toHaveLength(1);
    }
  }, 120_000);

  it.each([
    ['/captcha/job', 'CAPTCHA_DETECTED'],
    ['/otp/job', 'MFA_REQUIRED'],
    ['/login-wall/job', 'LOGIN_REQUIRED'],
  ])('%s → skipped (%s) without submitting anything', async (p, code) => {
    const { outcome, submitting } = await apply(p);
    expect(outcome).toMatchObject({ result: 'skipped', code, submitted: false });
    expect(submitting).toBe(0);
    expect(server.submissions).toHaveLength(0);
  }, 60_000);

  it('a required question it cannot answer truthfully → skipped, nothing submitted', async () => {
    const { outcome } = await apply('/unanswerable/job');
    expect(outcome).toMatchObject({ result: 'skipped', code: 'UNSUPPORTED_APPLICATION_FLOW', submitted: false });
    if (outcome.result === 'skipped') expect(outcome.reason).toMatch(/quantum error correction/);
    expect(server.submissions).toHaveLength(0);
  }, 60_000);

  it('a site that errors after Submit → failed (NO_CONFIRMATION), marked as submitted so it is never retried', async () => {
    const { outcome } = await apply('/error/job');
    expect(outcome).toMatchObject({ result: 'failed', code: 'NO_CONFIRMATION', submitted: true });
    if (outcome.result === 'failed') expect(outcome.reason).toMatch(/500|did not confirm/i);
  }, 60_000);

  it('records "submitting" before the form is sent (crash safety)', async () => {
    const { submittingAt } = await apply('/greenhouse/acme/jobs/123');
    expect(submittingAt).toBeGreaterThan(0);
    expect(submittingAt).toBeLessThanOrEqual(server.submissions[0].at);
  }, 60_000);
});

describe('never a false "applied" (M7 review)', () => {
  it('confirmation text that was already on the page does not count, and a blocked submit is not "maybe sent"', async () => {
    const { outcome } = await apply('/thanks-already/job');
    expect(outcome.result).not.toBe('applied');
    expect(server.submissions).toHaveLength(0);
  }, 60_000);

  it('a job URL containing "success" and a hash change are not a confirmation', async () => {
    const { outcome } = await apply('/jobs/42-customer-success-manager');
    expect(outcome.result).not.toBe('applied');
    expect(outcome).toMatchObject({ submitted: false });
  }, 60_000);

  it('a page with only a job-alert signup is not an application form', async () => {
    const { outcome, submitting } = await apply('/alerts-only/careers');
    expect(outcome).toMatchObject({ result: 'failed', code: 'UNSUPPORTED_APPLICATION_FLOW', submitted: false });
    expect(submitting).toBe(0);
    expect(server.submissions).toHaveLength(0);
  }, 60_000);

  it('uses the form’s own Submit button, not an "Apply" button elsewhere on the page', async () => {
    const { outcome } = await apply('/header-apply/job');
    expect(outcome.result).toBe('applied');
    expect(server.submissions).toHaveLength(1);
  }, 60_000);

  it('a required radio group it cannot answer is caught before submitting', async () => {
    const { outcome, submitting } = await apply('/radio-required/job');
    expect(outcome).toMatchObject({ result: 'skipped', code: 'UNSUPPORTED_APPLICATION_FLOW', submitted: false });
    if (outcome.result === 'skipped') expect(outcome.reason).toMatch(/fintech/);
    expect(submitting).toBe(0);
  }, 60_000);

  it('ticks only required consent boxes, never attestations or marketing opt-ins', async () => {
    const { outcome } = await apply('/consents/job');
    expect(outcome.result).toBe('applied');
    const names = server.submissions[0].fields.map((f: { name: string }) => f.name);
    expect(names).toContain('privacy');
    expect(names).not.toContain('us_auth');
    expect(names).not.toContain('sms');
  }, 60_000);
});

describe('where the browser may go (M7 review S1/S2)', () => {
  it('refuses private-network addresses unless explicitly allowed', async () => {
    const { outcome, submitting } = await apply('/greenhouse/acme/jobs/123', { allowPrivateUrls: false });
    expect(outcome).toMatchObject({ result: 'failed', code: 'UNSUPPORTED_APPLICATION_FLOW', submitted: false });
    expect(submitting).toBe(0);
    expect(server.submissions).toHaveLength(0);
  }, 60_000);

  it('never automates LinkedIn, Indeed and the other never-fetch sites', async () => {
    const { outcome } = await apply('', { url: 'https://www.linkedin.com/jobs/view/123' });
    expect(outcome).toMatchObject({ result: 'failed', code: 'UNSUPPORTED_APPLICATION_FLOW', submitted: false });
  }, 60_000);
});

describe('real job-board markup (M7 review I2)', () => {
  const value = (n: string) => server.submissions[0].fields.find((x: { name: string }) => x.name === n);

  it('answers custom dropdowns (Greenhouse comboboxes) and ignores their hidden mirror inputs', async () => {
    const { outcome } = await apply('/gh-new/acme/jobs/7');
    expect(outcome).toMatchObject({ result: 'applied' });
    expect(value('question_auth').value).toBe('Yes');
    expect(value('gender').value).toBe('Decline To Self Identify');
    expect(value('resume').filename).toBe('Acme_Backend_Engineer_CV.pdf');
  }, 60_000);

  it('applies through a form embedded in the company’s own careers page', async () => {
    const { outcome } = await apply('/company/careers/backend-engineer');
    expect(outcome).toMatchObject({ result: 'applied' });
    expect(server.submissions).toHaveLength(1);
  }, 60_000);

  it('follows an Apply link that opens a new tab', async () => {
    const { outcome } = await apply('/newtab/job');
    expect(outcome).toMatchObject({ result: 'applied' });
    expect(server.submissions).toHaveLength(1);
  }, 60_000);
});
