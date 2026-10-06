import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDb } from '../../../tests/helpers/temp-db';
import { createLogger } from '../logging';
import { readOnboarding } from '../onboarding';
import { createSettings } from '../settings';
import { createAi } from './index';
import { TASK_LABELS } from './settings';
import { saveAiChoices } from './wizard-save';

const log = createLogger({ level: 'silent' });
let t: ReturnType<typeof createTempDb>;
beforeEach(() => (t = createTempDb()));
afterEach(() => t.cleanup());

const answering = () =>
  new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'text', text: '{"ok":true}' }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } },
      warnings: [],
    }),
  });

function setup() {
  const settings = createSettings(t.db);
  const env: Record<string, string | undefined> = {};
  const events: string[] = [];
  const modelFactory = () => {
    events.push('model call');
    return answering();
  };
  const ai = createAi({ db: t.db, settings, log, env: () => env, modelFactory });
  const deps = {
    db: t.db,
    settings,
    log,
    ai,
    env: () => env,
    inDocker: false,
    shellDefines: () => false,
    modelFactory,
    writeKey: (k: string, v: string) => {
      events.push(`write ${k}`);
      env[k] = v;
    },
  };
  return { deps, settings, events };
}

const allOn = (provider: string, model: string, except: Record<string, string> = {}) => ({
  ...Object.fromEntries(['cv-extract', 'jd-analysis', 'match-evaluate', 'web-job-extract', 'cv-tailor', 'cover-letter', 'form-answers', 'inbox-classify'].flatMap((k) => [[`tasks.${k}.provider`, provider], [`tasks.${k}.model`, model]])),
  ...except,
});

describe('saveAiChoices', () => {
  it('writes a pasted key before checking readiness and testing, so the new key is seen', async () => {
    const { deps, events, settings } = setup();
    const r = await saveAiChoices(deps, { ...allOn('openai', 'gpt-5-mini'), 'apiKey.openai': 'sk-pasted-123456' });
    expect(r).toEqual({ ok: true, message: '' });
    expect(events[0]).toBe('write OPENAI_API_KEY');
    expect(events).toContain('model call');
    expect(events.indexOf('write OPENAI_API_KEY')).toBeLessThan(events.indexOf('model call'));
    expect(readOnboarding(settings)?.aiVerifiedAt).not.toBeNull();
  });

  it('without the key, it holds the step and says CV reading can be set to None', async () => {
    const { deps, settings } = setup();
    const r = await saveAiChoices(deps, allOn('openai', 'gpt-5-mini'));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('OPENAI_API_KEY');
    expect(r.message).toContain('set “Reading your CV” to None');
    expect(readOnboarding(settings)?.aiVerifiedAt ?? null).toBeNull();
  });

  it('when another task is the blocker, it names that task and does not point at CV reading', async () => {
    const { deps } = setup();
    const r = await saveAiChoices(deps, { ...allOn('none', ''), 'tasks.cover-letter.provider': 'openai', 'tasks.cover-letter.model': 'gpt-5' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('OPENAI_API_KEY');
    expect(r.message).not.toContain('set “Reading your CV” to None');
    expect(r.message).toContain(TASK_LABELS['cover-letter'].title);
  });

  it('everything None completes the step without calling a model', async () => {
    const { deps, events, settings } = setup();
    expect((await saveAiChoices(deps, allOn('none', ''))).ok).toBe(true);
    expect(events).toEqual([]);
    expect(readOnboarding(settings)?.aiVerifiedAt).not.toBeNull();
  });
});
