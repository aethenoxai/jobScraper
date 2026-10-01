'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { redirect } from 'next/navigation';
import { isNamedError } from '@/lib/format';
import { getAppContext } from '@/server/context';
import { EmailDraftSchema, type EmailDraft } from '@/server/applications/email-draft';
import { CoverLetterSchema, type CoverLetter } from '@/server/tailoring/cover-letter';
import { TailoredCvSchema, type TailoredCv } from '@/server/tailoring/model';
import { TEMPLATES, type CvTemplate } from '@/server/tailoring/render';

function refresh(id: number) {
  revalidatePath('/applications');
  revalidatePath(`/applications/${id}`);
  revalidatePath('/');
}

/** A change that can't be made: the application page says why (its reason, e.g. "the tailored CV is not ready yet"). */
function refuse(id: number, err: Error): never {
  refresh(id);
  if (err.name === 'ApplicationNotFoundError') redirect('/applications?msg=gone');
  redirect(`/applications/${id}?${new URLSearchParams({ error: err.message.slice(0, 300) })}`);
}

/** Runs a status change; a change that isn't allowed (e.g. from a stale page) shows the reason instead. */
function change(id: number, run: () => void) {
  try {
    run();
  } catch (err) {
    if (!isNamedError(err, 'InvalidTransitionError', 'ApplicationNotFoundError')) throw err;
    refuse(id, err);
  }
  refresh(id);
}

export async function markAppliedAction(id: number, formData: FormData): Promise<void> {
  change(id, () => getAppContext().apps.markApplied(id, String(formData.get('note') ?? '')));
}

export async function withdrawAction(id: number): Promise<void> {
  change(id, () => getAppContext().apps.withdraw(id));
}

export async function retryPreparationAction(id: number): Promise<void> {
  change(id, () => getAppContext().apps.retryPreparation(id));
}

export async function rerenderAction(id: number): Promise<void> {
  change(id, () => getAppContext().apps.rerender(id));
}

export async function deleteApplicationAction(id: number): Promise<void> {
  try {
    await getAppContext().apps.remove(id);
  } catch (err) {
    // Already deleted (e.g. a double click): show the list as it is now.
    if (!isNamedError(err, 'ApplicationNotFoundError')) throw err;
  }
  revalidatePath('/applications');
  revalidatePath('/feed');
  revalidatePath('/');
  redirect('/applications?msg=deleted');
}

export interface SaveCvResult {
  ok: boolean;
  message: string;
  problems: string[];
}

/** Saves an edited tailored CV if it is still grounded in the profile, then the worker renders the PDF again. */
const FIELD_HELP: Record<string, string> = {
  skills: 'at most 40 skills',
  summary: 'the summary may be at most 1,500 characters',
  headline: 'the headline may be at most 200 characters',
  text: 'a bullet is empty or longer than 600 characters',
};

export async function saveCvAction(id: number, cv: TailoredCv): Promise<SaveCvResult> {
  const parsed = TailoredCvSchema.safeParse(cv);
  if (!parsed.success) {
    const problems = [...new Set(parsed.error.issues.map((i) => FIELD_HELP[String(i.path.at(-1))] ?? FIELD_HELP[String(i.path[0])] ?? 'some text is too long or empty'))];
    return { ok: false, message: 'Not saved:', problems };
  }
  let result;
  try {
    result = await getAppContext().apps.saveEditedCv(id, parsed.data);
  } catch (err) {
    if (!isNamedError(err, 'InvalidTransitionError', 'ApplicationNotFoundError')) throw err;
    return { ok: false, message: `Not saved: ${err.message}.`, problems: [] };
  }
  refresh(id);
  return result.ok
    ? { ok: true, message: 'Saved. The PDF is being updated…', problems: [] }
    : { ok: false, message: 'Not saved: the CV may only use facts from your profile.', problems: result.violations.map((v) => v.message) };
}

export async function setTemplateAction(id: number, formData: FormData): Promise<void> {
  const template = String(formData.get('template')) as CvTemplate;
  if (!TEMPLATES.includes(template)) return;
  try {
    await getAppContext().apps.setTemplate(id, template);
  } catch (err) {
    if (!isNamedError(err, 'InvalidTransitionError', 'ApplicationNotFoundError')) throw err;
    refuse(id, err);
  }
  refresh(id);
}

export interface ActionResult {
  ok: boolean;
  message: string;
  problems: string[];
}

/** The user pressed Send on the application email (nothing is ever sent before this). */
export async function sendEmailAction(id: number, draft: EmailDraft): Promise<ActionResult> {
  const parsed = EmailDraftSchema.safeParse(draft);
  if (!parsed.success) return { ok: false, message: 'Not sent:', problems: [...new Set(parsed.error.issues.map((i) => (i.path[0] === 'to' ? 'enter one valid email address' : i.path[0] === 'subject' ? 'the subject must be one line (at most 200 characters)' : 'the message is empty or too long')))] };
  try {
    await getAppContext().apps.sendEmail(id, parsed.data);
  } catch (err) {
    if (!isNamedError(err, 'InvalidTransitionError', 'ApplicationNotFoundError')) throw err;
    return { ok: false, message: `Not sent: ${err.message}.`, problems: [] };
  }
  refresh(id);
  return { ok: true, message: 'Sending… this page updates when the mail server accepts it.', problems: [] };
}

export async function resolveUncertainEmailAction(id: number, outcome: 'was-sent' | 'send-again'): Promise<void> {
  if (outcome !== 'was-sent' && outcome !== 'send-again') return;
  try {
    await getAppContext().apps.resolveUncertainEmail(id, outcome);
  } catch (err) {
    if (!isNamedError(err, 'InvalidTransitionError', 'ApplicationNotFoundError')) throw err;
    refuse(id, err);
  }
  refresh(id);
}

/** Saves an edited cover letter if it only uses facts from the profile. */
export async function saveCoverLetterAction(id: number, letter: CoverLetter): Promise<ActionResult> {
  const parsed = CoverLetterSchema.safeParse(letter);
  if (!parsed.success) return { ok: false, message: 'Not saved: every paragraph needs text (at most 1,500 characters each, up to 6 paragraphs).', problems: [] };
  const { apps, matching } = getAppContext();
  const app = apps.get(id);
  if (!app) return { ok: false, message: 'This application no longer exists.', problems: [] };
  try {
    const result = await apps.saveEditedCoverLetter(id, parsed.data, { title: app.jobTitle, company: app.company, description: app.jobId ? matching.descriptionFor(app.jobId) : '' });
    refresh(id);
    return result.ok
      ? { ok: true, message: 'Saved. The PDF is being updated…', problems: [] }
      : { ok: false, message: 'Not saved: the letter may only use facts from your profile.', problems: result.violations.map((v) => v.message) };
  } catch (err) {
    if (!isNamedError(err, 'InvalidTransitionError', 'ApplicationNotFoundError')) throw err;
    return { ok: false, message: `Not saved: ${err.message}.`, problems: [] };
  }
}

/** The user pressed "Apply in browser". */
export async function applyInBrowserAction(id: number): Promise<void> {
  change(id, () => getAppContext().apps.applyInBrowser(id));
}

/** Cancels a website application that is still waiting to start (e.g. for tomorrow's daily limit). */
export async function cancelBrowserApplyAction(id: number): Promise<void> {
  change(id, () => getAppContext().apps.cancelBrowserApply(id));
}

const TrackStatus = z.enum(['APPLIED', 'INTERVIEW', 'OFFER', 'REJECTED', 'WITHDRAWN', 'EXPIRED', 'READY']);

export async function setStatusAction(id: number, formData: FormData): Promise<void> {
  const to = TrackStatus.safeParse(formData.get('status'));
  if (!to.success) return;
  change(id, () => getAppContext().apps.setStatus(id, to.data, String(formData.get('note') ?? '')));
}

export async function addNoteAction(id: number, formData: FormData): Promise<void> {
  change(id, () => getAppContext().apps.addNote(id, String(formData.get('note') ?? '')));
}

export async function addInterviewAction(id: number, formData: FormData): Promise<void> {
  const at = new Date(String(formData.get('at') ?? ''));
  const kind = z.enum(['phone', 'video', 'onsite', 'other']).catch('other').parse(formData.get('kind'));
  if (Number.isNaN(at.getTime())) return;
  change(id, () => getAppContext().apps.addInterview(id, { at, kind, details: String(formData.get('details') ?? '').trim() || null }));
}

export async function setOfferAction(id: number, formData: FormData): Promise<void> {
  const deadline = formData.get('deadline') ? new Date(String(formData.get('deadline'))) : null;
  change(id, () =>
    getAppContext().apps.setOffer(id, {
      salary: String(formData.get('salary') ?? '').trim() || null,
      deadline: deadline && !Number.isNaN(deadline.getTime()) ? deadline : null,
      notes: String(formData.get('notes') ?? '').trim() || null,
    }),
  );
}

/** The user confirmed (or dismissed) the status an email suggested. */
export async function resolveSuggestionAction(id: number, messageId: number, apply: boolean): Promise<void> {
  const { tracking } = getAppContext();
  change(id, () => (apply ? tracking.applySuggestion(messageId) : tracking.dismissSuggestion(messageId)));
}
