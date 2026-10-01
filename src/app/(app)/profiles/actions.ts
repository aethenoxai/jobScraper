'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getAppContext } from '@/server/context';
import { notifyNewMatches } from '@/server/notifications/hooks';
import { isNamedError } from '@/lib/format';
import { sniffCvType, UnsupportedCvTypeError } from '@/server/profile/cv-text';
import type { ProfileData } from '@/server/profile/model';

export interface ActionResult {
  ok: boolean;
  message?: string;
}

export interface SaveProfileResult extends ActionResult {
  /** The data as stored (with ids assigned), so the editor keeps ids stable across saves. */
  data?: ProfileData;
}

const userMessage = (err: unknown): string => {
  if (isNamedError(err, 'ProfileValidationError', 'UnsupportedCvTypeError', 'CvTooLargeError', 'ProfileNotFoundError')) return err.message;
  getAppContext().log.error({ err }, 'profile action failed');
  return 'Something went wrong. Check the logs for details.';
};

async function fileFrom(formData: FormData): Promise<{ name: string; buf: Buffer } | null> {
  const file = formData.get('cv');
  if (!(file instanceof File) || file.size === 0) return null;
  return { name: file.name, buf: Buffer.from(await file.arrayBuffer()) };
}

export async function createProfile(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const { profiles, cvs } = getAppContext();
  let id: number;
  try {
    const file = await fileFrom(formData);
    if (file && !sniffCvType(file.buf)) throw new UnsupportedCvTypeError();
    const name = String(formData.get('name') ?? '').trim() || (file ? file.name.replace(/\.[^.]+$/, '') : '');
    if (!name) return { ok: false, message: 'Enter a name for the profile, or upload your CV.' };
    const profile = profiles.create(name);
    id = profile.id;
    if (file) await cvs.upload(id, file.name, file.buf);
  } catch (err) {
    return { ok: false, message: userMessage(err) };
  }
  revalidatePath('/profiles');
  redirect(`/profiles/${id}`);
}

export async function uploadCv(profileId: number, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const file = await fileFrom(formData);
    if (!file) return { ok: false, message: 'Choose a PDF or .docx file first.' };
    await getAppContext().cvs.upload(profileId, file.name, file.buf);
  } catch (err) {
    return { ok: false, message: userMessage(err) };
  }
  revalidatePath(`/profiles/${profileId}`);
  return { ok: true, message: 'CV uploaded. Extracting your profile in the background…' };
}

export async function saveProfileData(profileId: number, data: unknown): Promise<SaveProfileResult> {
  let saved: ProfileData;
  try {
    saved = getAppContext().profiles.updateData(profileId, data, { byUser: true }).data;
  } catch (err) {
    return { ok: false, message: userMessage(err) };
  }
  revalidatePath(`/profiles/${profileId}`);
  return { ok: true, message: 'Profile saved.', data: saved };
}

export async function savePreferences(profileId: number, preferences: unknown, sliderValue: number): Promise<ActionResult> {
  const { db, profiles, matching, notifier } = getAppContext();
  try {
    // The profile service queues re-matching; slider changes also apply at once from stored scores.
    profiles.updatePreferences(profileId, preferences, sliderValue);
    // Jobs a lower slider shows for the first time are new matches like any other: say so. One transaction, so a
    // failed notification can't leave them marked as already announced.
    db.transaction(() => {
      const { newlySurfaced } = matching.redecide(profileId);
      if (newlySurfaced.length) notifyNewMatches({ notifier, matching, profiles }, newlySurfaced);
    }, { behavior: 'immediate' });
  } catch (err) {
    return { ok: false, message: userMessage(err) };
  }
  revalidatePath(`/profiles/${profileId}`);
  return { ok: true, message: 'Preferences saved.' };
}

export async function renameProfile(profileId: number, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    getAppContext().profiles.rename(profileId, String(formData.get('name') ?? ''));
  } catch (err) {
    return { ok: false, message: userMessage(err) };
  }
  revalidatePath('/profiles');
  revalidatePath(`/profiles/${profileId}`);
  return { ok: true, message: 'Renamed.' };
}

export async function setDefaultProfile(profileId: number): Promise<void> {
  getAppContext().profiles.setDefault(profileId);
  revalidatePath('/profiles');
}

export async function duplicateProfile(profileId: number): Promise<void> {
  const copy = getAppContext().profiles.duplicate(profileId);
  revalidatePath('/profiles');
  redirect(`/profiles/${copy.id}`);
}

export async function deleteProfile(profileId: number): Promise<void> {
  const { profiles } = getAppContext();
  await profiles.delete(profileId);
  revalidatePath('/profiles');
  // Without any profile there is nothing to search for: setup opens again at the CV step.
  redirect(profiles.list().length ? '/profiles' : '/welcome');
}

export async function applyCvImport(profileId: number, masterCvId: number, formData: FormData): Promise<void> {
  const accepted = formData.getAll('accept').map(String);
  getAppContext().cvs.applyPending(masterCvId, accepted);
  revalidatePath(`/profiles/${profileId}`);
}

export async function dismissCvImport(profileId: number, masterCvId: number): Promise<void> {
  getAppContext().cvs.dismissPending(masterCvId);
  revalidatePath(`/profiles/${profileId}`);
}

export async function removeCv(profileId: number, masterCvId: number): Promise<void> {
  await getAppContext().cvs.remove(masterCvId);
  revalidatePath(`/profiles/${profileId}`);
}
