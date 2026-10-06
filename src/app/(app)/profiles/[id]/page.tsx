import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ConfirmButton } from '@/components/confirm-button';
import { CvUploadForm } from '@/components/profile/cv-panel';
import { PreferencesForm } from '@/components/profile/preferences-form';
import { ProfileEditor } from '@/components/profile/profile-editor';
import { RenameForm } from '@/components/profile/rename-form';
import { Badge, btn, btnDanger, btnPrimary, Card, Notice, PageHeader } from '@/components/ui';
import { formatWhen, requestTime } from '@/lib/format';
import { getAppContext } from '@/server/context';
import { missingFields } from '@/server/profile/model';
import { applyCvImport, deleteProfile, dismissCvImport, removeCv, setDefaultProfile } from '../actions';

export const dynamic = 'force-dynamic';

const STATUS_TONE = { uploaded: 'neutral', extracting: 'blue', extracted: 'amber', applied: 'green', dismissed: 'neutral', failed: 'red' } as const;
const STATUS_TEXT = { uploaded: 'Waiting for extraction', extracting: 'Extracting…', extracted: 'Needs your review', applied: 'Applied to profile', dismissed: 'Dismissed', failed: 'Failed' } as const;

export async function generateMetadata({ params }: PageProps<'/profiles/[id]'>): Promise<Metadata> {
  const profile = getAppContext().profiles.get(Number((await params).id));
  return { title: profile ? `Profile: ${profile.name}` : 'Profile' };
}

export default async function ProfilePage({ params }: PageProps<'/profiles/[id]'>) {
  const { id: raw } = await params;
  const id = Number(raw);
  const { profiles, cvs, ai } = getAppContext();
  const profile = Number.isInteger(id) ? profiles.get(id) : null;
  if (!profile) notFound();

  const cvList = cvs.list(id);
  const pending = cvs.pendingReview(id);
  const busy = cvList.some((c) => c.status === 'uploaded' || c.status === 'extracting');
  const missing = missingFields(profile.data);
  const aiStatus = ai.taskStatus('cv-extract');
  const now = requestTime();
  // Remount the editor only when a CV's data lands in the profile, not after every save.
  const dataVersion = cvList.filter((c) => c.status === 'applied').map((c) => c.id).join('-') || 'none';

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader
        title={<span className="flex items-center gap-2">{profile.name} {profile.isDefault && <Badge tone="blue">Default</Badge>}</span>}
        subtitle={<Link href="/profiles" className="underline">← All profiles</Link>}
        actions={
          <div className="flex flex-wrap gap-2">
            <RenameForm profileId={id} name={profile.name} />
            {!profile.isDefault && (
              <form action={setDefaultProfile.bind(null, id)}><button className={btn}>Make default</button></form>
            )}
            <form action={deleteProfile.bind(null, id)}>
              <ConfirmButton className={btnDanger} message={`Delete the profile "${profile.name}" with its CVs and applications? This cannot be undone.`}>Delete profile</ConfirmButton>
            </form>
          </div>
        }
      />
      {profile.dataIssues.length > 0 && (
        <Notice tone="amber">
          Some saved details of this profile couldn’t be read and are not shown ({profile.dataIssues.join('; ')}). They stay stored until you save the profile; saving keeps only what you see here.
        </Notice>
      )}

      <Card title="Master CV">
        <p className="mb-3 text-sm text-neutral-500" data-testid="cv-reader">
          {aiStatus.configured
            ? `CVs are read by ${aiStatus.provider} · ${aiStatus.model}. Check the fields it fills before you rely on them.`
            : aiStatus.provider === 'none'
              ? 'CV reading is set to None, so CVs are read on this computer with the offline extractor. It finds the basics, but review every field.'
              : `CV reading is set to ${aiStatus.provider}, but it can't run yet (${(aiStatus.reason ?? 'not set up').replace(/\.$/, '')}), so CVs are read with the offline extractor for now. Review every field.`}{' '}
          <Link href="/settings/ai" className="underline">Change how CVs are read</Link>
        </p>
        <CvUploadForm profileId={id} busy={busy} />
        {cvList.length > 0 && (
          <ul className="mt-4 divide-y divide-neutral-200 text-sm dark:divide-neutral-800">
            {cvList.map((cv) => (
              <li key={cv.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  {cv.originalName} <span className="text-neutral-500">· {(cv.sizeBytes / 1024).toFixed(0)} KB · uploaded {formatWhen(cv.uploadedAt, now)}</span>
                </span>
                <span className="flex items-center gap-2">
                  {cv.id === pending?.cv.id && pending.changes.length === 0 ? <Badge tone="green">Matches your profile</Badge> : <Badge tone={STATUS_TONE[cv.status]}>{STATUS_TEXT[cv.status]}</Badge>}
                  {cv.extractionMethod && <Badge>{cv.extractionMethod === 'ai' ? 'AI' : 'offline'}</Badge>}
                  <form action={removeCv.bind(null, id, cv.id)}>
                    <ConfirmButton className="text-xs underline" message="Delete this CV file? Your profile data is kept." label={`Delete ${cv.originalName}`}>Delete</ConfirmButton>
                  </form>
                </span>
                {cv.error && <span className="w-full text-red-600">{cv.error}</span>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {pending && (
        <Card title="Review changes from your new CV">
          {pending.warnings.map((w) => (
            <Notice key={w} tone="amber">{w}</Notice>
          ))}
          {pending.changes.length === 0 ? (
            <p className="text-sm">The new CV matches your profile. Nothing to change.</p>
          ) : (
            <form action={applyCvImport.bind(null, id, pending.cv.id)} className="space-y-3">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr><th className="w-8" /><th>Field</th><th>Now</th><th>From new CV</th></tr>
                </thead>
                <tbody>
                  {pending.changes.map((c) => (
                    <tr key={c.key} className="align-top">
                      <td><input type="checkbox" name="accept" value={c.key} defaultChecked={c.recommended} aria-label={`Use new ${c.label}`} /></td>
                      <td className="font-medium">{c.label}</td>
                      <td className="text-neutral-500">{c.current}</td>
                      <td>{c.incoming}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex gap-2">
                <button type="submit" className={btnPrimary}>Apply selected</button>
                <span className="self-center text-xs text-neutral-500">Only empty fields are pre-selected. Matching jobs keep your own edited bullet points.</span>
              </div>
            </form>
          )}
          <form action={dismissCvImport.bind(null, id, pending.cv.id)} className="mt-2">
            <button className={btn}>{pending.changes.length === 0 ? 'OK' : 'Dismiss'}</button>
          </form>
        </Card>
      )}

      <Card title="Profile" actions={missing.length > 0 ? <Badge tone="amber">{missing.length} fields to complete</Badge> : <Badge tone="green">Complete</Badge>}>
        <ProfileEditor key={dataVersion} profileId={id} initial={profile.data} />
      </Card>

      <Card title="Job-search preferences" id="preferences">
        <PreferencesForm profileId={id} initial={profile.preferences} initialSlider={profile.sliderValue} />
      </Card>
    </div>
  );
}
