/** Glue between the engine (browser, overlay) and the application flow. */
import { runApplication, type ApplyInput, type ApplyOutcome } from './apply';
import type { BrowserEngine } from './engine';

/** `beforeStart` runs inside the site lock, right before the browser opens (limits are re-checked there). */
export async function applyOnWebsite(engine: BrowserEngine, input: Omit<ApplyInput, 'log'> & { heading: string; log: (step: string) => void; beforeStart?: () => void }): Promise<ApplyOutcome> {
  return engine.withPage(
    input.url,
    (page, show) =>
      runApplication(page, {
        ...input,
        log: (step) => {
          input.log(step);
          void show(`${input.heading}\n${step}`);
        },
      }),
    input.signal,
    input.beforeStart,
  );
}
