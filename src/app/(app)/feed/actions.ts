'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { isNamedError } from '@/lib/format';
import { getAppContext } from '@/server/context';
import { RESCORE_TASK } from '@/server/matching/tasks';
import { LAST_SKIPPED_COOKIE } from './last-skipped';

function refresh(matchId?: number) {
  revalidatePath('/feed');
  revalidatePath('/');
  if (matchId) revalidatePath(`/feed/${matchId}`);
}

export async function approveMatch(matchId: number, listingId?: number): Promise<void> {
  try {
    getAppContext().matching.approve(matchId, listingId);
  } catch (err) {
    if (!isNamedError(err, 'JobClosedError')) throw err;
    refresh(matchId);
    redirect(`/feed/${matchId}?msg=closed`);
  }
  refresh(matchId);
}

export async function markMatchViewed(matchId: number): Promise<void> {
  if (Number.isInteger(matchId)) getAppContext().matching.view(matchId);
}

export async function skipMatch(matchId: number): Promise<void> {
  if (getAppContext().matching.skip(matchId)) (await cookies()).set(LAST_SKIPPED_COOKIE, String(matchId), { maxAge: 60, sameSite: 'strict', httpOnly: true, path: '/' });
  refresh(matchId);
}

export async function undoSkipMatch(matchId: number): Promise<void> {
  getAppContext().matching.undoSkip(matchId);
  (await cookies()).delete(LAST_SKIPPED_COOKIE);
  refresh(matchId);
}

export async function rescoreProfile(profileId: number): Promise<void> {
  getAppContext().queue.enqueue(RESCORE_TASK, { profileId, force: true }, { dedupeKey: `${RESCORE_TASK}:${profileId}:force` });
  refresh();
  redirect(`/feed?profile=${profileId}&msg=rescoring`);
}
