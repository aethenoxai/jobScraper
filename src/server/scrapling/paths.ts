import path from 'node:path';
import { NEVER_FETCH } from '../jobs/links';

/** The helper script, relative to the project root. */
export const HELPER_SCRIPT = path.join('python', 'scrapling_helper.py');

/** The Python that has Scrapling: SCRAPLING_PYTHON (Docker), else the environment `pnpm run setup` creates. */
export function scraplingPython(env: Record<string, string | undefined>, root: string = process.cwd()): string {
  const configured = env.SCRAPLING_PYTHON?.trim();
  if (configured) return configured;
  return process.platform === 'win32' ? path.join(root, '.scrapling', 'venv', 'Scripts', 'python.exe') : path.join(root, '.scrapling', 'venv', 'bin', 'python');
}

/** What the system and the browser need to run (where to find programs, the user's folders, the browser download). */
const PASSED_ON = ['PATH', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'SYSTEMROOT', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'XDG_CACHE_HOME', 'PLAYWRIGHT_BROWSERS_PATH'];

/** The helper's environment: none of the keys and passwords in .env, plus the never-read list and the guard switch. */
export function helperEnv(env: Record<string, string | undefined>, allowPrivate: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of PASSED_ON) if (env[key]) out[key] = env[key]!;
  return {
    ...out,
    PYTHONUNBUFFERED: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    JOB_SCRAPER_NEVER_FETCH: NEVER_FETCH.source,
    // Only the E2E suite (JOB_SCRAPER_ALLOW_PRIVATE_URLS) reads pages on this machine: no guard proxy then.
    JOB_SCRAPER_GUARD: allowPrivate ? 'off' : 'on',
  };
}
