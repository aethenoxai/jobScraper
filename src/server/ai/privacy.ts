/** Plain words about where each AI task's data goes, for the System page and Settings → AI provider. Pure: no I/O. */
import { AI_TASKS, PROVIDER_LABELS, TASK_LABELS, type AiProvider, type AiTask } from './settings';

/** What a task sends to its provider (the text, not metadata). */
export const TASK_DATA: Record<AiTask, string> = {
  'cv-extract': 'your CV (the file itself for providers that read PDFs, otherwise its text)',
  'jd-analysis': 'job descriptions',
  'match-evaluate': 'job descriptions and the relevant parts of your profile',
  'web-job-extract': 'the text of job pages found on the web',
  'cv-tailor': 'your profile and the job description',
  'cover-letter': 'your profile and the job description',
  'form-answers': 'your profile and the questions of an application form',
  'inbox-classify': 'the text of replies to your applications',
};

const hostOf = (url: string | null) => { try { return url ? new URL(url).host : ''; } catch { return ''; } };
/** An empty address means Ollama's default, which is this computer. */
const isLocalUrl = (url: string | null) => !url || ['localhost', '127.0.0.1', '[::1]'].includes(hostOf(url).replace(/:\d+$/, '')) || !hostOf(url);

/** Who receives the data when a task runs on `provider`. `baseUrl` only names the host of an OpenAI-compatible server. */
export function destination(provider: AiProvider, baseUrl: string | null = null): string {
  switch (provider) {
    case 'none': return 'nobody: it runs offline on this computer';
    case 'ollama': return isLocalUrl(baseUrl) ? 'nobody else: Ollama runs on your computer' : `the Ollama server at ${hostOf(baseUrl)}`;
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

export interface PrivacyLine { task: AiTask; title: string; data: string; destination: string; local: boolean }

/** One line per task, in task order, from the routes the app actually uses. */
export function privacyLines(routes: Array<{ task: AiTask; provider: AiProvider }>, baseUrls: Partial<Record<AiProvider, string | null>> = {}): PrivacyLine[] {
  return AI_TASKS.map((task) => {
    const provider = routes.find((r) => r.task === task)?.provider ?? 'none';
    return { task, title: TASK_LABELS[task].title, data: TASK_DATA[task], destination: destination(provider, baseUrls[provider] ?? null), local: staysLocal(provider, baseUrls[provider] ?? null) };
  });
}

/** Names a usage-ledger row: a task's title, or a plain word for the other labels recorded there. */
export function usageLabel(task: string): string {
  if (task === 'connection-test') return 'Connection tests';
  return (TASK_LABELS as Record<string, { title: string } | undefined>)[task]?.title ?? task;
}

export const providerLabel = (p: AiProvider) => PROVIDER_LABELS[p];
