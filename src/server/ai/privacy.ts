/** Plain words about where each AI task's data goes, for the System page and Settings → AI provider. Pure: no I/O. */
import { AI_TASKS, PROVIDER_LABELS, READS_FILES, TASK_LABELS, type AiProvider, type AiTask } from './settings';

/** What a task sends to its provider. */
export const TASK_DATA: Record<AiTask, string> = {
  'cv-extract': 'the text of your CV',
  'jd-analysis': 'job titles and descriptions',
  'match-evaluate': 'the job title and requirements, plus your target roles, years of experience, the text of your profile entries and your work authorization',
  'web-job-extract': 'the address and text of job pages found on the web',
  'cv-tailor': 'the job description and your summary, work history, projects, skills, education, certifications, languages and years of experience (not your contact details)',
  'cover-letter': 'the job description and your headline, summary, years of experience, work history with dates, projects, skills, education and certifications (not your contact details)',
  'form-answers': 'the questions of an application form, the job title and company, and your headline, summary, years of experience, skills, work history and projects (with their dates, locations and project links), education, certifications, languages, and the place you live (not your name, email, phone or personal profile links, and not your salary or visa/work-authorization fields)',
  'inbox-classify': 'the sender, subject and text of replies to your applications',
};

/** What a task sends when it runs on `provider`: reading a CV adds the PDF itself where the provider takes files. */
export function dataFor(task: AiTask, provider: AiProvider): string {
  return task === 'cv-extract' && READS_FILES.has(provider) ? 'your CV (the file itself and its text)' : TASK_DATA[task];
}

const hostOf = (url: string | null) => { try { return url ? new URL(url).host : ''; } catch { return ''; } };
/** No address at all means Ollama's default, this computer. A given address is local only if it is a loopback one. */
const isLocalUrl = (url: string | null) => url === null || ['localhost', '127.0.0.1', '[::1]'].includes(hostOf(url).replace(/:\d+$/, ''));

/** Who receives the data when a task runs on `provider`. `baseUrl` only names the host of an OpenAI-compatible server. */
export function destination(provider: AiProvider, baseUrl: string | null = null): string {
  switch (provider) {
    case 'none': return 'nobody: it runs offline on this computer';
    case 'ollama': return isLocalUrl(baseUrl) ? 'nobody else: Ollama runs on your computer' : `the Ollama server at ${hostOf(baseUrl) || 'the address you entered'}`;
    case 'openai': return 'OpenAI';
    case 'anthropic': return 'Anthropic';
    case 'google': return 'Google';
    case 'chatgpt': return 'OpenAI, under your ChatGPT plan';
    case 'claude-code': return 'Anthropic, through your own Claude Code';
    case 'openai-compatible': {
      const host = hostOf(baseUrl);
      return host ? `the server at ${host}` : 'the OpenAI-compatible server you entered';
    }
  }
}

/** True when nothing leaves this computer for that provider. */
export const staysLocal = (provider: AiProvider, baseUrl: string | null = null) => provider === 'none' || (provider === 'ollama' && isLocalUrl(baseUrl));

export interface PrivacyLine { task: AiTask; title: string; data: string; destination: string; local: boolean; notReady: boolean }

/**
 * One line per task, in task order, from the routes the app actually uses. `baseUrls` must be the addresses the app will
 * really call (saved address, else `OLLAMA_BASE_URL` for Ollama), or "local" may be claimed wrongly.
 * A route that isn't ready runs offline, so it sends nothing.
 */
export function privacyLines(routes: Array<{ task: AiTask; provider: AiProvider; configured?: boolean }>, baseUrls: Partial<Record<AiProvider, string | null>> = {}): PrivacyLine[] {
  return AI_TASKS.map((task) => {
    const route = routes.find((r) => r.task === task);
    const provider = route?.provider ?? 'none';
    const url = baseUrls[provider] ?? null;
    const notReady = provider !== 'none' && route?.configured === false;
    return { task, title: TASK_LABELS[task].title, data: dataFor(task, provider), destination: destination(provider, url), local: staysLocal(provider, url) || notReady, notReady };
  });
}

/** Names a usage-ledger row: a task's title, or a plain word for the other labels recorded there. */
export function usageLabel(task: string): string {
  if (task === 'connection-test') return 'Connection tests';
  return (TASK_LABELS as Record<string, { title: string } | undefined>)[task]?.title ?? task;
}

export const providerLabel = (p: AiProvider) => PROVIDER_LABELS[p];
