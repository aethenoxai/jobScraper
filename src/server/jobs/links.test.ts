import { describe, expect, it } from 'vitest';
import { NEVER_FETCH, notAutomated } from './links';

describe('never-read sites', () => {
  it('match with or without the trailing dot of a fully qualified name', () => {
    for (const host of ['www.linkedin.com', 'www.linkedin.com.', 'in.indeed.com.', 'naukri.com.']) expect(NEVER_FETCH.test(host)).toBe(true);
    expect(notAutomated('https://www.linkedin.com./jobs/view/1')).toBe('linkedin.com');
  });

  it('leave other sites alone', () => {
    for (const host of ['careers.example.com', 'linkedin.com.evil.example', 'notlinkedin.com']) expect(NEVER_FETCH.test(host)).toBe(false);
  });
});
