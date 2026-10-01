import { z } from 'zod';
import { ADD_URL_TASK, addJobByUrl, AddJobError, rememberAddUrlNote } from '@/server/discovery/add-url';

export { ADD_URL_TASK };
import { PermanentError } from '@/server/queue';
import type { TaskHandler } from '@/server/queue/runner';
import type { DiscoveryDeps } from './discovery-scan';

const PayloadSchema = z.object({ url: z.string().min(1).max(2000) });

export function createDiscoveryUrlHandler(deps: DiscoveryDeps): TaskHandler {
  return async (payload, { signal, taskId }) => {
    const parsed = PayloadSchema.safeParse(payload);
    if (!parsed.success) throw new PermanentError('Invalid discovery.url payload');
    try {
      const { jobIds, note } = await addJobByUrl(parsed.data.url, { ...deps, signal });
      if (jobIds.length) deps.onChangedJobs(jobIds);
      if (note && deps.settings) rememberAddUrlNote(deps.settings, taskId, note);
    } catch (err) {
      // User-facing problems (wrong page, unsupported site) won't get better on retry.
      if (err instanceof AddJobError) throw new PermanentError(err.message);
      throw err;
    }
  };
}
