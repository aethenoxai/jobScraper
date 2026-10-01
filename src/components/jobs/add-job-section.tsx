import { AddJobUrlForm, PasteJobForm } from './add-job-forms';

export function AddJobForms() {
  return (
    <div className="space-y-3">
      <AddJobUrlForm />
      <details className="text-sm">
        <summary className="cursor-pointer text-neutral-600 dark:text-neutral-400">Paste a job (for LinkedIn, Indeed and other sites that can’t be read automatically)</summary>
        <div className="mt-3">
          <PasteJobForm />
        </div>
      </details>
    </div>
  );
}
