/** Recognises company job boards hosted on ATS platforms we have API adapters for. */
export interface AtsBoard {
  adapterId: string;
  config: Record<string, string>;
  name: string;
}

const RESERVED = new Set(['', 'embed', 'api', 'v1', 'jobs', 'search', 'login', 'about', 'pricing', 'j', 'o', 'p', 'apply']);

const PATTERNS: Array<{ host: RegExp; adapterId: string; key: string; fromPath: boolean }> = [
  { host: /^(boards|job-boards)\.greenhouse\.io$/, adapterId: 'greenhouse', key: 'board', fromPath: true },
  { host: /^jobs\.lever\.co$/, adapterId: 'lever', key: 'company', fromPath: true },
  { host: /^jobs\.ashbyhq\.com$/, adapterId: 'ashby', key: 'board', fromPath: true },
  { host: /^apply\.workable\.com$/, adapterId: 'workable', key: 'account', fromPath: true },
  { host: /^(jobs|careers)\.smartrecruiters\.com$/, adapterId: 'smartrecruiters', key: 'company', fromPath: true },
  { host: /^([a-z0-9-]+)\.recruitee\.com$/, adapterId: 'recruitee', key: 'company', fromPath: false },
];

export function recognizeAtsUrl(raw: string): AtsBoard | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  for (const p of PATTERNS) {
    const m = host.match(p.host);
    if (!m) continue;
    let value: string;
    try {
      value = p.fromPath ? decodeURIComponent(url.pathname.split('/')[1] ?? '') : m[1];
    } catch {
      return null; // malformed percent-encoding
    }
    if (!value || RESERVED.has(value.toLowerCase()) || value === 'www' || !/^[A-Za-z0-9_.-]+$/.test(value)) return null;
    return { adapterId: p.adapterId, config: { [p.key]: value }, name: value };
  }
  return null;
}
