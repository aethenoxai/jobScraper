import pkg from '../../../package.json';

export interface VersionInfo {
  version: string;
  releasesUrl: string;
  updateGuideUrl: string;
}

/**
 * The installed version and where to find a newer one. Read from package.json (RELEASING.md keeps
 * its repository field current); nothing is fetched, so the app never contacts GitHub itself.
 */
export function versionInfo(p: { version: string; repository: { url: string } } = pkg): VersionInfo {
  const repo = p.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
  return { version: p.version, releasesUrl: `${repo}/releases/latest`, updateGuideUrl: `${repo}/blob/main/docs/INSTALL.md#updating` };
}
