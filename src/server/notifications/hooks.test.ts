import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDb } from '../../../tests/helpers/temp-db';
import { notifications, sources } from '../db/schema';
import { createIngestor } from '../jobs/ingest';
import { createLogger } from '../logging';
import { createMatchService } from '../matching/service';
import { DEFAULT_PREFERENCES, emptyProfile } from '../profile/model';
import { createProfileService } from '../profile/service';
import { createQueue } from '../queue';
import { createSettings } from '../settings';
import { createFileStore } from '../storage';
import { createNotifier } from './dispatcher';
import { notifyNewMatches } from './hooks';
import { DEFAULT_NOTIFICATION_SETTINGS, NOTIFICATION_SETTINGS_KEY } from './settings';

const log = createLogger({ level: 'silent' });
let t: ReturnType<typeof createTempDb>;
beforeEach(() => (t = createTempDb()));
afterEach(() => t.cleanup());

describe('notifyNewMatches', () => {
  it('announces newly surfaced jobs with title, company, location and score', async () => {
    const settings = createSettings(t.db);
    settings.set(NOTIFICATION_SETTINGS_KEY, { ...DEFAULT_NOTIFICATION_SETTINGS, channels: { ...DEFAULT_NOTIFICATION_SETTINGS.channels, telegram: true } });
    const queue = createQueue(t.db);
    const profiles = createProfileService({ db: t.db, files: createFileStore(path.join(t.dir, 'f')) });
    const matching = createMatchService({ db: t.db, ai: null, queue, profiles, log });
    const notifier = createNotifier({ db: t.db, settings, queue });
    const p = profiles.create('Engineer');
    const d = emptyProfile();
    d.skills = [{ id: '', name: 'Go', category: 'skill' }];
    profiles.updateData(p.id, d);
    profiles.updatePreferences(p.id, { ...DEFAULT_PREFERENCES, targetTitles: ['Backend Engineer'] }, 70);
    const src = t.db.insert(sources).values({ adapterId: 'greenhouse', name: 'Acme', config: {}, origin: 'user', createdAt: new Date() }).returning().get().id;
    const [jobId] = createIngestor({ db: t.db }).ingestRun(src, [{ sourceJobId: '1', sourceUrl: 'https://x.example/1', title: 'Backend Engineer', company: 'Acme', location: 'Remote', description: 'Requirements\n• Go' }], { completeSnapshot: true }).changedJobIds;
    const { matchId } = await matching.evaluate(jobId, p.id);

    notifyNewMatches({ notifier, matching, profiles }, [matchId]);
    const rows = t.db.select().from(notifications).all();
    expect(rows.map((r) => r.channel).sort()).toEqual(['inapp', 'telegram']);
    expect(rows[0]).toMatchObject({ event: 'job.matched', link: `/feed/${matchId}`, payload: { matchId, profileId: p.id, score: expect.any(Number) } });
    expect(rows[0].title).toMatch(/Backend Engineer.*\d+%/);
    expect(rows[0].body).toBe('Acme · Remote');

    // With a second profile, each alert says which profile the job matched.
    profiles.create('Designer');
    t.db.delete(notifications).run();
    notifyNewMatches({ notifier, matching, profiles }, [matchId]);
    expect(t.db.select().from(notifications).all()[0].body).toBe('For “Engineer” · Acme · Remote');
  });
});
