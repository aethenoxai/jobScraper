import { describe, expect, it } from 'vitest';
import {
  descriptionHash,
  detectEmploymentType,
  detectWorkMode,
  extractApplyEmail,
  fingerprint,
  htmlToText,
  tidyLocation,
  repairMojibake,
  locationsCompatible,
  normalizeCompany,
  normalizeTitle,
  parseSalaryText,
  textSimilarity,
} from './normalize';

describe('htmlToText with mixed or messy markup (round 3)', () => {
  it('reads an escaped body that ends in real HTML (Arbeitnow), without leaving markup in the text', () => {
    const t = htmlToText('&lt;p&gt;&lt;span data-contrast="auto"&gt;We build &amp;amp; ship&lt;/span&gt;&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Go&lt;/li&gt;&lt;/ul&gt;<p>Find <a href="https://www.arbeitnow.com">Jobs in Germany</a> on Arbeitnow</a>');
    expect(t).toBe('We build & ship\n• Go\nFind Jobs in Germany on Arbeitnow');
  });

  it('keeps a bullet on the same line as its text, and collapses any kind of spacing', () => {
    expect(htmlToText('<ul><li><p>React</p></li><li><p>Node</p></li></ul>')).toBe('• React\n• Node');
    expect(htmlToText(`<p>a${'\u3000'.repeat(5)}b\u00a0\u00a0c</p>`)).toBe('a b c');
  });
});

describe('htmlToText keeps angle brackets that are text (round 4)', () => {
  it('a second pass removes only formatting tags, never prose like "< 90k" or Result<T>', () => {
    const t = htmlToText('&lt;p&gt;Compensation: &amp;lt; 90k EUR&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Kotlin&lt;/li&gt;&lt;li&gt;Postgres&lt;/li&gt;&lt;/ul&gt;&lt;p&gt;We use Result&amp;lt;T&amp;gt; everywhere.&lt;/p&gt;<p>Find <a href="https://x.example">Jobs in Germany</a> on Arbeitnow</p>');
    expect(t).toBe('Compensation: < 90k EUR\n• Kotlin\n• Postgres\nWe use Result<T> everywhere.\nFind Jobs in Germany on Arbeitnow');
    expect(htmlToText('&lt;p&gt;Know React &amp;lt;Suspense&amp;gt; and Promise&amp;lt;void&amp;gt;; HTML5 (&amp;lt;canvas&amp;gt;)&lt;/p&gt;<p>x</p>')).toBe('Know React <Suspense> and Promise<void>; HTML5 (<canvas>)\nx');
  });

  it('real HTML whose prose has escaped angle brackets keeps that prose', () => {
    expect(htmlToText('<p>Compensation: &lt; 90k EUR</p><ul><li>Kotlin</li><li>Postgres</li></ul><p>About the team</p><p>We use Result&lt;T&gt; everywhere.</p>')).toBe('Compensation: < 90k EUR\n• Kotlin\n• Postgres\nAbout the team\nWe use Result<T> everywhere.');
    expect(htmlToText('<p>Pay: &lt; $120k base, bonus &gt; 10%.</p><p>Know React &lt;Suspense&gt; boundaries.</p>')).toBe('Pay: < $120k base, bonus > 10%.\nKnow React <Suspense> boundaries.');
    expect(htmlToText('<p>HTML5 (&lt;canvas&gt;, &lt;video&gt;) and Promise&lt;void&gt;</p>')).toBe('HTML5 (<canvas>, <video>) and Promise<void>');
  });

  it('empty bullets don\'t pile up', () => {
    expect(htmlToText('<ul><li></li><li><p>Text</p></li></ul>')).toBe('• Text');
  });
});

describe('htmlToText', () => {
  it('keeps paragraph and list structure and decodes entities', () => {
    const t = htmlToText('<h2>About</h2><p>We&#39;re hiring &amp; growing.</p><ul><li>React</li><li>Node</li></ul><p>Salary&nbsp;€50k</p>');
    expect(t).toBe("About\nWe're hiring & growing.\n• React\n• Node\nSalary €50k");
  });

  it('handles HTML that arrives entity-escaped (Greenhouse)', () => {
    expect(htmlToText('&lt;p&gt;Hello &amp;amp; welcome&lt;/p&gt;&lt;p&gt;Next&lt;/p&gt;')).toBe('Hello & welcome\nNext');
  });

  it('drops scripts and styles', () => {
    expect(htmlToText('<style>p{}</style><p>Hi</p><script>alert(1)</script>')).toBe('Hi');
  });
});

describe('company and title keys', () => {
  it('ignores legal suffixes and punctuation', () => {
    expect(normalizeCompany('Fictional Labs Pvt. Ltd.')).toBe(normalizeCompany('fictional labs'));
    expect(normalizeCompany('Invented Bank GmbH')).toBe('invented bank');
    expect(normalizeCompany('ACME, Inc.')).toBe('acme');
    // Legal forms are only dropped at the end: short words inside a name are part of it (M2 deferred minor).
    expect(normalizeCompany('AB InBev')).toBe('ab inbev');
    expect(normalizeCompany('SE Ranking')).toBe('se ranking');
    expect(normalizeCompany('As Seen On Screen Ltd')).toBe('as seen on screen');
    expect(normalizeCompany('Co-op Group')).toBe('co op group');
    expect(normalizeCompany('Example Private Limited')).toBe('example');
    expect(normalizeCompany('Company')).toBe('company');
  });

  it('expands abbreviations and removes noise from titles', () => {
    expect(normalizeTitle('Sr. Software Engineer (m/f/d)')).toBe('senior software engineer');
    expect(normalizeTitle('Senior Software Engineer - Req #12345')).toBe('senior software engineer');
    expect(normalizeTitle('Jr Frontend Dev')).toBe('junior frontend developer');
  });

  it('fingerprints the same job the same way across sources', () => {
    expect(fingerprint('GitLab Inc.', 'Sr. Backend Engineer')).toBe(fingerprint('gitlab', 'Senior Backend Engineer'));
    expect(fingerprint('GitLab', 'Backend Engineer')).not.toBe(fingerprint('GitLab', 'Frontend Engineer'));
  });

  it.each([
    ['Remote - US', 'Remote - India'],
    ['US', 'Bengaluru'],
    ['San Francisco, CA', 'San Jose, CA'],
    ['New York, NY', 'New Delhi, India'],
    ['Remote - United States', 'Remote - United Kingdom'],
  ])('keeps %s and %s apart', (a, b) => {
    expect(locationsCompatible(a, b)).toBe(false);
  });

  it('empty descriptions are never similar', () => {
    expect(textSimilarity('', '')).toBe(0);
  });

  it('treats locations as compatible unless they clearly differ', () => {
    expect(locationsCompatible('Bangalore, India', 'Remote, Bangalore')).toBe(true);
    expect(locationsCompatible(null, 'London')).toBe(true);
    expect(locationsCompatible('Remote', 'Berlin, Germany')).toBe(true);
    expect(locationsCompatible('New York, NY', 'London, UK')).toBe(false);
  });
});

describe('detectors', () => {
  it.each([
    [['Hybrid'], 'hybrid'],
    [['Remote, Bangalore'], 'remote'],
    [['Work from home'], 'remote'],
    [['On-site in Berlin'], 'onsite'],
    [['Berlin'], null],
  ])('work mode %j → %s', (inputs, expected) => {
    expect(detectWorkMode(...(inputs as string[]))).toBe(expected);
  });

  it.each([
    ['FullTime', 'full-time'],
    ['full_time', 'full-time'],
    ['Part Time', 'part-time'],
    ['Contractor', 'contract'],
    ['Internship', 'internship'],
    ['Temporary', 'temporary'],
    ['Whatever', null],
  ])('employment type %s → %s', (input, expected) => {
    expect(detectEmploymentType(input)).toBe(expected);
  });

  it('parses common salary formats', () => {
    expect(parseSalaryText('$211.4K - $290.6K')).toEqual({ min: 211400, max: 290600, currency: 'USD', period: 'year' });
    expect(parseSalaryText('₹12–18 LPA')).toEqual({ min: 1200000, max: 1800000, currency: 'INR', period: 'year' });
    expect(parseSalaryText('€60,000 - €80,000 per year')).toEqual({ min: 60000, max: 80000, currency: 'EUR', period: 'year' });
    expect(parseSalaryText('£25 per hour')).toEqual({ min: 25, max: 25, currency: 'GBP', period: 'hour' });
    expect(parseSalaryText('Competitive')).toBeNull();
  });

  it('finds an application email only when the text asks to apply by email', () => {
    expect(extractApplyEmail('To apply, send your CV to jobs@acme.example. Questions: privacy@acme.example')).toBe('jobs@acme.example');
    expect(extractApplyEmail('Please email your resume to Hiring@Startup.example')).toBe('hiring@startup.example');
    expect(extractApplyEmail('Our privacy policy: privacy@acme.example')).toBeNull();
  });
});

describe('hashes and similarity', () => {
  it('description hash ignores whitespace and case but not content', () => {
    expect(descriptionHash('Build  APIs\nwith Node')).toBe(descriptionHash('build apis with node'));
    expect(descriptionHash('Build APIs')).not.toBe(descriptionHash('Build UIs'));
  });

  it('similarity is high for near-identical descriptions', () => {
    const a = 'We are looking for a senior backend engineer to build scalable APIs in Go and Postgres for our payments team.';
    expect(textSimilarity(a, a + ' Apply now.')).toBeGreaterThan(0.8);
    expect(textSimilarity(a, 'Nurse wanted for night shifts on an acute medical ward in Manchester.')).toBeLessThan(0.1);
  });
});

describe('repairMojibake (feeds that send UTF-8 decoded twice, e.g. Remote OK, Arbeitnow)', () => {
  it('repairs doubly decoded text, also in its Windows-1252 form', () => {
    expect(repairMojibake('You\u00e2\u0080\u0099ll review video')).toBe('You\u2019ll review video');
    expect(repairMojibake('Buscamos un/a Mec\u00c3\u00a1nico/a')).toBe('Buscamos un/a Mec\u00e1nico/a');
    expect(repairMojibake('Immunix\u00e2\u0084\u00a2 platform')).toBe('Immunix\u2122 platform');
    expect(repairMojibake('You\u00e2\u20ac\u2122ll')).toBe('You\u2019ll');
  });

  it('leaves correct text alone', () => {
    for (const ok of ['S\u00e3o Paulo', 'M\u00fcller GmbH', 'na\u00efve caf\u00e9', '\u00c5ngstr\u00f6m', 'Salary \u20ac50k', 'Crit\u00e8res: 5 ans', 'Stra\u00dfe 1', '\u00c0 propos']) expect(repairMojibake(ok)).toBe(ok);
  });
});

describe('tidyLocation (round 3)', () => {
  it('drops empty parts and repeats', () => {
    expect(tidyLocation('Toronto, ')).toBe('Toronto');
    expect(tidyLocation('Austin, Austin, Texas, United States')).toBe('Austin, Texas, United States');
    expect(tidyLocation(' ,  ')).toBeNull();
    expect(tidyLocation(null)).toBeNull();
    expect(tidyLocation('Berlin; Munich')).toBe('Berlin; Munich');
  });
});
