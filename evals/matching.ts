/**
 * Matching eval (PLAN §4.3). Gates: precision ≥ 0.80 and recall ≥ 0.70 at the default slider (100).
 *
 *   pnpm eval:matching --offline                  # offline rules (no key needed)
 *   EVAL_AI_PROVIDER=anthropic pnpm eval:matching # with a real model; needs the provider key in .env
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AI_SETTINGS_KEY, AiSettingsSchema, createAi, type Ai } from '../src/server/ai';
import { openDb } from '../src/server/db';
import { sources } from '../src/server/db/schema';
import { createIngestor } from '../src/server/jobs/ingest';
import { createLogger } from '../src/server/logging';
import { createMatchService } from '../src/server/matching/service';
import { createProfileService } from '../src/server/profile/service';
import { createQueue } from '../src/server/queue';
import { createSettings } from '../src/server/settings';
import { createFileStore } from '../src/server/storage';
import { EVAL_JOBS, EVAL_PROFILES } from './datasets/matching';
import { precisionRecall } from './lib/matching-score';
import { loadEnvFiles, runMode } from '../src/server/config/env-files';

const GATE_PRECISION = 0.8;
const GATE_RECALL = 0.7;

async function main() {
  loadEnvFiles(runMode());
  const offline = process.argv.includes('--offline');
  const dir = mkdtempSync(path.join(tmpdir(), 'job-scraper-eval-'));
  const { db, close } = openDb(path.join(dir, 'eval.db'));
  const log = createLogger({ level: 'warn' });
  let ai: Ai | null = null;
  let label = 'offline';
  if (!offline) {
    const settings = createSettings(db);
    const provider = process.env.EVAL_AI_PROVIDER ?? 'openai';
    settings.set(AI_SETTINGS_KEY, AiSettingsSchema.parse({ provider, fastModel: process.env.EVAL_AI_MODEL ?? null, qualityModel: null, baseUrl: process.env.EVAL_AI_BASE_URL ?? null, dailyBudgetUsd: null }));
    ai = createAi({ db, settings, log });
    if (!ai.status().configured) {
      console.error(`AI not configured: ${ai.status().reason}`);
      process.exit(2);
    }
    label = `${provider}-${ai.status().models.fast}`;
  }
  const profiles = createProfileService({ db, files: createFileStore(path.join(dir, 'files')) });
  const matching = createMatchService({ db, ai, queue: createQueue(db), profiles, log });
  const ingestor = createIngestor({ db });
  const src = db.insert(sources).values({ adapterId: 'manual', name: 'eval', config: {}, origin: 'user', createdAt: new Date() }).returning().get().id;
  const profileIds = new Map<string, number>();
  for (const p of EVAL_PROFILES) {
    const rec = profiles.create(p.key, p.data);
    profiles.updatePreferences(rec.id, p.preferences, 100);
    profileIds.set(p.key, rec.id);
  }

  const rows = [];
  for (const [i, j] of EVAL_JOBS.entries()) {
    const [jobId] = ingestor.ingestRun(src, [{ sourceJobId: `eval-${i}`, sourceUrl: `https://eval.example/${i}`, title: j.title, company: j.company, location: j.location, workMode: j.workMode, description: j.description }], { completeSnapshot: false }).changedJobIds;
    const r = await matching.evaluate(jobId, profileIds.get(j.profile)!);
    const surfaced = r.decision === 'surfaced';
    rows.push({ ...j, score: r.score, surfaced, expected: j.surface });
    const mark = surfaced === j.surface ? '✓' : '✗';
    console.log(`${mark} [${j.profile}] ${j.title} @ ${j.location} → ${r.score}% ${surfaced ? 'shown' : 'hidden'} (expected ${j.surface ? 'shown' : 'hidden'}: ${j.why})`);
  }
  const pr = precisionRecall(rows);
  const pass = pr.precision >= GATE_PRECISION && pr.recall >= GATE_RECALL;
  console.log(`\nprecision ${pr.precision.toFixed(2)} (gate ≥ ${GATE_PRECISION}) · recall ${pr.recall.toFixed(2)} (gate ≥ ${GATE_RECALL}) → ${pass ? 'PASS' : 'FAIL'}`);
  mkdirSync('evals/results/matching', { recursive: true });
  const out = `evals/results/matching/${new Date().toISOString().slice(0, 10)}-${label}.json`;
  writeFileSync(out, JSON.stringify({ label, ...pr, pass, rows }, null, 2));
  console.log(`results → ${out}`);
  close();
  rmSync(dir, { recursive: true, force: true });
  process.exit(pass ? 0 : 1);
}

main();
