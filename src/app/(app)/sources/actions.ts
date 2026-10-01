'use server';

import { revalidatePath } from 'next/cache';
import { getAppContext } from '@/server/context';
import { getAdapter } from '@/server/sources/registry';
import { isNamedError } from '@/lib/format';

export interface SourceActionResult {
  ok: boolean;
  message: string;
}

/** Builds an adapter config from form fields named `config.<key>`; empty optional fields are left out. */
function configFrom(adapterId: string, formData: FormData): Record<string, unknown> {
  const adapter = getAdapter(adapterId);
  const config: Record<string, unknown> = {};
  for (const f of adapter?.configFields ?? []) {
    const v = String(formData.get(`config.${f.key}`) ?? '').trim();
    if (v !== '') config[f.key] = v;
  }
  return config;
}

const fail = (err: unknown): SourceActionResult => {
  if (isNamedError(err, 'SourceConfigError')) return { ok: false, message: err.message };
  getAppContext().log.error({ err }, 'source action failed');
  return { ok: false, message: 'Something went wrong. Check the logs.' };
};

export async function createSource(_prev: SourceActionResult | null, formData: FormData): Promise<SourceActionResult> {
  const adapterId = String(formData.get('adapterId') ?? '');
  try {
    getAppContext().sources.create(adapterId, String(formData.get('name') ?? ''), configFrom(adapterId, formData));
  } catch (err) {
    return fail(err);
  }
  revalidatePath('/sources');
  return { ok: true, message: 'Source added. It will be searched on the next scan.' };
}

export async function updateSourceConfig(sourceId: number, adapterId: string, _prev: SourceActionResult | null, formData: FormData): Promise<SourceActionResult> {
  try {
    getAppContext().sources.update(sourceId, { name: String(formData.get('name') ?? ''), config: configFrom(adapterId, formData) });
  } catch (err) {
    return fail(err);
  }
  revalidatePath('/sources');
  return { ok: true, message: 'Saved.' };
}

export async function setSourceEnabled(sourceId: number, enabled: boolean): Promise<void> {
  getAppContext().sources.update(sourceId, { enabled });
  revalidatePath('/sources');
}

export async function deleteSource(sourceId: number): Promise<void> {
  getAppContext().sources.remove(sourceId);
  revalidatePath('/sources');
}
