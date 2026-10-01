import type { ProfileRecord } from '../profile/service';
import type { SourceHints } from '../sources/types';

function uniqueCaseInsensitive(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values.map((x) => x.trim()).filter(Boolean)) {
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

/** What to search for, across all profiles: target titles (or the current title), places and keywords. */
export function collectHints(profiles: ProfileRecord[]): SourceHints {
  const titles = profiles.flatMap((p) => {
    const explicit = [...p.preferences.targetTitles, ...p.data.targetTitles];
    return explicit.length ? explicit : p.data.headline ? [p.data.headline] : [];
  });
  // Preference titles of every profile first, then the rest, so each profile gets a search slot.
  const ordered = [...profiles.flatMap((p) => p.preferences.targetTitles.slice(0, 1)), ...titles];
  return {
    titles: uniqueCaseInsensitive(ordered),
    locations: uniqueCaseInsensitive(profiles.flatMap((p) => p.preferences.locations)),
    keywords: uniqueCaseInsensitive(profiles.flatMap((p) => p.preferences.includeKeywords)),
  };
}
