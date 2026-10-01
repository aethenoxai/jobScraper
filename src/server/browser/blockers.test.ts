import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApplyServer } from '../../../e2e/fixtures/apply-server.mjs';
import { detectBlocker, snapshotPage, type PageSnapshot } from './blockers';

const snap = (over: Partial<PageSnapshot> = {}): PageSnapshot => ({ url: 'https://boards.example/jobs/1', text: 'apply for this job', iframes: [], widgets: [], inputs: [], hasApplicationForm: true, ...over });

describe('detectBlocker', () => {
  it('flags visible CAPTCHA challenges, but not invisible score-based badges', () => {
    expect(detectBlocker(snap({ iframes: [{ src: 'https://www.google.com/recaptcha/api2/anchor?k=x', title: 'reCAPTCHA', visible: true }] }))?.code).toBe('CAPTCHA_DETECTED');
    expect(detectBlocker(snap({ iframes: [{ src: 'https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html#frame=checkbox', title: 'hCaptcha', visible: true }] }))?.code).toBe('CAPTCHA_DETECTED');
    expect(detectBlocker(snap({ widgets: ['cf-turnstile'] }))?.code).toBe('CAPTCHA_DETECTED');
    expect(detectBlocker(snap({ text: 'please verify you are human to continue' }))?.code).toBe('CAPTCHA_DETECTED');
    expect(detectBlocker(snap({ iframes: [{ src: 'https://www.google.com/recaptcha/enterprise/anchor?size=invisible', title: 'reCAPTCHA', visible: false }], widgets: ['grecaptcha-badge'] }))).toBeNull();
  });

  it('flags one-time codes and two-factor steps', () => {
    expect(detectBlocker(snap({ inputs: [{ type: 'text', name: 'code', id: '', autocomplete: 'one-time-code', label: '', placeholder: '' }] }))?.code).toBe('MFA_REQUIRED');
    expect(detectBlocker(snap({ inputs: [{ type: 'text', name: 'x', id: '', autocomplete: '', label: 'Enter your verification code', placeholder: '' }] }))?.code).toBe('MFA_REQUIRED');
  });

  it('flags sign-in walls, not application forms that happen to ask for an account password', () => {
    expect(detectBlocker(snap({ hasApplicationForm: false, inputs: [{ type: 'password', name: 'password', id: '', autocomplete: '', label: 'Password', placeholder: '' }] }))?.code).toBe('LOGIN_REQUIRED');
    expect(detectBlocker(snap({ inputs: [{ type: 'email', name: 'email', id: '', autocomplete: '', label: 'Email', placeholder: '' }] }))).toBeNull();
  });
});

describe('blocker heuristics (M7 review)', () => {
  it('a job description that mentions a security check is not a challenge page', () => {
    const description = `${'We build payments infrastructure. '.repeat(80)}You will complete the security check process for vendors and verify you are a human-centred designer.`;
    expect(detectBlocker(snap({ text: description.toLowerCase() }))).toBeNull();
  });

  it("recognises Cloudflare's current interstitial", () => {
    expect(detectBlocker(snap({ text: 'careers.example.com\nverifying you are human. this may take a few seconds.', hasApplicationForm: false }))?.code).toBe('CAPTCHA_DETECTED');
    expect(detectBlocker(snap({ text: 'just a moment...\nverify you are human by completing the action below.', hasApplicationForm: false }))?.code).toBe('CAPTCHA_DETECTED');
  });
});

describe('blockers on real pages', () => {
  const server = createApplyServer();
  let base = '';
  let browser: Browser;
  beforeAll(async () => {
    base = await server.listen(0);
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
    await server.close();
  });

  it.each([
    ['/captcha/job', 'CAPTCHA_DETECTED'],
    ['/otp/job', 'MFA_REQUIRED'],
    ['/login-wall/job', 'LOGIN_REQUIRED'],
    ['/greenhouse/acme/jobs/123', null],
    ['/lever/acme/abc/apply', null],
  ])('%s → %s', async (path, code) => {
    const page = await browser.newPage();
    // Third-party challenge scripts are not loaded offline; the markup is enough to recognise them.
    await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
    await page.goto(base + path);
    expect(detectBlocker(await snapshotPage(page))?.code ?? null).toBe(code);
    await page.close();
  }, 30_000);

  it('an invisible reCAPTCHA bound to the submit button is not a challenge', async () => {
    const page = await browser.newPage();
    await page.setContent('<form><input type="file" name="resume"><input name="name"><input type="email" name="email"><button class="g-recaptcha" data-sitekey="x" data-callback="onSubmit" data-action="submit">Submit application</button><div class="g-recaptcha" data-sitekey="y" data-size="invisible"></div></form>');
    expect(detectBlocker(await snapshotPage(page))).toBeNull();
    await page.close();
  }, 30_000);
});
