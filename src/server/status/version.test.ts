import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import pkg from '../../../package.json';
import { versionInfo } from './version';

describe('versionInfo', () => {
  it('reports the installed version and links to the repository named in package.json', () => {
    const repo = pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
    expect(versionInfo()).toEqual({
      version: pkg.version,
      releasesUrl: `${repo}/releases/latest`,
      updateGuideUrl: `${repo}/blob/main/docs/INSTALL.md#updating`,
    });
  });

  it('follows a fork', () => {
    const v = versionInfo({ version: '2.0.0', repository: { url: 'git+https://github.com/someone/fork.git' } });
    expect(v).toMatchObject({ version: '2.0.0', releasesUrl: 'https://github.com/someone/fork/releases/latest' });
  });

  it('links to a heading that exists in INSTALL.md', () => {
    expect(readFileSync('docs/INSTALL.md', 'utf8')).toMatch(/^## Updating$/m);
  });
});
