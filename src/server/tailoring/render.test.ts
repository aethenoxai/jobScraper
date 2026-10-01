import { afterAll, describe, expect, it } from 'vitest';
import { extractCvText } from '../profile/cv-text';
import { assignIds, emptyProfile, type ProfileData } from '../profile/model';
import type { TailoredCv } from './model';
import { createPdfRenderer, cvFilename, formatRange, renderCoverLetterHtml, renderCvHtml } from './render';

function profile(): ProfileData {
  const p = emptyProfile();
  p.personal = { fullName: 'Asha <Rao>', email: 'asha@example.com', phone: '+91 98765 43210', location: 'Bengaluru, India', country: 'India', timezone: null, links: [{ id: 'l1', label: 'LinkedIn', url: 'linkedin.com/in/asha' }] };
  p.headline = 'Full Stack Developer';
  p.experience = [{ id: 'exp_a', title: 'Software Engineer', company: 'Fictional Labs', location: 'Bengaluru', startDate: '2023-01', endDate: null, current: true, summary: null, bullets: [{ id: 'bul_1', text: 'Built X' }] }];
  p.education = [{ id: 'edu_1', institution: 'Example Uni', degree: 'B.Tech', field: 'Computer Science', startDate: '2017', endDate: '2021', grade: null }];
  return assignIds(p);
}
const cv: TailoredCv = {
  headline: 'Full Stack Developer',
  summary: 'Builds reliable web products.',
  skills: ['React', 'Node.js'],
  experience: [{ id: 'exp_a', bullets: [{ text: 'Shipped a billing dashboard used by 1,200 customers', sources: ['bul_1'] }] }],
  projects: [],
  education: ['edu_1'],
  certifications: [],
  languages: [],
  sectionOrder: ['summary', 'skills', 'experience', 'projects', 'education', 'certifications', 'languages'],
  targeted: [],
  intensity: 'standard',
  method: 'ai',
};

describe('renderCvHtml', () => {
  const html = renderCvHtml(profile(), cv);

  it('renders facts from the master profile and escapes text', () => {
    expect(html).toContain('Asha &lt;Rao&gt;');
    expect(html).toContain('Software Engineer');
    expect(html).toContain('Fictional Labs');
    expect(html).toContain('Jan 2023 – Present');
    expect(html).toContain('Shipped a billing dashboard used by 1,200 customers');
    expect(html).toContain('B.Tech, Computer Science');
  });

  it('uses standard headings in the chosen order and no tables or images (ATS-safe)', () => {
    expect(html.indexOf('Professional Summary')).toBeLessThan(html.indexOf('Experience'));
    expect(html).not.toMatch(/<table|<img/);
  });

  it('formats date ranges', () => {
    expect(formatRange('2017', '2021', false)).toBe('2017 – 2021');
    expect(formatRange('2021-07', '2022-12', false)).toBe('Jul 2021 – Dec 2022');
    expect(formatRange(null, null, false)).toBe('');
  });
});

describe('renderCoverLetterHtml', () => {
  it('renders the letter with the contact details from the profile, escaped, line breaks kept', () => {
    const html = renderCoverLetterHtml(profile(), { greeting: 'Dear Acme <team>,', paragraphs: ['First line.\n• A point'], closing: 'Kind regards,', method: 'offline' }, new Date(2026, 9, 1));
    expect(html).toContain('Asha &lt;Rao&gt;');
    expect(html).toContain('asha@example.com');
    expect(html).toContain('Dear Acme &lt;team&gt;,');
    expect(html).toContain('First line.<br>• A point');
    expect(html).toContain('1 October 2026');
  });
});

describe('cvFilename', () => {
  it('builds a safe, descriptive name', () => {
    expect(cvFilename('Company A / Inc.', 'Senior Full-Stack Engineer (Remote)')).toBe('Company_A_Inc_Senior_Full-Stack_Engineer_Remote_CV.pdf');
  });
});

describe('PDF rendering', () => {
  const renderer = createPdfRenderer();
  afterAll(() => renderer.close());

  it('produces a PDF whose text can be read back (ATS-readable)', async () => {
    const pdf = await renderer.render(renderCvHtml(profile(), cv));
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const { text } = await extractCvText(pdf);
    expect(text).toContain('Shipped a billing dashboard used by 1,200 customers');
    expect(text).toContain('Fictional Labs');
  }, 60_000);
});

describe('PDF renderer recovery', () => {
  function fakeBrowser() {
    const listeners: Record<string, () => void> = {};
    const browser = {
      newPage: async () => ({ route: async () => {}, setContent: async () => {}, pdf: async () => Buffer.from('%PDF-fake'), close: async () => {} }),
      close: async () => {},
      on: (event: string, fn: () => void) => void (listeners[event] = fn),
      disconnect: () => listeners.disconnected?.(),
    };
    return browser;
  }

  it('launches again after a failed launch (e.g. Chromium installed afterwards)', async () => {
    let launches = 0;
    const r = createPdfRenderer({
      launch: async () => {
        launches++;
        if (launches === 1) throw new Error("Executable doesn't exist");
        return fakeBrowser() as never;
      },
    });
    await expect(r.render('<p>x</p>')).rejects.toThrow(/Executable/);
    expect((await r.render('<p>x</p>')).toString()).toBe('%PDF-fake');
    expect(launches).toBe(2);
    await r.close();
  });

  it('launches a new browser after the old one crashed', async () => {
    const browsers: Array<ReturnType<typeof fakeBrowser>> = [];
    const r = createPdfRenderer({ launch: async () => (browsers.push(fakeBrowser()), browsers.at(-1) as never) });
    await r.render('<p>1</p>');
    browsers[0].disconnect();
    await r.render('<p>2</p>');
    expect(browsers).toHaveLength(2);
  });

  it('closes cleanly even if the browser never started', async () => {
    const r = createPdfRenderer({ launch: async () => Promise.reject(new Error('no chromium')) });
    await r.render('<p>x</p>').catch(() => {});
    await expect(r.close()).resolves.toBeUndefined();
  });
});
