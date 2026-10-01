/**
 * Applies to one job on its website (PRD §25–26, PLAN §2.11): opens the page, reaches the application form, checks
 * for blockers before every step, fills truthful answers, uploads the CV, submits and looks for confirmation.
 * Blocked or unanswerable flows are skipped before anything is sent; after Submit, the outcome is never retried.
 * "Applied" needs proof tied to this submission: something was sent, and the confirmation is new.
 */
import type { Page, Request, Response } from 'playwright';
import type { Ai } from '../ai';
import { NEVER_FETCH } from '../discovery/web';
import { isPublicHttpUrl, resolvesToPublicAddress } from '../http';
import type { ProfileData } from '../profile/model';
import { detectBlocker, snapshotPage, type BlockerCode } from './blockers';
import { mapFields, mapWithAi, pickOption, type FieldAnswer, type FormField } from './fields';

export type ApplyOutcome =
  | { result: 'applied'; evidence: string; screenshot: Buffer }
  | { result: 'skipped'; code: BlockerCode | 'UNSUPPORTED_APPLICATION_FLOW'; reason: string; submitted: false; screenshot?: Buffer }
  | { result: 'failed'; code: 'NO_CONFIRMATION' | 'UNSUPPORTED_APPLICATION_FLOW' | 'BROWSER_ERROR'; reason: string; submitted: boolean; screenshot?: Buffer };

export interface ApplyInput {
  url: string;
  profile: ProfileData;
  cvFile: string;
  coverLetterFile?: string | null;
  ai: Ai | null;
  job: { title: string; company: string; description?: string };
  jobCountry: string | null;
  /** A step the user should see (timeline and on-page overlay). */
  log: (step: string) => void;
  /** Called right before Submit is clicked; after this the application must never be submitted again. */
  onSubmitting: () => void;
  signal?: AbortSignal;
  /** Local fixture sites (tests) only: allow private-network addresses. */
  allowPrivateUrls?: boolean;
}

const MAX_STEPS = 8;
const CONFIRMATION_TEXT = /thank(?:s| you)(?: so much)? for (?:applying|your (?:application|interest))|application (?:has been |was )?(?:received|submitted|sent|complete)|we(?:'ve| have) received your application|successfully (?:applied|submitted)/i;
const CONFIRMATION_URL = /thank|confirm|success|submitted|complete/i;
const APPLY_LINK = /^(?:apply(?: now| for this job| for this position| here)?|i'?m interested|start (?:your )?application)$/i;
const NEXT_BUTTON = /^(?:next|continue|save (?:and|&) continue|proceed|next step)\b/i;
const SUBMIT_BUTTON = /submit|send application|^apply$|apply now|finish|complete application/i;
/** Buttons that hand the application to another site or autofill service: never ours to press. */
const FOREIGN_BUTTON = /linkedin|indeed|autofill|apply with|import|seek|xing/i;
/** Consent boxes that may be ticked when the site requires them: privacy notice and terms only. */
const CONSENT = /\b(privacy (?:policy|notice)|data (?:processing|protection)|terms (?:and|&) conditions|terms of (?:use|service)|consent to (?:the )?processing|gdpr)\b/i;
/** Never ticked automatically: statements of fact, and opt-ins the user didn't ask for. */
const NOT_CONSENT = /\b(authori[sz]|sponsor|visa|citizen|relocat|18|age|background|criminal|convict|certify|attest|truthful|accurate|marketing|newsletter|sms|text messages?|whatsapp|talent (?:pool|community|network)|job alerts?|promotional|future (?:roles|opportunities))\b/i;
const short = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Marks the application form (data-js-form) and the visible fields of its current step (data-js-field).
 * Only a form with a file upload (the CV) counts as an application form; anything else is not applied to.
 */
async function extractFields(page: Page): Promise<{ hasForm: boolean; fields: FormField[] }> {
  return page.evaluate(() => {
    document.querySelectorAll('[data-js-field]').forEach((el) => el.removeAttribute('data-js-field'));
    document.querySelectorAll('[data-js-form]').forEach((el) => el.removeAttribute('data-js-form'));
    const hidden = (el: Element) => {
      const st = getComputedStyle(el as HTMLElement);
      return !!el.closest('[hidden], [aria-hidden]:not([aria-hidden="false"])') || st.display === 'none' || st.visibility === 'hidden';
    };
    const visible = (el: Element) => {
      const input = el as HTMLInputElement;
      // File inputs are often visually hidden behind a styled button but still usable.
      if (input.type === 'file') return !el.closest('[hidden]') && getComputedStyle(el as HTMLElement).display !== 'none';
      const r = (el as HTMLElement).getBoundingClientRect();
      // Hidden mirror inputs of custom dropdowns (aria-hidden, tabindex=-1, transparent) are not fields.
      if ((input.hasAttribute('aria-hidden') && input.getAttribute('aria-hidden') !== 'false') || (input.tabIndex === -1 && Number(getComputedStyle(el as HTMLElement).opacity) < 0.1)) return false;
      return r.width > 0 && r.height > 0 && !hidden(el);
    };
    const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const labelOf = (el: HTMLElement) => {
      const byFor = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
      const wrap = el.closest('label');
      const aria = el.getAttribute('aria-label');
      const labelled = el.getAttribute('aria-labelledby')?.split(' ').map((id) => text(document.getElementById(id))).join(' ');
      const own = byFor ?? wrap ? text(byFor ?? wrap).replace(text(el), '').trim() : '';
      return own || aria || labelled || (el as HTMLInputElement).placeholder || text(el.closest('.field, .form-group, fieldset')?.querySelector('legend, label, .label')) || el.getAttribute('name') || '';
    };
    const form = [...document.querySelectorAll('form')].find((f) => !hidden(f) && f.querySelector('input[type=file]'));
    if (!form) return { hasForm: false, fields: [] } as never;
    form.setAttribute('data-js-form', '1');
    const fields: Array<{ key: string; kind: string; label: string; name: string; required: boolean; options: string[]; combobox?: boolean }> = [];
    const radios = new Map<string, HTMLInputElement[]>();
    let n = 0;
    for (const el of form.querySelectorAll<HTMLElement>('input, select, textarea')) {
      const input = el as HTMLInputElement;
      const type = (input.type || el.tagName).toLowerCase();
      if (['hidden', 'submit', 'button', 'reset', 'image', 'search'].includes(type) || input.disabled || !visible(el)) continue;
      if (type === 'radio') {
        const group = radios.get(input.name) ?? [];
        group.push(input);
        radios.set(input.name, group);
        continue;
      }
      const key = String(n++);
      el.setAttribute('data-js-field', key);
      const label = labelOf(el);
      if (el.getAttribute('role') === 'combobox') {
        // A custom dropdown: the answer goes into a hidden mirror input, which carries "required".
        const container = el.closest('.field, .form-group, [class*=field], [class*=question]');
        const mirrorRequired = !!container?.querySelector('input[required][aria-hidden], input[required][tabindex="-1"]');
        fields.push({ key, kind: 'select', label, name: input.name || el.id || '', required: mirrorRequired || el.getAttribute('aria-required') === 'true' || /[*✱]\s*$/.test(label), options: [], combobox: true });
        continue;
      }
      const kind = el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : ['email', 'tel', 'url', 'number', 'date', 'file', 'checkbox'].includes(type) ? type : 'text';
      const options = el.tagName === 'SELECT' ? [...(el as HTMLSelectElement).options].map((o) => text(o)).filter((o) => o && !/^(?:-+|select.*|choose.*|please select.*)$/i.test(o)) : [];
      fields.push({ key, kind, label, name: input.name ?? '', required: input.required || el.getAttribute('aria-required') === 'true' || /[*✱]\s*$/.test(label), options });
    }
    for (const [name, group] of radios) {
      const key = String(n++);
      group.forEach((r) => r.setAttribute('data-js-field', key));
      const set = group[0].closest('fieldset, [role=radiogroup], .field, .form-group');
      const legend = text(set?.querySelector('legend, label:not(:has(input)), .label')) || name;
      const required = group.some((r) => r.required) || set?.getAttribute('aria-required') === 'true' || /[*✱]\s*$/.test(legend);
      fields.push({ key, kind: 'radio', label: legend, name, required, options: group.map((r) => labelOf(r)) });
    }
    return { hasForm: true, fields } as never;
  });
}

/** Opens a custom dropdown and returns its options (they only exist while it is open). */
async function openCombobox(page: Page, key: string) {
  const input = page.locator(`[data-js-field="${key}"]`).first();
  await input.click();
  const listId = await input.getAttribute('aria-controls');
  const list = listId ? page.locator(`[id="${listId}"]`) : page.locator('[role=listbox]:visible').first();
  const options = list.locator('[role=option]');
  await options.first().waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
  return options;
}

/** Reads each custom dropdown's options by opening and closing it, so they can be answered like a <select>. */
async function readComboboxOptions(page: Page, fields: FormField[]): Promise<void> {
  for (const f of fields.filter((x) => x.combobox)) {
    const options = await openCombobox(page, f.key);
    f.options = (await options.allInnerTexts()).map((t) => t.trim()).filter(Boolean);
    await page.locator(`[data-js-field="${f.key}"]`).first().press('Escape').catch(() => {});
  }
}

/** The address of an application form embedded in an iframe (e.g. Greenhouse on a company's careers page). */
async function embeddedFormUrl(page: Page): Promise<string | null> {
  for (const frame of page.frames()) {
    if (frame === page.mainFrame() || !/^https?:/.test(frame.url())) continue;
    if (await frame.evaluate(() => !!document.querySelector('form input[type=file]')).catch(() => false)) return frame.url();
  }
  return null;
}

async function fill(page: Page, field: FormField, answer: FieldAnswer): Promise<void> {
  const loc = page.locator(`[data-js-field="${field.key}"]`);
  const v = answer.value;
  if (typeof v !== 'string') return loc.first().setInputFiles(v.file);
  if (field.combobox) {
    const options = await openCombobox(page, field.key);
    const count = await options.count();
    for (let i = 0; i < count; i++) {
      const option = options.nth(i);
      if (pickOption([((await option.innerText()) ?? '').trim()], v)) return option.click();
    }
    throw new Error(`Couldn't choose "${v}" for "${field.label}"`);
  }
  if (field.kind === 'select') return void (await loc.first().selectOption({ label: v }));
  if (field.kind === 'radio') {
    const count = await loc.count();
    for (let i = 0; i < count; i++) {
      const r = loc.nth(i);
      const label = await r.evaluate((el) => (el.closest('label')?.textContent ?? document.querySelector(`label[for="${(el as HTMLElement).id}"]`)?.textContent ?? '').trim());
      if (label && pickOption([label], v)) return r.check();
    }
    return;
  }
  if (field.kind === 'checkbox') return /^(?:yes|true|on)$/i.test(v) ? loc.first().check() : undefined;
  await loc.first().fill(v);
}

/** A visible button by its text: inside the application form when `inForm`, otherwise anywhere (Apply links). */
async function findButton(page: Page, pattern: RegExp, opts: { inForm: boolean; exclude?: RegExp }) {
  const scope = opts.inForm ? page.locator('[data-js-form]') : page;
  const candidates = scope.locator(opts.inForm ? 'button, input[type=submit], input[type=button]' : 'button, input[type=submit], a');
  const count = await candidates.count();
  const matches: Array<{ locator: ReturnType<typeof candidates.nth>; label: string; isSubmit: boolean }> = [];
  for (let i = 0; i < count; i++) {
    const c = candidates.nth(i);
    if (!(await c.isVisible().catch(() => false))) continue;
    const label = ((await c.textContent()) || (await c.getAttribute('value')) || (await c.getAttribute('aria-label')) || '').replace(/\s+/g, ' ').trim();
    if (!pattern.test(label) || FOREIGN_BUTTON.test(label) || (opts.exclude && opts.exclude.test(label))) continue;
    const type = ((await c.getAttribute('type')) ?? (opts.inForm ? 'submit' : '')).toLowerCase();
    matches.push({ locator: c, label, isSubmit: type === 'submit' });
  }
  // A real submit button (type=submit) wins over look-alikes.
  return matches.find((m) => m.isSubmit && /submit/i.test(m.label)) ?? matches.find((m) => m.isSubmit) ?? matches[0] ?? null;
}

async function blocked(page: Page): Promise<{ code: BlockerCode; evidence: string } | null> {
  return detectBlocker(await snapshotPage(page));
}

const screenshot = (page: Page) => page.screenshot({ fullPage: true }).catch(() => undefined);

/**
 * Main-frame navigations and form posts may only go to public addresses (no LAN, no router, not this app), and
 * never to LinkedIn, Indeed and the other sites Job Scraper must not automate. Returns the last refused URL.
 */
async function guardNetwork(page: Page, allowPrivate: boolean): Promise<{ refused: string | null }> {
  const state = { refused: null as string | null };
  const ok = new Map<string, Promise<boolean>>();
  const allowed = (url: URL) => {
    if (NEVER_FETCH.test(url.hostname)) return Promise.resolve(false);
    if (allowPrivate) return Promise.resolve(true);
    if (!isPublicHttpUrl(url)) return Promise.resolve(false);
    if (!ok.has(url.hostname)) ok.set(url.hostname, resolvesToPublicAddress(url.hostname).catch(() => false));
    return ok.get(url.hostname)!;
  };
  await page.route('**/*', async (route) => {
    const req = route.request();
    const sensitive = (req.isNavigationRequest() && req.frame() === page.mainFrame()) || req.method() !== 'GET';
    if (!sensitive) return route.fallback();
    let url: URL;
    try {
      url = new URL(req.url());
    } catch {
      return route.abort('blockedbyclient');
    }
    if (!/^https?:$/.test(url.protocol) || (await allowed(url))) return route.fallback();
    state.refused = url.href;
    return route.abort('blockedbyclient');
  });
  return state;
}

export async function runApplication(page: Page, input: ApplyInput): Promise<ApplyOutcome> {
  const { log } = input;
  const skip = async (code: BlockerCode | 'UNSUPPORTED_APPLICATION_FLOW', reason: string): Promise<ApplyOutcome> => ({ result: 'skipped', code, reason: `${reason}. No application was submitted.`, submitted: false, screenshot: await screenshot(page) });
  const abortCheck = () => {
    if (input.signal?.aborted) throw input.signal.reason ?? new Error('Aborted');
  };
  const guard = await guardNetwork(page, input.allowPrivateUrls === true);
  const refused = (): ApplyOutcome => ({ result: 'failed', code: 'UNSUPPORTED_APPLICATION_FLOW', reason: `Job Scraper doesn't open ${new URL(guard.refused!).hostname} (a private network address, or a site it must not automate). Apply on the site yourself.`, submitted: false });

  log(`Opening ${new URL(input.url).hostname}`);
  try {
    await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  } catch (err) {
    if (guard.refused) return refused();
    throw err;
  }
  if (guard.refused) return refused();
  await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {});
  let b = await blocked(page);
  if (b) return skip(b.code, `${b.evidence} on the job page`);

  // Some job pages only link to the form ("Apply for this job"), possibly in a new tab.
  if (!(await page.locator('form input[type=file]').first().count())) {
    const apply = await findButton(page, APPLY_LINK, { inForm: false });
    if (apply) {
      log(`Clicking "${short(apply.label)}"`);
      const href = await apply.locator.getAttribute('href');
      const target = href && !href.startsWith('#') ? new URL(href, page.url()) : null;
      if (target && /^https?:$/.test(target.protocol)) {
        await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      } else {
        const popup = page.waitForEvent('popup', { timeout: 3000 }).catch(() => null);
        await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), apply.locator.click()]);
        const tab = await popup;
        if (tab) {
          await tab.waitForLoadState('domcontentloaded').catch(() => {});
          const url = tab.url();
          await tab.close().catch(() => {});
          if (/^https?:/.test(url)) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        }
      }
      if (guard.refused) return refused();
      await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {});
      b = await blocked(page);
      if (b) return skip(b.code, `${b.evidence} after opening the application`);
    }
  }
  // The form may be embedded from the applicant-tracking system (an iframe): open it on its own.
  if (!(await page.locator('form input[type=file]').first().count())) {
    const embedded = await embeddedFormUrl(page);
    if (embedded) {
      log(`The application form comes from ${new URL(embedded).hostname}; opening it directly`);
      await page.goto(embedded, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
      if (guard.refused) return refused();
      await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {});
      b = await blocked(page);
      if (b) return skip(b.code, `${b.evidence} on the application form`);
    }
  }

  let previousStep = '';
  for (let step = 1; step <= MAX_STEPS; step++) {
    abortCheck();
    const { hasForm, fields } = await extractFields(page);
    if (hasForm) await readComboboxOptions(page, fields);
    if (!hasForm) return { result: 'failed', code: 'UNSUPPORTED_APPLICATION_FLOW', reason: 'No application form with a CV upload was found on the page. Apply on the site yourself.', submitted: false, screenshot: await screenshot(page) };
    const signature = fields.map((f) => `${f.kind}:${f.label}`).join('|');
    if (step > 1 && signature === previousStep) return skip('UNSUPPORTED_APPLICATION_FLOW', `The site didn't move past step ${step - 1}`);
    previousStep = signature;

    const ctx = { cvFile: input.cvFile, coverLetterFile: input.coverLetterFile, jobCountry: input.jobCountry };
    const { answers, rest } = mapFields(fields, input.profile, ctx);
    // Required privacy/terms boxes are ticked (the user approved applying); statements and opt-ins never are.
    for (const f of rest.filter((x) => x.kind === 'checkbox' && x.required && CONSENT.test(x.label) && !NOT_CONSENT.test(x.label))) answers.push({ key: f.key, value: 'yes', source: 'consent to apply', method: 'rule' });
    const remaining = rest.filter((f) => !answers.some((a) => a.key === f.key));
    answers.push(...(await mapWithAi(remaining, input.profile, input.ai, input.job, input.signal)));
    const missing = remaining.filter((f) => f.required && !answers.some((a) => a.key === f.key));
    if (missing.length) return skip('UNSUPPORTED_APPLICATION_FLOW', `Required question Job Scraper can't answer truthfully from your profile: "${short(missing[0].label.replace(/\s*[*✱]\s*$/, ''), 120)}"`);

    const filled: string[] = [];
    for (const a of answers) {
      const f = fields.find((x) => x.key === a.key)!;
      await fill(page, f, a);
      if (typeof a.value === 'string') filled.push(short(f.label.replace(/\s*[*✱]\s*$/, ''), 40));
      else log(`Uploaded ${a.value.file.split(/[\\/]/).pop()}`);
    }
    if (filled.length) log(`Filled ${filled.join(', ')}`);

    b = await blocked(page);
    if (b) return skip(b.code, `${b.evidence} in the form`);

    const next = await findButton(page, NEXT_BUTTON, { inForm: true, exclude: /submit/i });
    if (next) {
      log(`Step ${step} done; clicking "${short(next.label)}"`);
      await next.locator.click();
      await page.waitForTimeout(400);
      b = await blocked(page);
      if (b) return skip(b.code, `${b.evidence} on step ${step + 1}`);
      continue;
    }

    const submit = await findButton(page, SUBMIT_BUTTON, { inForm: true });
    if (!submit) return { result: 'failed', code: 'UNSUPPORTED_APPLICATION_FLOW', reason: "Couldn't find the form's Submit button. Apply on the site yourself.", submitted: false, screenshot: await screenshot(page) };
    b = await blocked(page);
    if (b) return skip(b.code, `${b.evidence} before submitting`);
    // The browser's own check of required fields: if it fails, nothing would be sent anyway.
    const invalid = await page.evaluate(() => {
      const form = document.querySelector<HTMLFormElement>('[data-js-form]');
      if (!form || form.checkValidity()) return null;
      const el = form.querySelector<HTMLElement>(':invalid');
      const container = el?.closest('label') ?? el?.closest('.field, .form-group, [class*=field], fieldset')?.querySelector('label, legend');
      return (container?.textContent || el?.getAttribute('name') || 'a required field').replace(/\s+/g, ' ').replace(/\s*[*✱]\s*$/, '').trim();
    });
    if (invalid) return skip('UNSUPPORTED_APPLICATION_FLOW', `The form still needs "${short(invalid, 80)}", which Job Scraper can't fill truthfully`);

    const before = { path: new URL(page.url()).pathname, text: await page.evaluate(() => document.body?.innerText ?? '').catch(() => '') };
    let sent = false;
    let postResponse: Response | null = null;
    const onRequest = (r: Request) => {
      if (r.method() !== 'GET' || (r.isNavigationRequest() && r.frame() === page.mainFrame())) sent = true;
    };
    const onResponse = (r: Response) => {
      if (r.request().method() !== 'GET') postResponse = r;
    };
    page.on('request', onRequest);
    page.on('response', onResponse);
    // From here on, the application may have been sent: it is never submitted again automatically.
    input.onSubmitting();
    log(`Submitting the application ("${short(submit.label)}")`);
    await submit.locator.click();
    await Promise.race([page.waitForURL((u) => u.pathname !== before.path, { timeout: 20_000 }), page.waitForResponse((r) => r.request().method() !== 'GET', { timeout: 20_000 })]).catch(() => {});
    await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(800);
    page.off('request', onRequest);
    page.off('response', onResponse);

    if (!sent) {
      // The click sent nothing (the site's own script refused it): honest skip, nothing went out.
      return skip('UNSUPPORTED_APPLICATION_FLOW', "The site didn't accept the form (it sent nothing), likely because of a question Job Scraper can't answer");
    }
    const after = { path: new URL(page.url()).pathname, text: await page.evaluate(() => document.body?.innerText ?? '').catch(() => '') };
    const formGone = !(await page.locator('[data-js-form]').first().isVisible().catch(() => false));
    const phrase = after.text.match(CONFIRMATION_TEXT)?.[0];
    const newPhrase = phrase && (!before.text.includes(phrase) || formGone) ? phrase : null;
    const newUrl = after.path !== before.path && CONFIRMATION_URL.test(after.path) && !CONFIRMATION_URL.test(before.path);
    const status = (postResponse as Response | null)?.status() ?? null;
    if ((newPhrase || newUrl) && (status === null || status < 400)) {
      const shot = await page.screenshot({ fullPage: true });
      log('The site confirmed the application');
      return { result: 'applied', evidence: `${newPhrase ? `“${newPhrase}”` : 'Confirmation page'} at ${page.url()}${status ? ` (HTTP ${status})` : ''}`, screenshot: shot };
    }
    b = await blocked(page);
    const reason = b
      ? `${b.evidence} appeared after submitting, and the site did not confirm the application`
      : status && status >= 400
        ? `The site answered the submission with an error (HTTP ${status}) and did not confirm it`
        : 'The site did not confirm the application';
    return { result: 'failed', code: 'NO_CONFIRMATION', reason: `${reason}. Check your email or the site before applying again.`, submitted: true, screenshot: await screenshot(page) };
  }
  return skip('UNSUPPORTED_APPLICATION_FLOW', `The application has more than ${MAX_STEPS} steps`);
}
