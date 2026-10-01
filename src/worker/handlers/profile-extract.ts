import { PermanentError } from '@/server/queue';
import type { TaskHandler } from '@/server/queue/runner';
import { ExtractPayloadSchema, type CvService } from '@/server/profile/cv-service';

export function createProfileExtractHandler(deps: { cvs: CvService }): TaskHandler {
  return async (payload) => {
    const parsed = ExtractPayloadSchema.safeParse(payload);
    if (!parsed.success) throw new PermanentError('Invalid profile.extract payload');
    await deps.cvs.runExtraction(parsed.data.masterCvId);
  };
}
