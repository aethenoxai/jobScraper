import { describe, expect, it } from 'vitest';
import { recognizeAtsUrl } from './ats-urls';
import { extractJobPostings } from './jsonld';

const page = (ld: unknown) => `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body>Job</body></html>`;

describe('extractJobPostings', () => {
  it('reads a schema.org JobPosting', () => {
    const [job] = extractJobPostings(
      page({
        '@context': 'https://schema.org',
        '@type': 'JobPosting',
        title: 'Data Analyst',
        description: '<p>Analyse <b>sales</b> data.</p>',
        datePosted: '2026-09-20',
        validThrough: '2026-12-31T00:00:00Z',
        employmentType: ['FULL_TIME'],
        hiringOrganization: { '@type': 'Organization', name: 'Example Retail' },
        jobLocation: { '@type': 'Place', address: { addressLocality: 'Kochi', addressRegion: 'Kerala', addressCountry: 'IN' } },
        baseSalary: { '@type': 'MonetaryAmount', currency: 'INR', value: { minValue: 400000, maxValue: 600000, unitText: 'YEAR' } },
        identifier: { value: 'DA-42' },
      }),
      'https://careers.example-retail.test/jobs/da-42',
    );
    expect(job).toMatchObject({
      sourceJobId: 'https://careers.example-retail.test/jobs/da-42',
      title: 'Data Analyst',
      company: 'Example Retail',
      location: 'Kochi, Kerala, IN',
      description: 'Analyse sales data.',
      employmentType: 'full-time',
      salaryText: 'INR 400000 - 600000 per year',
    });
    expect(job.expiresAt).toEqual(new Date('2026-12-31T00:00:00Z'));
  });

  it('finds postings inside @graph and arrays, marks telecommute jobs remote, and ignores broken JSON', () => {
    const html = `<script type="application/ld+json">{ broken json</script>` + page({ '@graph': [{ '@type': 'Organization', name: 'X' }, { '@type': ['JobPosting'], title: 'Nurse', hiringOrganization: 'Clinic', jobLocationType: 'TELECOMMUTE', description: 'Care' }] });
    const jobs = extractJobPostings(html, 'https://clinic.test/nurse');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ title: 'Nurse', company: 'Clinic', workMode: 'remote' });
  });

  it('returns nothing for pages without job postings', () => {
    expect(extractJobPostings('<html><body>Hello</body></html>', 'https://x.test')).toEqual([]);
  });

  it('several postings on one page keep their identity when the page reorders them, and relative links are resolved (M2 deferred minor)', () => {
    const nurse = { '@type': 'JobPosting', title: 'Nurse', hiringOrganization: { name: 'Clinic' }, url: '/careers/nurse-42', description: 'Care' };
    const porter = { '@type': 'JobPosting', title: 'Porter', hiringOrganization: { name: 'Clinic' }, identifier: { '@type': 'PropertyValue', value: 'P-7' }, description: 'Moving' };
    const cook = { '@type': 'JobPosting', title: 'Cook', hiringOrganization: { name: 'Clinic' }, description: 'Kitchen' };
    const first = extractJobPostings(page([nurse, porter, cook]), 'https://clinic.test/careers');
    const second = extractJobPostings(page([cook, porter, nurse]), 'https://clinic.test/careers');
    const ids = (jobs: typeof first) => Object.fromEntries(jobs.map((j) => [j.title, j.sourceJobId]));
    expect(ids(second)).toEqual(ids(first));
    expect(new Set(Object.values(ids(first))).size).toBe(3);
    expect(first.find((j) => j.title === 'Nurse')).toMatchObject({ sourceUrl: 'https://clinic.test/careers/nurse-42', applicationUrl: 'https://clinic.test/careers/nurse-42' });
  });
});

describe('recognizeAtsUrl', () => {
  it.each([
    ['https://boards.greenhouse.io/gitlab/jobs/123', { adapterId: 'greenhouse', config: { board: 'gitlab' } }],
    ['https://job-boards.greenhouse.io/figma', { adapterId: 'greenhouse', config: { board: 'figma' } }],
    ['https://jobs.lever.co/palantir/6ed7-abc', { adapterId: 'lever', config: { company: 'palantir' } }],
    ['https://jobs.ashbyhq.com/ramp/34413f8d', { adapterId: 'ashby', config: { board: 'ramp' } }],
    ['https://apply.workable.com/huggingface/j/F4C096B22E/', { adapterId: 'workable', config: { account: 'huggingface' } }],
    ['https://bunq.recruitee.com/o/ios-developer-3', { adapterId: 'recruitee', config: { company: 'bunq' } }],
    ['https://jobs.smartrecruiters.com/BoschGroup/744000152779389', { adapterId: 'smartrecruiters', config: { company: 'BoschGroup' } }],
  ])('%s', (url, expected) => {
    expect(recognizeAtsUrl(url)).toMatchObject(expected);
  });

  it('ignores job short-links, regional hosts it cannot query, and malformed paths', () => {
    expect(recognizeAtsUrl('https://apply.workable.com/j/F4C096B22E')).toBeNull();
    expect(recognizeAtsUrl('https://boards.eu.greenhouse.io/acme/jobs/1')).toBeNull();
    expect(recognizeAtsUrl('https://jobs.eu.lever.co/acme/1')).toBeNull();
    expect(recognizeAtsUrl('https://jobs.lever.co/%E0%A4%A/1')).toBeNull();
  });

  it('ignores other sites and generic ATS pages', () => {
    expect(recognizeAtsUrl('https://www.linkedin.com/jobs/view/1')).toBeNull();
    expect(recognizeAtsUrl('https://boards.greenhouse.io/')).toBeNull();
    expect(recognizeAtsUrl('https://www.recruitee.com/pricing')).toBeNull();
  });
});
