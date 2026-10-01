import Link from 'next/link';
import { confirmProfileStep } from '@/app/welcome/actions';
import { ProfileEditor } from '@/components/profile/profile-editor';
import { Card, Notice } from '@/components/ui';
import type { ProfileData } from '@/server/profile/model';

/** Step 3: what was read from the CV, to check and correct before anything is matched against it. */
export function ReviewStep({ profileId, data, missing, readWithoutAi }: { profileId: number; data: ProfileData; missing: number; readWithoutAi: boolean }) {
  return (
    <Card title="3. Check your profile">
      <div className="mb-4 space-y-2">
        <p className="text-sm text-neutral-600 dark:text-neutral-400">This is what was read from your CV. Correct anything that’s wrong and fill in what’s missing: applications use exactly this.</p>
        {readWithoutAi && <Notice tone="amber">The AI couldn’t read this CV, so it was read with simple rules. Please check every field.</Notice>}
        {missing > 0 && <Notice tone="amber">{missing} important field{missing > 1 ? 's are' : ' is'} empty (highlighted). Fill {missing > 1 ? 'them' : 'it'} in if you can; nothing is ever guessed.</Notice>}
        <p className="text-xs text-neutral-500">
          <Link href="/welcome?step=cv" className="underline">← Upload a different CV</Link>
        </p>
      </div>
      <ProfileEditor profileId={profileId} initial={data} submitLabel="Save and continue" afterSave={confirmProfileStep} />
    </Card>
  );
}
