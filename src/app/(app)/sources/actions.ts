'use server';

import { revalidatePath } from 'next/cache';
import { liveEnv } from '@/server/config/env-store';
import { getAppContext } from '@/server/context';
import { collectHints } from '@/server/discovery/hints';
import { createHttpClient } from '@/server/http';
import { probeSource } from '@/server/sources/probe';
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

/** "Test" tries the source once from here (bounded, ≤15 s) so the user finds out before saving. */
async function testConnection(adapterId: string, config: Record<string, unknown>): Promise<SourceActionResult> {
  const { profiles, log } = getAppContext();
  return probeSource(adapterId, config, { http: createHttpClient(), env: liveEnv(), log, hints: collectHints(profiles.list()) });
}

export async function createSource(_prev: SourceActionResult | null, formData: FormData): Promise<SourceActionResult> {
  const adapterId = String(formData.get('adapterId') ?? '');
  const config = configFrom(adapterId, formData);
  if (formData.get('intent') === 'test') {
    try {
      return await testConnection(adapterId, config);
    } catch (err) {
      return fail(err);
    }
  }
  try {
    getAppContext().sources.create(adapterId, String(formData.get('name') ?? ''), config);
  } catch (err) {
    return fail(err);
  }
  revalidatePath('/sources');
  return { ok: true, message: 'Source added. It will be searched on the next scan.' };
}

export async function updateSourceConfig(sourceId: number, adapterId: string, _prev: SourceActionResult | null, formData: FormData): Promise<SourceActionResult> {
  if (formData.get('intent') === 'test') {
    try {
      return await testConnection(adapterId, configFrom(adapterId, formData));
    } catch (err) {
      return fail(err);
    }
  }
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
