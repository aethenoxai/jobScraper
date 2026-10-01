import { placeOf } from '../../lib/format';
import type { MatchService } from '../matching/service';
import type { ProfileService } from '../profile/service';
import type { Notifier } from './dispatcher';

/** Turns newly surfaced matches into "New matching job" notifications (external channels digest bursts when sending). */
export function notifyNewMatches(deps: { notifier: Notifier; matching: MatchService; profiles: Pick<ProfileService, 'list'> }, matchIds: number[]): void {
  const all = deps.profiles.list();
  // With more than one profile, say which one the job matched.
  const forProfile = (id: number) => (all.length > 1 ? `For “${all.find((p) => p.id === id)?.name ?? 'a deleted profile'}” · ` : '');
  const items = matchIds
    .map((id) => deps.matching.get(id))
    .filter((m): m is NonNullable<typeof m> => !!m && m.decision === 'surfaced')
    .map((m) => ({
      entityKey: `match:${m.id}`,
      message: {
        title: `New matching job: ${m.job.title} (${m.score}%)`,
        body: `${forProfile(m.profileId)}${m.job.company} · ${placeOf(m.job.location, m.job.workMode, 'location not stated')}`,
        link: `/feed/${m.id}`,
        payload: { matchId: m.id, profileId: m.profileId, score: m.score },
      },
    }));
  deps.notifier.notifyMany('job.matched', items);
}
