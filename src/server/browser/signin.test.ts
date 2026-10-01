import { describe, expect, it } from 'vitest';
import { createLogger } from '../logging';
import { PermanentError } from '../queue';
import type { BrowserEngine } from './engine';
import { checkSignInUrl, createSignInHandler } from './signin';

describe('signing in to a site', () => {
  it('accepts job sites and refuses LinkedIn, Indeed and other never-automated sites', () => {
    expect(checkSignInUrl(' https://jobs.smartrecruiters.com/acme ')).toEqual({ ok: true, url: 'https://jobs.smartrecruiters.com/acme', host: 'jobs.smartrecruiters.com' });
    expect(checkSignInUrl('https://www.linkedin.com/login')).toMatchObject({ ok: false, message: expect.stringMatching(/doesn't automate linkedin\.com/) });
    expect(checkSignInUrl('javascript:alert(1)')).toMatchObject({ ok: false });
    expect(checkSignInUrl('careers')).toMatchObject({ ok: false, message: expect.not.stringMatching(/linkedin/i) });
  });

  it('the task never opens a refused site', async () => {
    let opened = 0;
    const engine: BrowserEngine = { withPage: async () => Promise.reject(new Error('no')), openForSignIn: async () => void opened++ };
    const ctx = { taskId: 1, attempt: 1, log: createLogger({ level: 'silent' }), signal: new AbortController().signal };
    await expect(createSignInHandler(engine)({ url: 'https://in.indeed.com/account/login' }, ctx)).rejects.toBeInstanceOf(PermanentError);
    expect(opened).toBe(0);
  });
});
