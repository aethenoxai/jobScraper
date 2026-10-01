import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { planScraplingInstall, type InstallProbe } from './install';

const root = '/repo';
const venvPython = path.join(root, '.scrapling', 'venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
const requirements = path.join(root, 'python', 'requirements.txt');

function probe(over: Partial<InstallProbe> = {}): InstallProbe {
  return { has: () => false, pythonVersion: () => null, exists: () => false, ...over };
}

describe('planScraplingInstall', () => {
  it('only checks the import when SCRAPLING_PYTHON points at a managed Python (Docker)', () => {
    const plan = planScraplingInstall({ env: { SCRAPLING_PYTHON: '/opt/scrapling/bin/python' }, root, probe: probe({ has: () => true }) });
    expect(plan).toEqual({ kind: 'verify', python: '/opt/scrapling/bin/python', steps: [{ cmd: '/opt/scrapling/bin/python', args: ['-c', 'import scrapling'] }] });
  });

  it('prefers uv, which brings its own Python 3.12 when the system one is too old', () => {
    const plan = planScraplingInstall({ env: {}, root, probe: probe({ has: (c) => c === 'uv', pythonVersion: () => [3, 9] }) });
    expect(plan).toEqual({
      kind: 'install',
      python: venvPython,
      steps: [
        { cmd: 'uv', args: ['venv', '--python', '3.12', path.join(root, '.scrapling', 'venv')] },
        { cmd: 'uv', args: ['pip', 'install', '--python', venvPython, '-r', requirements] },
        { cmd: venvPython, args: ['-m', 'playwright', 'install', 'chromium'] },
      ],
    });
  });

  it('keeps an existing environment and only brings it up to date', () => {
    const plan = planScraplingInstall({ env: {}, root, probe: probe({ has: (c) => c === 'uv', exists: (p) => p === venvPython }) });
    expect(plan.kind === 'install' && plan.steps.map((s) => s.args[0])).toEqual(['pip', '-m']);
  });

  it('falls back to the newest Python 3.10+ it finds', () => {
    const versions: Record<string, [number, number]> = { 'python3.11': [3, 11], python3: [3, 9] };
    const plan = planScraplingInstall({ env: {}, root, probe: probe({ has: (c) => c in versions, pythonVersion: (c) => versions[c] ?? null }) });
    expect(plan).toEqual({
      kind: 'install',
      python: venvPython,
      steps: [
        { cmd: 'python3.11', args: ['-m', 'venv', path.join(root, '.scrapling', 'venv')] },
        { cmd: venvPython, args: ['-m', 'pip', 'install', '-r', requirements] },
        { cmd: venvPython, args: ['-m', 'playwright', 'install', 'chromium'] },
      ],
    });
  });

  it('says how to get uv or a newer Python when there is neither', () => {
    const plan = planScraplingInstall({ env: {}, root, probe: probe({ has: (c) => c === 'python3', pythonVersion: () => [3, 9] }) });
    expect(plan.kind).toBe('missing');
    expect(plan.kind === 'missing' && plan.error).toMatch(/astral\.sh\/uv\/install\.sh/);
    expect(plan.kind === 'missing' && plan.error).toMatch(/3\.10/);
  });
});
