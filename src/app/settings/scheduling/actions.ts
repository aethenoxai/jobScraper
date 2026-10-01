'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getAppContext } from '@/server/context';
import { isValidInterval } from '@/server/scheduler';

const PAGE = '/settings/scheduling';

function refresh() {
  revalidatePath(PAGE);
  revalidatePath('/');
}

// Start and Stop go back to the plain page, so an earlier message ("Scan queued") doesn't linger.
export async function startDiscovery() {
  getAppContext().scheduler.start();
  refresh();
  redirect(PAGE);
}

export async function stopDiscovery() {
  getAppContext().scheduler.stop();
  refresh();
  redirect(PAGE);
}

export async function runDiscoveryNow() {
  const { deduped } = getAppContext().scheduler.runNow();
  refresh();
  redirect(`${PAGE}?msg=${deduped ? 'already' : 'queued'}`);
}

export async function saveInterval(formData: FormData) {
  const preset = String(formData.get('preset') ?? '');
  const minutes = Number(preset === 'custom' ? formData.get('customMinutes') : preset);
  if (!isValidInterval(minutes)) redirect(`${PAGE}?msg=invalid-interval`);
  getAppContext().scheduler.setIntervalMinutes(minutes);
  refresh();
  redirect(PAGE);
}
