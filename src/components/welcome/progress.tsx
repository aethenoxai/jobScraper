import Link from 'next/link';

export const STEP_ORDER = ['ai', 'cv', 'review', 'preferences', 'start'] as const;
export type WizardStep = (typeof STEP_ORDER)[number];

const LABELS: Record<WizardStep, string> = { ai: 'AI model', cv: 'Your CV', review: 'Check your profile', preferences: 'Jobs you want', start: 'Start' };

/** "Step 2 of 5" with the steps named; steps already reached can be opened again. */
export function Progress({ current, reached }: { current: WizardStep; reached: WizardStep }) {
  const at = STEP_ORDER.indexOf(current);
  const furthest = STEP_ORDER.indexOf(reached);
  return (
    <nav aria-label="Setup steps">
      <p className="mb-2 text-sm text-neutral-500" data-testid="wizard-progress">
        Step {at + 1} of {STEP_ORDER.length}
      </p>
      <ol className="flex flex-wrap gap-2 text-xs">
        {STEP_ORDER.map((s, i) => {
          const style = i === at ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900' : i < furthest ? 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300' : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800';
          const label = `${i + 1}. ${LABELS[s]}`;
          return (
            <li key={s} aria-current={i === at ? 'step' : undefined} className={`rounded-full px-3 py-1 ${style}`}>
              {i < furthest && i !== at ? <Link href={`/welcome?step=${s}`}>{label}</Link> : label}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
