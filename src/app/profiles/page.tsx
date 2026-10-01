import type { Metadata } from 'next';
import Link from 'next/link';
import { ConfirmButton } from '@/components/confirm-button';
import { CreateProfileForm } from '@/components/profile/create-profile-form';
import { Badge, btn, btnDanger, Card, PageHeader } from '@/components/ui';
import { getAppContext } from '@/server/context';
import { missingFields } from '@/server/profile/model';
import { deleteProfile, duplicateProfile, setDefaultProfile } from './actions';

export const metadata: Metadata = { title: 'Profiles' };

export const dynamic = 'force-dynamic';

export default function ProfilesPage() {
  const profiles = getAppContext().profiles.list();
  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader title="Profiles" subtitle="One installation, one person, as many career profiles as you need. Each profile has its own CV, preferences and matching." />
      <Card title="New profile">
        <CreateProfileForm />
      </Card>
      {profiles.length === 0 ? (
        <p className="text-sm text-neutral-500">No profiles yet. Create one and upload your latest CV to get started.</p>
      ) : (
        <ul className="space-y-3">
          {profiles.map((p) => {
            const missing = missingFields(p.data).length;
            return (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
                <div>
                  <Link href={`/profiles/${p.id}`} className="font-medium underline-offset-2 hover:underline">{p.name}</Link>{' '}
                  {p.isDefault && <Badge tone="blue">Default</Badge>}{' '}
                  {missing > 0 && <Badge tone="amber">{missing} fields to complete</Badge>}
                  <p className="text-sm text-neutral-500">
                    {[p.data.personal.fullName, p.data.headline, p.data.skills.length ? `${p.data.skills.length} skills` : null].filter(Boolean).join(' · ') || 'Empty profile'}
                  </p>
                </div>
                <div className="flex gap-2">
                  {!p.isDefault && (
                    <form action={setDefaultProfile.bind(null, p.id)}><button className={btn}>Make default</button></form>
                  )}
                  <form action={duplicateProfile.bind(null, p.id)}><button className={btn}>Duplicate</button></form>
                  <form action={deleteProfile.bind(null, p.id)}>
                    <ConfirmButton className={btnDanger} label={`Delete ${p.name}`} message={`Delete the profile "${p.name}" with its CVs? This cannot be undone.`}>Delete</ConfirmButton>
                  </form>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
