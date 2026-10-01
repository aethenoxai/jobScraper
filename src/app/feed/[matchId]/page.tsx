import type { Metadata } from 'next';
import Link from 'next/link';
import { hasRealLink, sourceLabel } from '@/server/jobs/links';
import { notFound } from 'next/navigation';
import { scoreTone } from '@/components/feed/match-card';
import { MarkViewed } from '@/components/feed/mark-viewed';
import { Badge, btn, btnPrimary, Card, Notice, PageHeader } from '@/components/ui';
import { formatWhen, placeOf, requestTime } from '@/lib/format';
import { STATUS_LABELS } from '@/server/applications/state';
import { getAppContext } from '@/server/context';
import { formatSalary } from '@/server/jobs/queries';
import { profileItems } from '@/server/matching/evaluate';
import { WEIGHTS } from '@/server/matching/score';
import { approveMatch, skipMatch, undoSkipMatch } from '../actions';

export const dynamic = 'force-dynamic';

const COMPONENT_LABELS: Record<keyof typeof WEIGHTS, string> = {
  mustHave: 'Required qualifications',
  role: 'Role fit',
  skills: 'Skills',
  experience: 'Experience',
  location: 'Location',
  other: 'Education, languages, salary',
};
const STATUS_ICON = { met: '✓', partial: '◐', unmet: '✗' } as const;

export async function generateMetadata({ params }: PageProps<'/feed/[matchId]'>): Promise<Metadata> {
  const match = getAppContext().matching.get(Number((await params).matchId));
  return { title: match ? `${match.job.title} at ${match.job.company}` : 'Match' };
}

export default async function MatchPage({ params, searchParams }: PageProps<'/feed/[matchId]'>) {
  const { msg } = (await searchParams) as { msg?: string };
  const { matchId } = (await params) as { matchId: string };
  const { matching, profiles } = getAppContext();
  const id = Number(matchId);
  const match = Number.isInteger(id) ? matching.get(id) : null;
  if (!match) notFound();
  const profile = profiles.get(match.profileId);
  const itemText = new Map(profile ? profileItems(profile.data).map((i) => [i.id, i.text]) : []);
  const { breakdown, job } = match;
  const now = requestTime();
  const salary = formatSalary(job);
  const description = match.listings.map((l) => l.description).sort((a, b) => b.length - a.length)[0] ?? '';

  return (
    <div className="max-w-4xl space-y-5">
      {match.reviewState === 'NEW' && <MarkViewed matchId={id} />}
      {msg === 'closed' && <Notice tone="amber">This job is no longer listed, so no application was started.</Notice>}
      <PageHeader
        title={job.title}
        subtitle={
          <span>
            <Link href={`/feed?profile=${match.profileId}`} className="underline">← Job feed</Link> · {job.company} · {placeOf(job.location, job.workMode)}{salary ? ` · ${salary}` : ''}
          </span>
        }
        actions={
          <div className="flex items-center gap-2">
            {match.method === 'gate' ? <Badge>Not scored</Badge> : <Badge tone={scoreTone(match.score)}>Match {match.score}%</Badge>}
            {match.reviewState === 'SKIPPED' ? (
              <form action={undoSkipMatch.bind(null, id)}><button className={btn}>Undo skip</button></form>
            ) : (
              <>
                <form action={approveMatch.bind(null, id, undefined)}><button className={btnPrimary}>{match.reviewState === 'APPROVED' ? 'Approved ✓' : 'Approve & prepare'}</button></form>
                {match.reviewState !== 'APPROVED' && <form action={skipMatch.bind(null, id)}><button className={btn}>Skip</button></form>}
              </>
            )}
          </div>
        }
      />

      {match.applications.length > 0 && (
        <Card title="Applications">
          <ul className="space-y-1 text-sm">
            {match.applications.map((a) => (
              <li key={a.id}>
                <Badge tone="blue">{STATUS_LABELS[a.status]}</Badge> via {sourceLabel(a.sourceName, a.sourceUrl)} · approved {formatWhen(a.approvedAt, now)} · <Link href={`/applications/${a.id}`} className="underline">open application</Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title={breakdown.gate ? 'Why it wasn’t scored' : 'Why it matched'}>
        {breakdown.gate ? (
          <p className="text-sm">Filtered before scoring: {breakdown.gate}</p>
        ) : (
          <div className="space-y-4 text-sm">
            {match.filterReason && <p className="text-amber-700 dark:text-amber-400">{match.filterReason}</p>}
            {breakdown.score?.cappedBy && (
              <p className="text-amber-700 dark:text-amber-400">
                {breakdown.score.capKind === 'seniority' ? `Kept at ${breakdown.score.score}% or below: ${breakdown.score.cappedBy}.` : `Limited to 60% at most because a must-have isn't met: ${breakdown.score.cappedBy}`}
              </p>
            )}
            {breakdown.score && (
              <dl className="grid grid-cols-[14rem_1fr_3rem] items-center gap-x-3 gap-y-1">
                {(Object.keys(WEIGHTS) as Array<keyof typeof WEIGHTS>).map((k) => (
                  <div key={k} className="contents">
                    <dt>{COMPONENT_LABELS[k]} <span className="text-xs text-neutral-500">({WEIGHTS[k]}%)</span></dt>
                    <dd className="h-2 rounded bg-neutral-200 dark:bg-neutral-800"><div className="h-2 rounded bg-neutral-700 dark:bg-neutral-300" style={{ width: `${Math.round(breakdown.score!.components[k] * 100)}%` }} /></dd>
                    <dd className="text-right">{Math.round(breakdown.score!.components[k] * 100)}%</dd>
                  </div>
                ))}
              </dl>
            )}
            {breakdown.evaluation && breakdown.evaluation.requirements.length === 0 && (
              <p className="rounded-md border border-amber-400 px-3 py-2 text-sm" data-testid="title-only">
                This posting gives too little detail to check its requirements, so it was judged on the job title only. Read the posting before approving.
              </p>
            )}
            {breakdown.evaluation && (
              <>
                {(breakdown.evaluation.strengths.length > 0 || breakdown.evaluation.gaps.length > 0) && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    {breakdown.evaluation.strengths.length > 0 && <div><h3 className="font-medium">Strengths</h3><ul className="list-disc pl-5">{breakdown.evaluation.strengths.map((s) => <li key={s}>{s}</li>)}</ul></div>}
                    {breakdown.evaluation.gaps.length > 0 && <div><h3 className="font-medium">Gaps</h3><ul className="list-disc pl-5">{breakdown.evaluation.gaps.map((s) => <li key={s}>{s}</li>)}</ul></div>}
                  </div>
                )}
                {breakdown.evaluation.requirements.length > 0 && (
                <table className="w-full text-left">
                  <thead className="text-xs uppercase text-neutral-500"><tr><th className="w-6" /><th>Requirement</th><th>Your evidence</th></tr></thead>
                  <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
                    {breakdown.evaluation.requirements.map((r, i) => (
                      <tr key={i} className="align-top">
                        <td title={r.status}>{STATUS_ICON[r.status]}</td>
                        <td>{r.text} {!r.mandatory && <span className="text-xs text-neutral-500">(preferred)</span>}{r.note && <div className="text-xs text-neutral-500">{r.note}</div>}</td>
                        <td className="text-xs text-neutral-600 dark:text-neutral-400">{r.evidence.map((e) => itemText.get(e)).filter(Boolean).slice(0, 2).join(' · ') || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                )}
                <p className="text-xs text-neutral-500">Judged by {breakdown.evaluation.method === 'ai' ? 'AI (evidence checked against your profile)' : 'offline rules'} · requirements read by {breakdown.analysis?.method === 'ai' ? 'AI' : 'offline rules'}</p>
              </>
            )}
          </div>
        )}
      </Card>

      <Card title={`Where to apply (${match.listings.length})`}>
        <ul className="space-y-2 text-sm">
          {match.listings.map((l) => {
            const app = match.applications.find((a) => a.listingId === l.id);
            return (
              <li key={l.id} className="flex flex-wrap items-center gap-2">
                <Badge>{l.sourceName}</Badge>
                {hasRealLink(l.sourceUrl) ? <a href={l.sourceUrl} target="_blank" rel="noreferrer" className="underline">View on {sourceLabel(l.sourceName, l.sourceUrl)}</a> : <span className="text-neutral-500">Pasted by you (no link)</span>}
                {l.applyEmail && <span className="text-neutral-500">Apply by email: {l.applyEmail}</span>}
                {app ? <Link href={`/applications/${app.id}`}><Badge tone="blue">{STATUS_LABELS[app.status]}</Badge></Link> : <form action={approveMatch.bind(null, id, l.id)}><button className={btn}>{hasRealLink(l.sourceUrl) ? `Apply via ${sourceLabel(l.sourceName, l.sourceUrl)}` : 'Prepare an application'}</button></form>}
              </li>
            );
          })}
        </ul>
      </Card>

      <Card title="Job description">
        <div className="whitespace-pre-line text-sm leading-6 [overflow-wrap:anywhere]">{description || 'No description available.'}</div>
      </Card>
    </div>
  );
}
