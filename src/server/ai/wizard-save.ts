import { registerSecret, scrubSecrets } from '../logging';
import { updateOnboarding } from '../onboarding';
import { testProvider, type ConnectDeps, type ConnectResult } from './connect';
import type { Ai } from './index';
import { applyProviderForm, applyTaskForm, updateAiSettings } from './provider-view';
import { AI_PROVIDERS, AI_TASKS, KEY_ENV_VAR, TASK_LABELS } from './settings';

const NONE_WAY = ' To go on anyway, set “Reading your CV” to None: your CV is then read on this computer, without AI.';

/**
 * The setup wizard's AI step: a pasted key goes to .env FIRST (so the checks below see it), then the routes are saved,
 * every task naming a provider must be ready, and the provider that reads the CV answers one tiny call.
 * `ok` means the step is done (aiVerifiedAt is set). A task set to "None" runs offline on purpose.
 */
export async function saveAiChoices(deps: ConnectDeps & { ai: Pick<Ai, 'taskStatus'> }, fields: Record<string, string>): Promise<ConnectResult> {
  for (const p of AI_PROVIDERS) {
    const keyVar = KEY_ENV_VAR[p];
    const key = (fields[`apiKey.${p}`] ?? '').trim();
    if (!keyVar || !key) continue;
    registerSecret(key);
    if (deps.inDocker) return { ok: false, message: `In Docker, add ${keyVar}=<your key> to the .env file next to docker-compose.yml, run "docker compose up -d", then continue.` };
    if (deps.shellDefines(keyVar)) return { ok: false, message: `${keyVar} is set in the shell that started Job Scraper, and that value wins over .env. Leave the field empty, or remove it from the shell and restart.` };
    try {
      deps.writeKey(keyVar, key);
    } catch (err) {
      return { ok: false, message: `Could not save the key to .env: ${scrubSecrets(err instanceof Error ? err.message : String(err))}` };
    }
  }
  try {
    updateAiSettings(deps.settings, deps.env(), (c) => applyProviderForm(applyTaskForm(c, fields), fields));
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Please check the form.' };
  }
  const stuck = AI_TASKS.map((t) => deps.ai.taskStatus(t)).filter((s) => s.provider !== 'none' && !s.configured);
  // Only a blocked CV-reading task can be cleared by choosing None for it: don't send the user there for another task.
  if (stuck.length) return { ok: false, message: stuck.map((s) => `${TASK_LABELS[s.task].title}: ${s.reason}`).join(' ') + (stuck.some((s) => s.task === 'cv-extract') ? NONE_WAY : '') };
  const reading = deps.ai.taskStatus('cv-extract');
  if (reading.provider !== 'none') {
    const tested = await testProvider(deps, { provider: reading.provider, model: reading.model ?? '' });
    if (!tested.ok) return { ok: false, message: tested.message + NONE_WAY };
  }
  updateOnboarding(deps.settings, (s) => ({ ...s, aiVerifiedAt: Date.now() }));
  return { ok: true, message: '' };
}
