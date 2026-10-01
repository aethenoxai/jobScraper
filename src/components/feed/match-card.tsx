import Link from 'next/link';
import { approveMatch, skipMatch, undoSkipMatch } from '@/app/(app)/feed/actions';
import { Badge, btn, btnPrimary } from '@/components/ui';
import { formatWhen, placeOf } from '@/lib/format';
import { STATUS_LABELS, type ApplicationStatus } from '@/server/applications/state';
import { formatSalary } from '@/server/jobs/queries';
import type { MatchService } from '@/server/matching/service';

type Item = ReturnType<MatchService['feed']>['items'][number];

export function scoreTone(score: number): 'green' | 'blue' | 'amber' | 'neutral' {
  return score >= 85 ? 'green' : score >= 75 ? 'blue' : score >= 60 ? 'amber' : 'neutral';
}

export function MatchCard({ item, now }: { item: Item; now: number }) {
  const salary = formatSalary(item);
  const isNew = item.firstSurfacedAt && now - item.firstSurfacedAt.getTime() < 86_400_000 && item.reviewState === 'NEW';
  return (
    <li className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800" data-testid="match-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/feed/${item.matchId}`} className="font-semibold hover:underline">{item.title}</Link>
            {isNew && <Badge tone="green">New</Badge>}
            {item.reviewState === 'SKIPPED' && <Badge>Skipped</Badge>}
            {item.applicationStatus && <Badge tone="blue">{STATUS_LABELS[item.applicationStatus as ApplicationStatus]}</Badge>}
          </div>
          <div className="text-sm text-neutral-600 dark:text-neutral-400">
            {item.company} · {placeOf(item.location, item.workMode)}{salary ? ` · ${salary}` : ''}
          </div>
          <div className="text-xs text-neutral-500">
            {item.sources.join(', ')} · found {formatWhen(item.firstSeenAt, now)}
            {item.filterReason && ` · ${item.filterReason}`}
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          {item.method === 'gate' ? <Badge>Not scored</Badge> : <Badge tone={scoreTone(item.score)}>Match {item.score}%</Badge>}
          <div className="flex gap-2">
            <Link href={`/feed/${item.matchId}`} className={btn}>View</Link>
            {item.reviewState === 'SKIPPED' ? (
              <form action={undoSkipMatch.bind(null, item.matchId)}><button className={btn}>Undo skip</button></form>
            ) : item.reviewState !== 'APPROVED' ? (
              <>
                <form action={approveMatch.bind(null, item.matchId, undefined)}><button className={btnPrimary}>Approve &amp; prepare</button></form>
                <form action={skipMatch.bind(null, item.matchId)}><button className={btn}>Skip</button></form>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </li>
  );
}
