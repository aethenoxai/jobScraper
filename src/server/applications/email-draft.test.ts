import { describe, expect, it } from 'vitest';
import { emptyProfile } from '../profile/model';
import { buildEmailDraft, EmailDraftSchema } from './email-draft';

const profile = () => {
  const p = emptyProfile();
  p.personal.fullName = 'Asha Rao';
  p.personal.email = 'asha@example.com';
  return p;
};
const letter = { greeting: 'Dear Acme hiring team,', paragraphs: ['I am applying for the role.'], closing: 'Kind regards,', method: 'offline' as const };

describe('buildEmailDraft', () => {
  it('addresses the apply email with a clear subject and the cover letter as the body', () => {
    const d = buildEmailDraft({ jobTitle: 'Backend Engineer', company: 'Acme', applyEmail: 'jobs@acme.example' }, profile(), letter)!;
    expect(d).toEqual({ to: 'jobs@acme.example', subject: 'Application for Backend Engineer – Asha Rao', body: expect.stringContaining('I am applying for the role.'), attachCoverLetter: false });
    expect(d.body).toMatch(/Kind regards,\nAsha Rao\nasha@example\.com/);
    expect(EmailDraftSchema.safeParse(d).success).toBe(true);
  });

  it('keeps job text from breaking the subject line', () => {
    const d = buildEmailDraft({ jobTitle: 'Engineer\r\nBcc: evil@example.com', company: 'Acme', applyEmail: 'jobs@acme.example' }, profile(), letter)!;
    expect(d.subject).not.toMatch(/[\r\n]/);
  });

  it('has no draft when the job takes no email applications', () => {
    expect(buildEmailDraft({ jobTitle: 'X', company: 'Acme', applyEmail: null }, profile(), letter)).toBeNull();
    expect(buildEmailDraft({ jobTitle: 'X', company: 'Acme', applyEmail: 'not an email' }, profile(), letter)).toBeNull();
  });

  it('rejects drafts edited into several recipients or header breaks', () => {
    expect(EmailDraftSchema.safeParse({ to: 'a@example.com, b@example.com', subject: 's', body: 'b', attachCoverLetter: false }).success).toBe(false);
    expect(EmailDraftSchema.safeParse({ to: 'a@example.com', subject: 's\nBcc: x@example.com', body: 'b', attachCoverLetter: false }).success).toBe(false);
  });
});
