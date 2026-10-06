import { describe, expect, it } from 'vitest';
import { NEVER_FETCH } from '../jobs/links';
import { registerBuiltInAdapters } from './adapters';
import { getAdapter } from './registry';
import { capabilitiesOf, listPlatforms, MANUAL_PLATFORMS } from './platforms';

registerBuiltInAdapters();

describe('platform catalog', () => {
  it('offers every visible adapter as a connectable platform', () => {
    const connectable = listPlatforms().filter((p) => p.status === 'connectable');
    expect(connectable.map((p) => p.id)).toEqual(expect.arrayContaining(['greenhouse', 'lever', 'ashby', 'workable', 'recruitee', 'smartrecruiters', 'remoteok', 'remotive', 'arbeitnow', 'himalayas', 'adzuna', 'web']));
    for (const p of connectable) expect(getAdapter(p.adapterId!)).toBeDefined();
  });

  it('never offers the internal manual adapter as a platform', () => {
    expect(listPlatforms().some((p) => p.adapterId === 'manual')).toBe(false);
  });

  it('gives manual platforms no connector at all, so nothing can scan them', () => {
    const manual = listPlatforms().filter((p) => p.status === 'manual');
    expect(manual.length).toBeGreaterThan(0);
    for (const p of manual) {
      expect(p.adapterId).toBeUndefined();
      expect(getAdapter(p.id)).toBeUndefined();
      expect(p.capabilities).not.toContain('automaticScan');
      expect(p.reason).toBeTruthy();
    }
  });

  it('lists the platforms the user asked about', () => {
    const ids = listPlatforms().map((p) => p.id);
    for (const id of ['linkedin', 'naukri', 'indeed', 'wellfound', 'cutshort', 'internshala']) expect(ids).toContain(id);
  });

  it('only claims "add by link" for manual platforms the page reader is allowed to read', () => {
    for (const p of MANUAL_PLATFORMS) {
      const blocked = NEVER_FETCH.test(p.host);
      expect(p.capabilities.includes('addByUrl')).toBe(!blocked);
      // Pasting always works: it is the user's own text, not a fetch.
      expect(p.capabilities).toContain('pasteJob');
    }
  });

  it('derives capabilities from what the adapter actually does', () => {
    expect(capabilitiesOf(getAdapter('greenhouse')!)).toEqual(expect.arrayContaining(['automaticScan', 'detectsClosedJobs']));
    // Aggregators return search results, not a complete board: they cannot tell that a job closed.
    expect(capabilitiesOf(getAdapter('remotive')!)).not.toContain('detectsClosedJobs');
    expect(capabilitiesOf(getAdapter('adzuna')!)).toContain('search');
    expect(capabilitiesOf(getAdapter('web')!)).toEqual(expect.arrayContaining(['search', 'findsBoards', 'readsWebPages']));
    expect(capabilitiesOf(getAdapter('greenhouse')!)).not.toContain('readsWebPages');
  });

  it('categorises platforms without any per-platform special casing', () => {
    const byId = new Map(listPlatforms().map((p) => [p.id, p]));
    expect(byId.get('greenhouse')!.category).toBe('company_board');
    expect(byId.get('remotive')!.category).toBe('aggregator');
    expect(byId.get('web')!.category).toBe('web');
    expect(byId.get('linkedin')!.category).toBe('portal');
  });

  it('carries the key a platform needs, so the UI can say so before it is added', () => {
    expect(listPlatforms().find((p) => p.id === 'adzuna')!.requiresEnv).toEqual(['ADZUNA_APP_ID', 'ADZUNA_APP_KEY']);
  });
});
