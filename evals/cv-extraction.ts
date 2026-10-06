/**
 * CV extraction eval (PLAN §4.3). Gates: mean field F1 ≥ 0.90 and zero hallucinated contact fields.
 *
 *   pnpm eval:cv --offline                      # score the rule-based extractor (no key needed)
 *   EVAL_AI_PROVIDER=anthropic pnpm eval:cv     # score AI extraction; needs the provider key in .env
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Ai } from '../src/server/ai';
import { evalAi } from './lib/ai';
import { openDb } from '../src/server/db';
import { createLogger } from '../src/server/logging';
import { extractProfile } from '../src/server/profile/extract';
import { SYNTHETIC_CVS } from '../tests/fixtures/cvs/synthetic';
import { scoreCvExtraction } from './lib/score';
import { loadEnvFiles, runMode } from '../src/server/config/env-files';

const GATE_F1 = 0.9;

async function main() {
  loadEnvFiles(runMode());
  const offline = process.argv.includes('--offline');
  const dir = mkdtempSync(path.join(tmpdir(), 'job-scraper-eval-'));
  const { db, close } = openDb(path.join(dir, 'eval.db'));
  let ai: Ai | null = null;
  let label = 'offline';
  if (!offline) {
    const e = evalAi(db, createLogger({ level: 'warn' }), { fast: ['cv-extract'] });
    ai = e.ai;
    label = `${e.provider}-${e.fast}`;
  }

  const rows = [];
  for (const cv of SYNTHETIC_CVS) {
    const r = await extractProfile(cv.text, ai, { now: new Date('2026-10-01') });
    const s = scoreCvExtraction(cv.expect, r.data, cv.text);
    rows.push({ slug: cv.slug, method: r.method, ...s });
    console.log(`${cv.slug.padEnd(28)} F1 ${s.f1.toFixed(2)}  ${r.method}${s.misses.length ? `  misses: ${s.misses.join('; ')}` : ''}${s.hallucinations.length ? `  HALLUCINATED: ${s.hallucinations.join(', ')}` : ''}`);
  }
  const meanF1 = rows.reduce((a, r) => a + r.f1, 0) / rows.length;
  const hallucinations = rows.reduce((a, r) => a + r.hallucinations.length, 0);
  const pass = meanF1 >= GATE_F1 && hallucinations === 0;
  console.log(`\nmean F1 ${meanF1.toFixed(3)} (gate ≥ ${GATE_F1}) · hallucinations ${hallucinations} (gate 0) → ${pass ? 'PASS' : 'FAIL'}`);

  mkdirSync('evals/results/cv-extraction', { recursive: true });
  const out = `evals/results/cv-extraction/${new Date().toISOString().slice(0, 10)}-${label}.json`;
  writeFileSync(out, JSON.stringify({ label, meanF1, hallucinations, pass, rows }, null, 2));
  console.log(`results → ${out}`);
  close();
  rmSync(dir, { recursive: true, force: true });
  process.exit(pass ? 0 : 1);
}

main();
