/**
 * Recognises steps Job Scraper must not try to get past (PRD §26, N7): CAPTCHAs, one-time codes / two-factor
 * steps, and sign-in walls. Detection is on a snapshot of the page, so it can be unit-tested on plain data.
 */
import type { Page } from 'playwright';

export type BlockerCode = 'CAPTCHA_DETECTED' | 'MFA_REQUIRED' | 'LOGIN_REQUIRED';

export interface Blocker {
  code: BlockerCode;
  /** What was seen, for the timeline ("reCAPTCHA checkbox", "one-time code field"…). */
  evidence: string;
}

export interface SnapshotInput {
  type: string;
  name: string;
  id: string;
  autocomplete: string;
  label: string;
  placeholder: string;
}

export interface PageSnapshot {
  url: string;
  /** Visible text, lower-cased and shortened. */
  text: string;
  iframes: Array<{ src: string; title: string; visible: boolean }>;
  /** Class names of known challenge widgets present on the page. */
  widgets: string[];
  /** Visible form inputs. */
  inputs: SnapshotInput[];
  /** A form that looks like a job application (file upload, or name/email fields with a submit button). */
  hasApplicationForm: boolean;
}

const CHALLENGE_FRAME = /google\.com\/recaptcha|recaptcha\.net|hcaptcha\.com|challenges\.cloudflare\.com|arkoselabs|funcaptcha/i;
const INVISIBLE_FRAME = /size=invisible|recaptcha\/(?:api2|enterprise)\/bframe/i;
const VISIBLE_WIDGETS = ['g-recaptcha', 'h-captcha', 'cf-turnstile', 'frc-captcha'];
const HUMAN_CHECK = /\b(verify(?:ing)? (?:that )?you(?:'re| are) (?:a )?human|are you a robot|i'?m not a robot|complete the (?:captcha|security check)|checking (?:if the site connection is secure|your browser))(?![\w-])/i;
/** Challenge interstitials are short pages; a long page mentioning a "security check" is a job description. */
const INTERSTITIAL_MAX_TEXT = 1500;
const OTP = /\b(otp|one[- ]time (?:pass(?:word|code)|code)|verification code|security code|2fa|two[- ]factor|authenticat(?:or|ion) code|passcode|6-digit code)\b/i;
const SIGN_IN_URL = /\/(?:log[-_]?in|sign[-_]?in|auth(?:enticate)?|session)(?:[/?#]|$)/i;

export function detectBlocker(s: PageSnapshot): Blocker | null {
  const frame = s.iframes.find((f) => f.visible && CHALLENGE_FRAME.test(f.src) && !INVISIBLE_FRAME.test(f.src));
  if (frame) return { code: 'CAPTCHA_DETECTED', evidence: `${frame.title || 'CAPTCHA'} challenge (${new URL(frame.src, s.url).hostname})` };
  const widget = s.widgets.find((w) => VISIBLE_WIDGETS.includes(w));
  if (widget) return { code: 'CAPTCHA_DETECTED', evidence: `CAPTCHA widget (${widget})` };
  if (s.text.length <= INTERSTITIAL_MAX_TEXT && HUMAN_CHECK.test(s.text)) return { code: 'CAPTCHA_DETECTED', evidence: '"Verify you are human" check' };

  const otp = s.inputs.find((i) => i.autocomplete === 'one-time-code' || OTP.test([i.name, i.id, i.label, i.placeholder].join(' ')));
  if (otp) return { code: 'MFA_REQUIRED', evidence: `one-time code field (${otp.label || otp.name || otp.id || 'code'})` };

  const password = s.inputs.some((i) => i.type === 'password');
  if (password && (!s.hasApplicationForm || SIGN_IN_URL.test(new URL(s.url).pathname))) return { code: 'LOGIN_REQUIRED', evidence: 'sign-in form' };
  return null;
}

/** Collects what detectBlocker needs from the live page (all frames' markup is read from the top document). */
export async function snapshotPage(page: Page): Promise<PageSnapshot> {
  const data = await page.evaluate(() => {
    const visible = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      const st = getComputedStyle(el as HTMLElement);
      return r.width > 2 && r.height > 2 && st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05;
    };
    const labelOf = (el: HTMLInputElement) => {
      const byFor = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
      return ((byFor ?? el.closest('label'))?.textContent ?? el.getAttribute('aria-label') ?? '').trim().slice(0, 120);
    };
    const inputs = [...document.querySelectorAll('input, textarea')].filter((el) => visible(el) && (el as HTMLInputElement).type !== 'hidden') as HTMLInputElement[];
    const forms = [...document.querySelectorAll('form')];
    const hasApplicationForm = forms.some((f) => f.querySelector('input[type=file]') || (f.querySelector('input[type=email], input[name*=email i]') && f.querySelector('input[name*=name i], input[id*=name i]')));
    return {
      url: location.href,
      text: (document.body?.innerText ?? '').toLowerCase().slice(0, 20_000),
      iframes: [...document.querySelectorAll('iframe')].map((f) => ({ src: f.getAttribute('src') ?? '', title: f.getAttribute('title') ?? '', visible: visible(f) })),
      widgets: ['g-recaptcha', 'h-captcha', 'cf-turnstile', 'frc-captcha', 'grecaptcha-badge'].filter((c) =>
        // A reCAPTCHA bound to a button, or marked invisible, runs on submit without a challenge (v3/invisible).
        [...document.getElementsByClassName(c)].some((el) => c === 'grecaptcha-badge' || (visible(el) && el.tagName !== 'BUTTON' && el.getAttribute('data-size') !== 'invisible')),
      ),
      inputs: inputs.map((i) => ({ type: (i.type || 'text').toLowerCase(), name: i.name ?? '', id: i.id ?? '', autocomplete: (i.getAttribute('autocomplete') ?? '').toLowerCase(), label: labelOf(i), placeholder: i.placeholder ?? '' })),
      hasApplicationForm: !!hasApplicationForm,
    };
  });
  return data;
}
