/**
 * Inbox-classifier eval (PLAN §4.3). Gates: accuracy ≥ 0.90 with a model, ≥ 0.75 with the offline rules, and
 * precision of the status-changing labels (interview, offer, rejection) ≥ 0.95 with a model, ≥ 0.80 offline.
 *
 *   pnpm eval:inbox --offline                  # offline rules
 *   EVAL_AI_PROVIDER=anthropic pnpm eval:inbox # with a real model; needs the provider key in .env
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AI_SETTINGS_KEY, AiSettingsSchema, createAi, type Ai } from '../src/server/ai';
import { openDb } from '../src/server/db';
import { createLogger } from '../src/server/logging';
import { createSettings } from '../src/server/settings';
import { classifyMessage } from '../src/server/tracking/classify';
import { EVAL_EMAILS } from './datasets/inbox';
import { loadEnvFiles, runMode } from '../src/server/config/env-files';

async function main() {
  loadEnvFiles(runMode());
  const offline = process.argv.includes('--offline');
  const dir = mkdtempSync(path.join(tmpdir(), 'job-scraper-eval-'));
  const { db, close } = openDb(path.join(dir, 'eval.db'));
  let ai: Ai | null = null;
  let label = 'offline';
  if (!offline) {
    const settings = createSettings(db);
    const provider = process.env.EVAL_AI_PROVIDER ?? 'openai';
    settings.set(AI_SETTINGS_KEY, AiSettingsSchema.parse({ provider, fastModel: process.env.EVAL_AI_MODEL ?? null, qualityModel: null, baseUrl: process.env.EVAL_AI_BASE_URL ?? null, dailyBudgetUsd: null }));
    ai = createAi({ db, settings, log: createLogger({ level: 'warn' }) });
    if (!ai.status().configured) {
      console.error(`AI not configured: ${ai.status().reason}`);
      process.exit(2);
    }
    label = `${provider}-${ai.status().models.fast}`;
  }
  const rows: Array<{ subject: string; expected: string; got: string; confidence: number; method: string }> = [];
  for (const m of EVAL_EMAILS) {
    const c = await classifyMessage(m, ai);
    rows.push({ subject: m.subject, expected: m.label, got: c.label, confidence: c.confidence, method: c.method });
    console.log(`${c.label === m.label ? '✓' : '✗'} ${m.subject} → ${c.label} (${c.confidence.toFixed(2)}, ${c.method})${c.label === m.label ? '' : ` expected ${m.label}`}`);
  }
  const accuracy = rows.filter((r) => r.expected === r.got).length / rows.length;
  // Labels that change an application's status must be precise: a false "rejection" or "offer" hurts most.
  const precision = Object.fromEntries(
    ['interview', 'offer', 'rejection'].map((l) => {
      const said = rows.filter((r) => r.got === l);
      return [l, said.length ? said.filter((r) => r.expected === l).length / said.length : 1];
    }),
  );
  const gate = offline ? 0.75 : 0.9;
  const precisionGate = offline ? 0.8 : 0.95;
  const pass = accuracy >= gate && Object.values(precision).every((p) => p >= precisionGate);
  console.log(`\naccuracy ${accuracy.toFixed(2)} (gate ≥ ${gate}); precision ${Object.entries(precision).map(([l, p]) => `${l} ${p.toFixed(2)}`).join(', ')} (gate ≥ ${precisionGate}) → ${pass ? 'PASS' : 'FAIL'}`);
  mkdirSync('evals/results/inbox', { recursive: true });
  const out = `evals/results/inbox/${new Date().toISOString().slice(0, 10)}-${label}.json`;
  writeFileSync(out, JSON.stringify({ label, accuracy, precision, pass, rows }, null, 2));
  console.log(`results → ${out}`);
  close();
  rmSync(dir, { recursive: true, force: true });
  process.exit(pass ? 0 : 1);
}

main();
