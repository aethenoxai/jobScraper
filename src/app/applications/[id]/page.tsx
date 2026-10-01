import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CoverLetterEditor } from '@/components/applications/cover-letter-editor';
import { CvEditor, type EditorItem } from '@/components/applications/cv-editor';
import { EmailComposer } from '@/components/applications/email-composer';
import { StatusForm } from '@/components/applications/status-form';
import { AutoRefresh } from '@/components/auto-refresh';
import { ConfirmButton } from '@/components/confirm-button';
import { Badge, btn, btnDanger, btnPrimary, Card, input, Notice, PageHeader } from '@/components/ui';
import { formatWhen, plural, requestTime } from '@/lib/format';
import { STATUS_LABELS, TRANSITIONS } from '@/server/applications/state';
import { getAppContext } from '@/server/context';
import { hasRealLink, notAutomated, sourceLabel } from '@/server/jobs/links';
import { describeFailure } from '@/server/failures';
import { createMailer } from '@/server/email/mailer';
import { coverLetterText } from '@/server/tailoring/cover-letter';
import type { ChangeReport } from '@/server/tailoring/report';
import { TEMPLATES } from '@/server/tailoring/render';
import { allowedHeadlines } from '@/server/tailoring/validate';
import { NOTE_MAX } from '@/server/applications/state';
import { addInterviewAction, addNoteAction, applyInBrowserAction, cancelBrowserApplyAction, deleteApplicationAction, resolveSuggestionAction, setOfferAction, setStatusAction, markAppliedAction, rerenderAction, resolveUncertainEmailAction, retryPreparationAction, setTemplateAction, withdrawAction } from '../actions';

export const dynamic = 'force-dynamic';

const ORIGIN_LABELS = { observed: 'seen', ai: 'AI', user: 'you', system: 'Job Scraper' } as const;

export async function generateMetadata({ params }: PageProps<'/applications/[id]'>): Promise<Metadata> {
  const app = getAppContext().apps.get(Number((await params).id));
  return { title: app ? `${app.jobTitle} at ${app.company}` : 'Application' };
}

export default async function ApplicationPage({ params, searchParams }: PageProps<'/applications/[id]'>) {
  const { id: raw } = (await params) as { id: string };
  const { error } = (await searchParams) as { error?: string };
  const { apps, profiles } = getAppContext();
  const id = Number(raw);
  const app = Number.isInteger(id) ? apps.get(id) : null;
  if (!app) notFound();
  const profile = profiles.get(app.profileId);
  const docs = apps.documents(id);
  const doc = (kind: string) => docs.find((d) => d.kind === kind);
  const pdf = doc('tailored_cv_pdf');
  const html = doc('tailored_cv_html');
  const saved = apps.tailoredCv(id);
  const reportDoc = doc('change_report');
  let report: ChangeReport | null = null;
  try {
    report = reportDoc ? (JSON.parse((await apps.readDocument(reportDoc)).toString('utf8')) as ChangeReport) : null;
  } catch {
    report = null; // a missing or half-written report must not break the page
  }
  const editable = apps.canEdit(id);
  const tracking = getAppContext().tracking;
  const inbox = tracking.messagesFor(id);
  const LABEL_TEXT: Record<string, string> = { acknowledgement: 'Acknowledgement', interview: 'Interview', rejection: 'Rejection', info_request: 'Asks for information', offer: 'Offer', other: 'Other' };
  const shot = docs.filter((d) => d.kind === 'screenshot').sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  const draft = apps.emailDraft(id);
  const letter = apps.coverLetter(id);
  const letterPdf = doc('cover_letter_pdf');
  const emails = apps.sentEmails(id);
  const uncertain = emails.find((e) => e.status === 'uncertain');
  const sender = createMailer({ env: process.env, settings: getAppContext().settings }).status();
  const outdated = apps.pdfOutdated(id);
  const rendering = apps.renderPending(id);
  const browserQueue = app.status === 'APPLYING' && app.method === 'browser' ? apps.browserQueue(id) : null;
  const timeline = apps.timeline(id);
  const now = requestTime();
  const applyAt = app.applicationUrl ?? app.sourceUrl;
  const blockedSite = notAutomated(applyAt);
  const canApply = ['READY', 'APPLICATION_SKIPPED', 'APPLICATION_FAILED', 'EXPIRED'].includes(app.status);
  const canWithdraw = ['PREPARING', 'READY', 'APPLIED', 'INTERVIEW', 'OFFER', 'PREPARATION_FAILED', 'APPLICATION_SKIPPED', 'APPLICATION_FAILED', 'EXPIRED'].includes(app.status);
  const nextStatuses = app.status === 'APPLYING' ? [] : TRANSITIONS[app.status].filter((x) => x !== app.status).filter((x) => !['PREPARING', 'APPLYING', 'PREPARATION_FAILED', 'APPLICATION_SKIPPED', 'APPLICATION_FAILED'].includes(x) && !(x === 'APPLIED' && canApply));

  const editorItems = (list: Array<{ id: string; title?: string | null; company?: string | null; name?: string; bullets: Array<{ id: string; text: string }> }>): EditorItem[] =>
    list.map((x) => ({ id: x.id, label: x.name ?? [x.title, x.company].filter(Boolean).join(' — '), masterBullets: x.bullets }));

  return (
    <div className="max-w-4xl space-y-5">
      {(app.status === 'PREPARING' || (app.status === 'APPLYING' && !browserQueue?.reason) || rendering) && <AutoRefresh />}
      <PageHeader
        title={app.jobTitle}
        subtitle={
          <span>
            {app.company}{app.location ? ` · ${app.location}` : ''} · via {hasRealLink(app.sourceUrl) ? <a href={app.sourceUrl} target="_blank" rel="noreferrer" className="underline">{sourceLabel(app.sourceName, app.sourceUrl)}</a> : 'a job you pasted'}
            {app.matchId && <> · <Link href={`/feed/${app.matchId}`} className="underline">match details</Link></>}
          </span>
        }
        actions={<Badge tone={app.status === 'READY' ? 'green' : app.status.includes('FAILED') ? 'red' : 'neutral'}>{STATUS_LABELS[app.status]}</Badge>}
      />
      {error && <Notice tone="amber">{error.slice(0, 300)}</Notice>}
      {app.status === 'PREPARING' && <Notice>Preparing your tailored CV… this page updates by itself.</Notice>}
      {(app.status === 'APPLICATION_SKIPPED' || app.status === 'APPLICATION_FAILED') && app.failureReason && (
        <Notice tone={app.status === 'APPLICATION_SKIPPED' ? 'amber' : 'red'}>
          <p data-testid="failure-reason">{app.status === 'APPLICATION_SKIPPED' ? 'Skipped' : 'Not applied'} ({(app.failureCode ?? '').replaceAll('_', ' ').toLowerCase()}): {app.failureReason}</p>
          {app.failureCode && <p className="mt-1 text-xs" data-testid="failure-help">{describeFailure(app.failureCode).help}</p>}
        </Notice>
      )}
      {browserQueue?.waiting && (
        <Notice tone="amber">
          <div className="flex flex-wrap items-center gap-3">
            <p data-testid="browser-waiting">{browserQueue.reason ?? 'Waiting for the browser to start (other applications to this site go first).'}</p>
            <form action={cancelBrowserApplyAction.bind(null, id)}><button className={btn}>Cancel</button></form>
          </div>
        </Notice>
      )}
      {app.status === 'APPLYING' && app.method === 'browser' && !browserQueue?.waiting && <Notice>Applying on the website… the steps appear in the timeline below.</Notice>}
      {app.status === 'PREPARATION_FAILED' && (
        <Notice tone="red">
          <div className="space-y-2">
            <p>Couldn’t prepare this application: {app.failureReason ?? 'unknown error'}</p>
            <p className="text-xs">{describeFailure(app.failureCode ?? 'CV_GENERATION_FAILED').help}</p>
            <form action={retryPreparationAction.bind(null, id)}><button className={btn}>Try again</button></form>
          </div>
        </Notice>
      )}

      <Card title="Apply">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          {pdf && <a href={`/api/documents/${pdf.id}`} className={btnPrimary} data-testid="download-cv">Download CV (PDF)</a>}
          {canApply && pdf && app.status !== 'EXPIRED' && hasRealLink(applyAt) && !blockedSite && (
            <form action={applyInBrowserAction.bind(null, id)}>
              <ConfirmButton
                message={
                  app.failureCode === 'NO_CONFIRMATION'
                    ? 'The last attempt may already have been submitted. Check your email and the site first: applying again could send a second application. Apply again anyway?'
                    : 'Apply on the job’s website now? Job Scraper fills in what your profile answers, uploads your tailored CV and submits. Anything it can’t do truthfully is skipped.'
                }
                className={btn}
              >
                {app.failureCode === 'NO_CONFIRMATION' ? 'Apply in browser again' : 'Apply in browser'}
              </ConfirmButton>
            </form>
          )}
          {hasRealLink(applyAt) && <a href={applyAt} target="_blank" rel="noreferrer" className={btn}>Open the job posting ↗</a>}
          {canApply && blockedSite && <span className="text-neutral-500">Job Scraper doesn’t apply on {blockedSite}: apply there yourself, then mark the application as applied below.</span>}
          {app.applyEmail && <span>Apply by email: <a href={`mailto:${app.applyEmail}`} className="underline">{app.applyEmail}</a></span>}
        </div>
        {canApply && (
          <form action={markAppliedAction.bind(null, id)} className="mt-3 flex flex-wrap items-end gap-2 text-sm">
            <label className="flex flex-col gap-1">Applied yourself? Note (optional)<input name="note" className={input} placeholder="e.g. applied on the company site" /></label>
            <button className={btn}>Mark as applied</button>
          </form>
        )}
        {app.submittedAt && <p className="mt-2 text-sm text-neutral-500">Applied {formatWhen(app.submittedAt, now)}. The CV and cover letter are kept exactly as they were.</p>}
        {app.status === 'READY' && (
          <form action={retryPreparationAction.bind(null, id)} className="mt-3">
            <ConfirmButton message="Tailor the CV and cover letter again from your current profile? This replaces the current versions." className="text-sm underline">Tailor again</ConfirmButton>
          </form>
        )}
      </Card>

      {uncertain && (
        <Notice tone="amber">
          <div className="space-y-2">
            <p>Sending to {uncertain.toAddress} was interrupted, so Job Scraper can’t tell whether it went out. Check the Sent folder of {uncertain.fromAddress} for “{uncertain.subject}”. Some providers don’t keep a copy of mail sent this way; if you can’t tell, it’s safer to treat it as sent than to apply twice.</p>
            <div className="flex flex-wrap gap-2">
              <form action={resolveUncertainEmailAction.bind(null, id, 'was-sent')}><button className={btn}>It was sent</button></form>
              <form action={resolveUncertainEmailAction.bind(null, id, 'send-again')}><ConfirmButton message="Send the application email again?" className={btn}>It wasn’t sent: send again</ConfirmButton></form>
            </div>
          </div>
        </Notice>
      )}

      {draft && (
        <Card title="Email application">
          {['READY', 'APPLICATION_FAILED', 'APPLICATION_SKIPPED'].includes(app.status) ? (
            <EmailComposer
              key={doc('email')?.id ?? 'draft'}
              applicationId={id}
              initial={draft}
              canSend={!!pdf && !rendering && !outdated}
              updating={rendering}
              sender={sender.ok ? { ok: true, text: `${sender.from} (${sender.provider})` } : { ok: false, text: `Can’t send yet: ${sender.reason}` }}
              hasCoverLetterPdf={!!letterPdf}
            />
          ) : (
            <p className="text-sm text-neutral-600 dark:text-neutral-400">{app.status === 'APPLYING' ? `Sending to ${draft.to}…` : `To ${draft.to} · “${draft.subject}”`}</p>
          )}
          {!sender.ok && <p className="mt-2 text-sm"><Link href="/settings/email" className="underline">Set up email sending</Link></p>}
          {emails.length > 0 && (
            <ul className="mt-4 space-y-2 border-t border-neutral-200 pt-3 text-sm dark:border-neutral-800" data-testid="sent-emails">
              {emails.map((e) => (
                <li key={e.id}>
                  <Badge tone={e.status === 'sent' ? 'green' : e.status === 'failed' ? 'red' : 'amber'}>{e.status === 'sent' ? 'Sent' : e.status === 'failed' ? 'Not sent' : e.status === 'uncertain' ? 'Unknown' : 'Sending'}</Badge>{' '}
                  to {e.toAddress} from {e.fromAddress} · {formatWhen(e.sentAt ?? e.createdAt, now)}
                  {e.response && <span className="text-xs text-neutral-500"> · server: {e.response}</span>}
                  {e.error && <span className="text-xs text-red-600"> · {e.error}</span>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {letter && profile && (
        <Card title="Cover letter" actions={letterPdf ? <a href={`/api/documents/${letterPdf.id}`} className={btn}>Download (PDF)</a> : null}>
          <div className="whitespace-pre-wrap text-sm" data-testid="cover-letter">{coverLetterText(letter.letter, profile.data)}</div>
          {editable && (
            <details className="mt-3">
              <summary className="cursor-pointer text-sm font-medium">Edit the cover letter</summary>
              <div className="mt-3"><CoverLetterEditor applicationId={id} initial={letter.letter} /></div>
            </details>
          )}
        </Card>
      )}

      {outdated && (
        <Notice tone="amber">
          <div className="flex flex-wrap items-center gap-3">
            <span>The PDF is older than your latest changes.</span>
            <form action={rerenderAction.bind(null, id)}><button className={btn}>Update the PDF</button></form>
          </div>
        </Notice>
      )}
      {['APPLIED', 'INTERVIEW', 'OFFER', 'REJECTED', 'WITHDRAWN'].includes(app.status) && (
        <Card title="Progress">
          <div className="space-y-4 text-sm" data-testid="progress">
            {nextStatuses.length > 0 && <StatusForm action={setStatusAction.bind(null, id)} options={nextStatuses.map((x) => ({ value: x, label: STATUS_LABELS[x] }))} />}
            {(app.status === 'REJECTED' || app.status === 'WITHDRAWN') && <p className="text-neutral-600 dark:text-neutral-400">This application is closed ({STATUS_LABELS[app.status].toLowerCase()}). Its documents and history stay here.</p>}
            {['APPLIED', 'INTERVIEW', 'OFFER'].includes(app.status) && (
              <form action={addInterviewAction.bind(null, id)} className="flex flex-wrap items-end gap-2">
                <label className="flex flex-col gap-1">Interview on<input type="datetime-local" name="at" required className={input} /></label>
                <label className="flex flex-col gap-1">Type
                  <select name="kind" className={input} defaultValue="video"><option value="phone">Phone</option><option value="video">Video</option><option value="onsite">On-site</option><option value="other">Other</option></select>
                </label>
                <label className="flex flex-col gap-1">Details<input name="details" className={input} placeholder="who, link, what to prepare" /></label>
                <button className={btn}>Add interview</button>
              </form>
            )}
            {app.status === 'OFFER' && (
              <form action={setOfferAction.bind(null, id)} className="flex flex-wrap items-end gap-2">
                <label className="flex flex-col gap-1">Salary offered<input name="salary" className={input} /></label>
                <label className="flex flex-col gap-1">Reply by<input type="date" name="deadline" className={input} /></label>
                <label className="flex flex-col gap-1">Notes<input name="notes" className={input} /></label>
                <button className={btn}>Save offer details</button>
              </form>
            )}
          </div>
        </Card>
      )}

      {inbox.length > 0 && (
        <Card title="Emails about this application">
          <ul className="space-y-3 text-sm" data-testid="inbox-messages">
            {inbox.map((m) => (
              <li key={m.id} className="space-y-1">
                <div><span className="text-neutral-500">Seen:</span> {m.fromAddress} · “{m.subject}”{m.receivedAt ? ` · ${formatWhen(m.receivedAt, now)}` : ''}</div>
                <div>
                  <span className="text-neutral-500">Interpretation:</span> {LABEL_TEXT[m.label ?? 'other']}{' '}
                  {m.method === 'rules' ? '(a rough guess from keywords; no AI model was used)' : `(${(m.confidence ?? 0) >= 0.85 ? 'high' : (m.confidence ?? 0) >= 0.6 ? 'medium' : 'low'} confidence)`}
                </div>
                {m.suggestedStatus && tracking.suggestionCurrent(m) && (
                  <div className="flex flex-wrap gap-2">
                    <form action={resolveSuggestionAction.bind(null, id, m.id, true)}><button className={btn}>Mark as {STATUS_LABELS[m.suggestedStatus].toLowerCase()}</button></form>
                    <form action={resolveSuggestionAction.bind(null, id, m.id, false)}><button className="text-sm underline">Dismiss</button></form>
                  </div>
                )}
                {m.resolution === 'auto' && <div className="text-xs text-neutral-500">Status updated automatically from this email.</div>}
                {m.suggestedStatus && !m.resolution && !tracking.suggestionCurrent(m) && <div className="text-xs text-neutral-500">Suggested “{STATUS_LABELS[m.suggestedStatus].toLowerCase()}”, which no longer applies (the status has changed since).</div>}
                {m.snippet && <details><summary className="cursor-pointer text-xs text-neutral-500">Show text</summary><p className="mt-1 whitespace-pre-wrap text-xs">{m.snippet}</p></details>}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {saved && (
        <Card
          title="Tailored CV"
          actions={
            editable && <form action={setTemplateAction.bind(null, id)} className="flex flex-wrap items-center gap-2 text-sm">
              <label className="flex items-center gap-2">Template
                <select name="template" defaultValue={saved.template} className={`${input} min-w-28`}>
                  {TEMPLATES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
              <button className={btn}>Apply template</button>
            </form>
          }
        >
          {rendering && <p className="mb-2 text-sm text-amber-700 dark:text-amber-400" data-testid="rendering">Updating the PDF…</p>}
          {html && <iframe title="CV preview" src={`/api/documents/${html.id}?inline=1`} sandbox="" className="h-[32rem] w-full rounded border border-neutral-200 bg-white dark:border-neutral-800" />}
        </Card>
      )}

      {report && (
        <Card title="What was changed for this job">
          <div className="space-y-3 text-sm" data-testid="change-report">
            <p>
              {report.method === 'ai' ? `Rewritten with AI (${report.intensity} tailoring).` : report.method === 'edited' ? 'Edited by you.' : 'Reordered for this job; your wording is unchanged (offline mode).'}
              {report.repairs > 0 && ` ${plural(report.repairs, 'part')} kept in your original wording because the generated text could not be verified against your profile.`}
            </p>
            {report.targeted.length > 0 && <p><b>Emphasises:</b> {report.targeted.join(' · ')}</p>}
            {report.headline.before !== report.headline.after && <p><b>Headline:</b> {report.headline.before ?? '—'} → {report.headline.after ?? '—'}</p>}
            {report.summary.changed && <p><b>Summary:</b> {report.summary.after ?? '(none)'}</p>}
            {report.skills.movedUp.length > 0 && <p><b>Skills moved up:</b> {report.skills.movedUp.join(', ')}</p>}
            {report.skills.omitted.length > 0 && <p><b>Skills left out:</b> {report.skills.omitted.join(', ')}</p>}
            {report.experience.map((e) => {
              const changed = e.bullets.filter((b) => b.kind !== 'unchanged');
              if (!changed.length && !e.omitted.length) return null;
              return (
                <div key={e.id}>
                  <b>{[e.title, e.company].filter(Boolean).join(' — ')}</b>
                  <ul className="list-disc pl-5">
                    {changed.map((b, i) => <li key={i}>{b.kind === 'merged' ? 'Combined' : b.kind === 'described' ? 'From the role description' : 'Reworded'}: “{b.after}”{b.before.length ? <span className="text-neutral-500"> (from: {b.before.join(' / ')})</span> : null}</li>)}
                    {e.omitted.length > 0 && <li className="text-neutral-500">Left out: {e.omitted.join(' / ')}</li>}
                  </ul>
                </div>
              );
            })}
            {report.projects.omitted.length > 0 && <p><b>Projects left out:</b> {report.projects.omitted.join(', ')}</p>}
            {report.sectionsReordered && <p><b>Sections reordered</b> to lead with what this job asks for.</p>}
            {(report.certificationsOmitted ?? []).length > 0 && <p><b>Certifications left out:</b> {report.certificationsOmitted.join(', ')}</p>}
          </div>
        </Card>
      )}

      {saved && profile && editable && (
        <details className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <summary className="cursor-pointer font-semibold">Edit the tailored CV</summary>
          <div className="mt-4">
            <CvEditor
              applicationId={id}
              initial={saved.cv}
              headlines={allowedHeadlines(profile.data)}
              items={{ experience: editorItems(profile.data.experience), projects: editorItems(profile.data.projects) }}
            />
          </div>
        </details>
      )}

      {shot && (
        <Card title="Screenshot from the website">
          {/* eslint-disable-next-line @next/next/no-img-element -- a local, generated image */}
          <img src={`/api/documents/${shot.id}?inline=1`} alt="What the website showed at the end" className="w-full rounded border border-neutral-200 dark:border-neutral-800" data-testid="screenshot" />
        </Card>
      )}

      <Card title="Timeline" actions={<form action={addNoteAction.bind(null, id)} className="flex flex-wrap items-center gap-2"><input name="note" placeholder="Add a note" className={input} aria-label="Note" required pattern=".*\S.*" maxLength={NOTE_MAX} title={`Write a note (up to ${NOTE_MAX.toLocaleString('en')} characters)`} /><button className={btn}>Add</button></form>}>
        <ol className="space-y-2 text-sm" data-testid="timeline">
          {timeline.map((e) => (
            <li key={e.id} className="flex gap-3">
              <span className="w-28 shrink-0 text-xs text-neutral-500">{formatWhen(e.occurredAt, now)}</span>
              <span className="min-w-0 [overflow-wrap:anywhere] whitespace-pre-line">{e.message} <span className="text-xs text-neutral-500">({ORIGIN_LABELS[e.origin]})</span></span>
            </li>
          ))}
        </ol>
      </Card>

      <Card title="Files">
        <ul className="space-y-1 text-sm">
          {/* The JSON files are Job Scraper's working copies; the PDFs and screenshots are what matters to the user. */}
          {docs.filter((d) => d.mime !== 'application/json').map((d) => <li key={d.id} className="[overflow-wrap:anywhere]"><a href={`/api/documents/${d.id}`} className="underline">{d.filename}</a> <span className="text-xs text-neutral-500">({d.kind.replaceAll('_', ' ')}, {formatWhen(d.createdAt, now)})</span></li>)}
        </ul>
        <div className="mt-4 flex flex-wrap gap-2">
          {canWithdraw && <form action={withdrawAction.bind(null, id)}><ConfirmButton message="Withdraw this application? It stays in your history." className={btn}>Withdraw</ConfirmButton></form>}
          <form action={deleteApplicationAction.bind(null, id)}>
            <ConfirmButton message="Delete this application and all its files? Your profile and master CV are not affected." className={btnDanger}>Delete application</ConfirmButton>
          </form>
        </div>
      </Card>
    </div>
  );
}
