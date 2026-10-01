/**
 * How `pnpm run setup` gets Scrapling: a private Python environment in .scrapling/venv (uv brings its own Python
 * when the system's is older than 3.10), Scrapling from python/requirements.txt, and the browser it drives.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { scraplingPython } from './paths';

export interface InstallStep {
  cmd: string;
  args: string[];
}

export type InstallPlan = { kind: 'verify' | 'install'; python: string; steps: InstallStep[] } | { kind: 'missing'; error: string };

export interface InstallProbe {
  /** Whether a command can be run. */
  has(cmd: string): boolean;
  /** [major, minor] of a Python command, or null. */
  pythonVersion(cmd: string): [number, number] | null;
  exists(file: string): boolean;
}

const PYTHONS = ['python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3', 'python'];

export function planScraplingInstall(opts: { env: Record<string, string | undefined>; root: string; probe: InstallProbe }): InstallPlan {
  const { env, root, probe } = opts;
  if (env.SCRAPLING_PYTHON?.trim()) {
    const python = env.SCRAPLING_PYTHON.trim();
    return { kind: 'verify', python, steps: [{ cmd: python, args: ['-c', 'import scrapling'] }] };
  }
  const venv = path.join(root, '.scrapling', 'venv');
  const python = scraplingPython({}, root);
  const requirements = path.join(root, 'python', 'requirements.txt');
  // Scrapling launches its browser with Patchright (pinned to the same version as Playwright in the lock).
  const browser = { cmd: python, args: ['-m', 'patchright', 'install', 'chromium'] };
  const fresh = !probe.exists(python);
  if (probe.has('uv')) {
    return {
      kind: 'install',
      python,
      steps: [...(fresh ? [{ cmd: 'uv', args: ['venv', '--python', '3.12', venv] }] : []), { cmd: 'uv', args: ['pip', 'install', '--python', python, '-r', requirements] }, browser],
    };
  }
  const system = PYTHONS.find((cmd) => {
    if (!probe.has(cmd)) return false;
    const v = probe.pythonVersion(cmd);
    return !!v && (v[0] > 3 || (v[0] === 3 && v[1] >= 10));
  });
  if (!system && fresh) {
    return {
      kind: 'missing',
      error:
        'Scrapling needs Python 3.10 or newer. Install uv (it downloads Python for you): `curl -LsSf https://astral.sh/uv/install.sh | sh` (macOS: `brew install uv`), then run `pnpm run setup` again.',
    };
  }
  return {
    kind: 'install',
    python,
    steps: [...(fresh ? [{ cmd: system!, args: ['-m', 'venv', venv] }] : []), { cmd: python, args: ['-m', 'pip', 'install', '-r', requirements] }, browser],
  };
}

/** Looks at the real machine. */
export const systemProbe: InstallProbe = {
  has: (cmd) => spawnSync(cmd, ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0,
  pythonVersion: (cmd) => {
    const r = spawnSync(cmd, ['-c', 'import sys; print(sys.version_info[0], sys.version_info[1])'], { encoding: 'utf8', shell: process.platform === 'win32' });
    const m = r.status === 0 ? r.stdout.trim().match(/^(\d+) (\d+)$/) : null;
    return m ? [Number(m[1]), Number(m[2])] : null;
  },
  exists: existsSync,
};

/** Runs the plan's steps, showing their output. Returns null when everything worked, else what failed. */
export function runScraplingInstall(plan: InstallPlan): string | null {
  if (plan.kind === 'missing') return plan.error;
  for (const step of plan.steps) {
    const r = spawnSync(step.cmd, step.args, { stdio: 'inherit', shell: process.platform === 'win32' });
    if (r.status !== 0) return `\`${[step.cmd, ...step.args].join(' ')}\` failed${r.error ? `: ${r.error.message}` : ''}.`;
  }
  return null;
}
