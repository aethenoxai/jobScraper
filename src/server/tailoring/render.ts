/**
 * Renders a tailored CV to ATS-safe HTML and PDF. Facts (name, contacts, employers, titles, dates, degrees)
 * always come from the master profile; only the tailored wording and ordering come from the TailoredCv.
 */
import type { Browser } from 'playwright';
import type { ProfileData } from '../profile/model';
import type { CoverLetter } from './cover-letter';
import type { CvSection, TailoredCv } from './model';

const esc = (s: string | null | undefined) => (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDate(d: string | null): string {
  if (!d) return '';
  const [y, m] = d.split('-');
  return m ? `${MONTHS[Number(m) - 1]} ${y}` : y;
}

export function formatRange(start: string | null, end: string | null, current: boolean): string {
  const s = formatDate(start);
  const e = current ? 'Present' : formatDate(end);
  return s && e ? `${s} – ${e}` : s || e;
}

export const TEMPLATES = ['classic', 'modern'] as const;
export type CvTemplate = (typeof TEMPLATES)[number];

const STYLES: Record<CvTemplate, string> = {
  classic: `body{font-family:Georgia,"Times New Roman",serif;font-size:10.5pt;color:#111;line-height:1.35;margin:0}
h1{font-size:20pt;margin:0}h2{font-size:11pt;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #444;margin:14px 0 6px;padding-bottom:2px}
.headline{font-size:11.5pt;margin:2px 0}.contact{font-size:9.5pt;color:#333}.role{display:flex;justify-content:space-between;font-weight:bold;margin-top:6px}
.sub{color:#333;font-style:italic}ul{margin:3px 0 0 18px;padding:0}li{margin:1px 0}p{margin:3px 0}`,
  modern: `body{font-family:"Helvetica Neue",Arial,sans-serif;font-size:10pt;color:#1a1a1a;line-height:1.4;margin:0}
h1{font-size:22pt;margin:0;font-weight:700}h2{font-size:10.5pt;text-transform:uppercase;letter-spacing:.08em;color:#1f4e79;margin:14px 0 4px}
.headline{font-size:12pt;color:#1f4e79;margin:2px 0}.contact{font-size:9pt;color:#444}.role{display:flex;justify-content:space-between;font-weight:600;margin-top:6px}
.sub{color:#555}ul{margin:3px 0 0 16px;padding:0}li{margin:1px 0}p{margin:3px 0}`,
};

const HEADINGS: Record<CvSection, string> = {
  summary: 'Professional Summary',
  skills: 'Skills',
  experience: 'Experience',
  projects: 'Projects',
  education: 'Education',
  certifications: 'Certifications',
  languages: 'Languages',
};

export function renderCvHtml(profile: ProfileData, cv: TailoredCv, template: CvTemplate = 'classic'): string {
  const p = profile.personal;
  const contact = [p.email, p.phone, p.location, ...p.links.map((l) => l.url)].filter(Boolean).map(esc).join(' · ');
  const bullets = (items: Array<{ text: string }>) => (items.length ? `<ul>${items.map((b) => `<li>${esc(b.text)}</li>`).join('')}</ul>` : '');

  const sections: Record<CvSection, () => string> = {
    summary: () => (cv.summary ? `<p>${esc(cv.summary)}</p>` : ''),
    skills: () => (cv.skills.length ? `<p>${cv.skills.map(esc).join(' · ')}</p>` : ''),
    experience: () =>
      cv.experience
        .map((item) => {
          const e = profile.experience.find((x) => x.id === item.id);
          if (!e) return '';
          return `<div><div class="role"><span>${esc(e.title)}${e.company ? ` — ${esc(e.company)}` : ''}</span><span>${esc(formatRange(e.startDate, e.endDate, e.current))}</span></div>${e.location ? `<div class="sub">${esc(e.location)}</div>` : ''}${bullets(item.bullets)}</div>`;
        })
        .join(''),
    projects: () =>
      cv.projects
        .map((item) => {
          const pr = profile.projects.find((x) => x.id === item.id);
          if (!pr) return '';
          return `<div><div class="role"><span>${esc(pr.name)}</span><span>${esc(pr.url)}</span></div>${pr.description ? `<p>${esc(pr.description)}</p>` : ''}${bullets(item.bullets)}</div>`;
        })
        .join(''),
    education: () =>
      cv.education
        .map((id) => profile.education.find((x) => x.id === id))
        .filter((e) => !!e)
        .map((e) => `<div class="role"><span>${esc([e!.degree, e!.field].filter(Boolean).join(', '))}${e!.institution ? ` — ${esc(e!.institution)}` : ''}</span><span>${esc(formatRange(e!.startDate, e!.endDate, false))}</span></div>${e!.grade ? `<div class="sub">${esc(e!.grade)}</div>` : ''}`)
        .join(''),
    certifications: () =>
      bullets(cv.certifications.map((id) => profile.certifications.find((c) => c.id === id)).filter((c) => !!c).map((c) => ({ text: [c!.name, c!.issuer, c!.date].filter(Boolean).join(' — ') }))),
    languages: () =>
      cv.languages.length ? `<p>${cv.languages.map((id) => profile.languages.find((l) => l.id === id)).filter((l) => !!l).map((l) => esc(l!.proficiency ? `${l!.name} (${l!.proficiency})` : l!.name)).join(' · ')}</p>` : '',
  };

  const body = cv.sectionOrder
    .map((s) => ({ s, html: sections[s]() }))
    .filter((x) => x.html)
    .map((x) => `<section><h2>${HEADINGS[x.s]}</h2>${x.html}</section>`)
    .join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(p.fullName)} – CV</title><style>@page{size:A4;margin:16mm 16mm}${STYLES[template]}</style></head><body><header><h1>${esc(p.fullName)}</h1>${cv.headline ? `<div class="headline">${esc(cv.headline)}</div>` : ''}<div class="contact">${contact}</div></header>${body}</body></html>`;
}

/** A cover letter page in the same style as the CV (PDF attachment). */
export function renderCoverLetterHtml(profile: ProfileData, letter: CoverLetter, date: Date, template: CvTemplate = 'classic'): string {
  const p = profile.personal;
  const contact = [p.email, p.phone, p.location].filter(Boolean).map(esc).join(' · ');
  const para = (t: string) => `<p>${esc(t).replace(/\n/g, '<br>')}</p>`;
  const when = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(p.fullName)} – Cover letter</title><style>@page{size:A4;margin:22mm 22mm}${STYLES[template]}p{margin:0 0 10px}</style></head><body><header><h1>${esc(p.fullName)}</h1><div class="contact">${contact}</div></header><p style="margin-top:18px">${esc(when)}</p>${para(letter.greeting)}${letter.paragraphs.map(para).join('')}<p>${esc(letter.closing)}<br>${esc(p.fullName)}</p></body></html>`;
}

export function cvFilename(company: string, title: string, suffix = 'CV'): string {
  const part = (s: string) => s.replace(/[^\p{L}\p{N}-]+/gu, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  return `${[part(company), part(title)].filter(Boolean).join('_').slice(0, 120)}_${suffix}.pdf`;
}

export interface PdfRenderer {
  render(html: string): Promise<Buffer>;
  close(): Promise<void>;
}

/**
 * One shared headless Chromium for all renders, started on first use. A failed launch or a browser that crashed
 * or disconnected (sleep, out of memory) is forgotten, so the next render starts a fresh one.
 */
export function createPdfRenderer(opts: { launch?: () => Promise<Browser> } = {}): PdfRenderer {
  let browser: Promise<Browser> | null = null;
  const launch =
    opts.launch ??
    (async () => {
      const { chromium } = await import('playwright');
      // The worker handles stop signals itself and closes this browser; Playwright mustn't exit the process first.
      return chromium.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
    });
  const start = (): Promise<Browser> => {
    const p = launch().then((b) => {
      b.on('disconnected', () => {
        if (browser === p) browser = null;
      });
      return b;
    });
    p.catch(() => {
      if (browser === p) browser = null;
    });
    return p;
  };
  return {
    async render(html) {
      browser ??= start();
      const b = await browser;
      const page = await b.newPage();
      try {
        // No network: the document is self-contained.
        await page.route('**/*', (route) => (route.request().url().startsWith('data:') ? route.continue() : route.abort()));
        await page.setContent(html, { waitUntil: 'load' });
        return Buffer.from(await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true }));
      } finally {
        await page.close().catch(() => {});
      }
    },
    async close() {
      const current = browser;
      browser = null;
      if (current) await current.then((b) => b.close()).catch(() => {});
    },
  };
}
