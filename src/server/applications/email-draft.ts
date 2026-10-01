/** The email for jobs that take applications by email (PRD §24): the user reviews and edits it before sending. */
import { z } from 'zod';
import type { ProfileData } from '../profile/model';
import { coverLetterText, type CoverLetter } from '../tailoring/cover-letter';

export const EmailDraftSchema = z.object({
  /** Exactly one recipient: the address the job asked applications to go to (or the user's correction). */
  to: z.string().trim().email(),
  subject: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((s) => !/[\r\n]/.test(s), 'The subject must be one line'),
  body: z.string().trim().min(1).max(20_000),
  /** Also attach the cover letter as a PDF (the letter is in the body either way). */
  attachCoverLetter: z.boolean(),
});
export type EmailDraft = z.infer<typeof EmailDraftSchema>;

const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();

export function buildEmailDraft(app: { jobTitle: string; company: string; applyEmail: string | null }, profile: ProfileData, letter: CoverLetter): EmailDraft | null {
  if (!app.applyEmail || !z.string().email().safeParse(app.applyEmail.trim()).success) return null;
  const name = profile.personal.fullName?.trim();
  return {
    to: app.applyEmail.trim(),
    subject: oneLine(`Application for ${app.jobTitle}${name ? ` – ${name}` : ''}`).slice(0, 200),
    body: coverLetterText(letter, profile),
    attachCoverLetter: false,
  };
}
