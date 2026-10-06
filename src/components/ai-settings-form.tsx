'use client';

import { useActionState } from 'react';
import { saveTasks } from '@/app/(app)/settings/ai/providers-actions';
import { AiTaskTable } from '@/components/ai-task-table';
import { btnPrimary } from '@/components/ui';
import type { AiProvider, AiSettings } from '@/server/ai/settings';

/** Settings → AI: the per-task routing table with a Save button. */
export function AiSettingsForm({ tasks, models }: { tasks: AiSettings['tasks']; models: Record<AiProvider, string[]> }) {
  const [saved, save, saving] = useActionState(saveTasks, null);
  return (
    <form action={save} className="space-y-4">
      <AiTaskTable tasks={tasks} models={models} />
      <div className="flex items-center gap-3">
        <button type="submit" className={btnPrimary} disabled={saving}>Save</button>
        {saved && <span role="status" data-testid="tasks-saved" className={`text-sm ${saved.ok ? 'text-green-700 dark:text-green-400' : 'text-red-600'}`}>{saved.message}</span>}
      </div>
    </form>
  );
}
