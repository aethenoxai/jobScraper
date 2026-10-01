import { describe, expect, it } from 'vitest';
import { couldBelong, matchMessage, siteDomain, type Candidate, type IncomingMessage } from './match';

const cand = (id: number, over: Partial<Candidate> = {}): Candidate => ({ id, company: 'Acme Payments', jobTitle: 'Backend Engineer', applyEmail: null, applicationUrl: null, sourceUrl: 'https://boards.greenhouse.io/acme/jobs/1', sentMessageIds: [], ...over });
const msg = (over: Partial<IncomingMessage> = {}): IncomingMessage => ({ from: 'someone@gmail.com', fromName: '', subject: 'Hello', text: '', inReplyTo: null, references: [], ...over });

describe('siteDomain', () => {
  it('reduces hosts to the organisation’s domain', () => {
    expect(siteDomain('jobs.acme.example')).toBe('acme.example');
    expect(siteDomain('careers.acme.co.uk')).toBe('acme.co.uk');
    expect(siteDomain('acme.com')).toBe('acme.com');
  });
});

describe('matchMessage', () => {
  it('a reply to the application email is certain', () => {
    const r = matchMessage(msg({ inReplyTo: '<abc@example.com>', subject: 'Re: Application' }), [cand(1, { sentMessageIds: ['<abc@example.com>'] }), cand(2)]);
    expect(r).toMatchObject({ applicationId: 1, matchedBy: 'thread' });
  });

  it('matches the company’s own domain (from the apply address or the job’s site)', () => {
    expect(matchMessage(msg({ from: 'talent@acme.example', subject: 'Your application' }), [cand(1, { applyEmail: 'careers@acme.example' })])).toMatchObject({ applicationId: 1, matchedBy: 'domain' });
    expect(matchMessage(msg({ from: 'no-reply@acme.example', subject: 'Next steps with Acme' }), [cand(1, { applicationUrl: 'https://jobs.acme.example/123' })])).toMatchObject({ applicationId: 1, matchedBy: 'domain' });
  });

  it('matches an ATS sender that names the company', () => {
    const r = matchMessage(msg({ from: 'no-reply@us.greenhouse-mail.io', subject: 'Thank you for applying to Acme Payments' }), [cand(1), cand(2, { company: 'Globex' })]);
    expect(r).toMatchObject({ applicationId: 1, matchedBy: 'ats+company' });
  });

  it('never matches on the company name alone (newsletters, news)', () => {
    expect(matchMessage(msg({ from: 'digest@news.test', subject: 'Acme Payments raises $50M' }), [cand(1)])).toBeNull();
  });

  it('two applications at one company: the job title decides, otherwise no match', () => {
    const two = [cand(1, { applyEmail: 'careers@acme.example' }), cand(2, { applyEmail: 'careers@acme.example', jobTitle: 'Data Analyst' })];
    expect(matchMessage(msg({ from: 'talent@acme.example', subject: 'Your Data Analyst application' }), two)).toMatchObject({ applicationId: 2 });
    expect(matchMessage(msg({ from: 'talent@acme.example', subject: 'Your application' }), two)).toBeNull();
  });

  it('ignores job boards and ATS hosts as company domains', () => {
    expect(matchMessage(msg({ from: 'alerts@greenhouse.io', subject: 'New jobs' }), [cand(1)])).toBeNull();
  });
});

const envOf = (m: IncomingMessage) => ({ from: m.from, fromName: m.fromName, subject: m.subject, inReplyTo: m.inReplyTo, references: m.references });

describe('only mail about an application is opened and matched (M8 review C1, I5, minor 1)', () => {
  it('a free-mail apply address matches only that exact sender, never the whole provider', () => {
    const c = [cand(1, { applyEmail: 'AcmeHiring@gmail.com' })];
    const mom = msg({ from: 'mom@gmail.com', subject: 'Saturday', text: 'Unfortunately I cannot make it on Saturday.' });
    expect(couldBelong(envOf(mom), c)).toBe(false);
    expect(matchMessage(mom, c)).toBeNull();
    const hr = msg({ from: 'acmehiring@gmail.com', subject: 'Re: your application', text: 'Can we schedule a call?' });
    expect(couldBelong(envOf(hr), c)).toBe(true);
    expect(matchMessage(hr, c)).toMatchObject({ applicationId: 1 });
  });

  it('shared hosts in job links (Google Forms, GitHub, Notion…) are not the employer', () => {
    const forms = [cand(1, { applicationUrl: 'https://docs.google.com/forms/d/e/xyz/viewform', sourceUrl: 'https://github.com/acme/jobs/issues/1' })];
    const invite = msg({ from: 'calendar-notification@google.com', subject: 'Invitation: Video call link', text: 'Join with Google Meet' });
    const gh = msg({ from: 'notifications@github.com', subject: '[acme/jobs] New comment', text: 'Someone commented on your application issue' });
    for (const m of [invite, gh]) {
      expect(couldBelong(envOf(m), forms)).toBe(false);
      expect(matchMessage(m, forms)).toBeNull();
    }
  });

  it("a mail from the company's domain needs a recruiting cue (newsletters and receipts are not about the application)", () => {
    const c = [cand(1, { applyEmail: 'jobs@acme.example' })];
    expect(matchMessage(msg({ from: 'news@acme.example', subject: 'Acme quarterly newsletter: our new product', text: 'Read about our launch.' }), c)).toBeNull();
    expect(matchMessage(msg({ from: 'billing@acme.example', subject: 'Your invoice', text: 'Thanks for your payment.' }), c)).toBeNull();
    expect(matchMessage(msg({ from: 'priya@acme.example', subject: 'Quick chat?', text: 'Hi Asha, are you free on Tuesday for a call about the role?' }), c)).toMatchObject({ applicationId: 1, matchedBy: 'domain' });
  });

  it('within one company, the job title named in the mail beats the domain', () => {
    const a = cand(1, { applyEmail: 'jobs@acme.example', jobTitle: 'Backend Engineer' });
    const b = cand(2, { jobTitle: 'Data Analyst', sourceUrl: 'https://boards.greenhouse.io/acme/jobs/2' });
    expect(matchMessage(msg({ from: 'recruiter@acme.example', subject: 'Interview for Data Analyst at Acme Payments' }), [a, b])).toMatchObject({ applicationId: 2 });
  });

  it('job-board and social notifications are only opened when they name the company', () => {
    const c = [cand(1)];
    expect(couldBelong({ from: 'jobalerts-noreply@linkedin.com', fromName: 'LinkedIn Job Alerts', subject: '30 new jobs for Backend Engineer', inReplyTo: null, references: [] }, c)).toBe(false);
    expect(couldBelong({ from: 'no-reply@us.greenhouse-mail.io', fromName: 'Acme Payments Hiring', subject: 'Thank you for applying', inReplyTo: null, references: [] }, c)).toBe(true);
    expect(couldBelong({ from: 'no-reply@ashbyhq.com', fromName: '', subject: 'Your application to Acme Payments', inReplyTo: null, references: [] }, c)).toBe(true);
  });
});
