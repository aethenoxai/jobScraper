/**
 * Tailoring eval (PLAN §4.3, M5). For every job a profile should see (the matching dataset's "surface" pairs):
 *   - grounding: the tailored CV passes the validator (gate: 100%, N3 — no invented facts)
 *   - coverage: job keywords the profile can back up that appear where readers look first, tailored vs master
 *     (gate: tailored ≥ master on average — tailoring must never bury what the job asks for)
 *
 *   pnpm eval:tailoring --offline                  # offline tailoring (no key needed)
 *   EVAL_AI_PROVIDER=anthropic pnpm eval:tailoring # with a real model; needs the provider key in .env
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Ai } from '../src/server/ai';
import { evalAi } from './lib/ai';
import { openDb } from '../src/server/db';
import { createLogger } from '../src/server/logging';
import { analyzeJob } from '../src/server/matching/analysis';
import { assignIds } from '../src/server/profile/model';
import { tailorCv } from '../src/server/tailoring/ai';
import { validateTailoredCv } from '../src/server/tailoring/validate';
import { EVAL_JOBS, EVAL_PROFILES } from './datasets/matching';
import { coverage, evidencedKeywords, prominentMasterText, prominentTailoredText } from './lib/tailoring-score';
import { FABRICATIONS, fabricationProfile, groundedCv, LETTER_FABRICATIONS, LETTER_JOB, LETTER_NORMAL, NORMAL_EDITS } from './datasets/fabrications';
import { validateCoverLetter, writeCoverLetter } from '../src/server/tailoring/cover-letter';
import { loadEnvFiles, runMode } from '../src/server/config/env-files';

async function main() {
  loadEnvFiles(runMode());
  const offline = process.argv.includes('--offline');
  const intensity = (process.env.EVAL_INTENSITY as 'light' | 'standard' | 'deep' | undefined) ?? 'standard';
  const dir = mkdtempSync(path.join(tmpdir(), 'job-scraper-eval-'));
  const { db, close } = openDb(path.join(dir, 'eval.db'));
  const log = createLogger({ level: 'warn' });
  let ai: Ai | null = null;
  let label = `offline-${intensity}`;
  if (!offline) {
    const e = evalAi(db, log, { fast: ['jd-analysis'], quality: ['cv-tailor', 'cover-letter'] });
    ai = e.ai;
    label = `${e.provider}-${e.quality}-${intensity}`;
  }

  // 1. The validator itself: every fabrication flagged, no normal edit flagged (no model needed).
  const fp = fabricationProfile();
  if (validateTailoredCv(groundedCv(), fp).length) throw new Error('The grounded fixture CV must validate');
  const run = (c: { apply: (cv: ReturnType<typeof groundedCv>) => void }) => {
    const cv = groundedCv();
    c.apply(cv);
    return validateTailoredCv(cv, fp).length > 0;
  };
  const missed = FABRICATIONS.filter((c) => !run(c)).map((c) => c.name);
  const overBlocked = NORMAL_EDITS.filter((c) => run(c)).map((c) => c.name);
  const letterFlags = (text: string) => validateCoverLetter({ greeting: 'Dear Acme Payments hiring team,', paragraphs: [text], closing: 'Kind regards,', method: 'ai' }, fp, LETTER_JOB).length > 0;
  missed.push(...LETTER_FABRICATIONS.filter((c) => !letterFlags(c.text)).map((c) => `letter: ${c.name}`));
  overBlocked.push(...LETTER_NORMAL.filter((c) => letterFlags(c.text)).map((c) => `letter: ${c.name}`));
  const total = FABRICATIONS.length + LETTER_FABRICATIONS.length;
  const normal = NORMAL_EDITS.length + LETTER_NORMAL.length;
  console.log(`validators (CV + cover letter): caught ${total - missed.length}/${total} fabrications${missed.length ? ` (missed: ${missed.join(', ')})` : ''} · allowed ${normal - overBlocked.length}/${normal} normal edits${overBlocked.length ? ` (blocked: ${overBlocked.join(', ')})` : ''}\n`);

  // 2. Tailoring the dataset's matching jobs.
  const rows: Array<{ profile: string; title: string; method: string; repairs: number; firstPass: number; violations: string[]; keywords: string[]; master: number; tailored: number }> = [];
  for (const [i, j] of EVAL_JOBS.filter((x) => x.surface).entries()) {
    const p = EVAL_PROFILES.find((x) => x.key === j.profile)!;
    const profile = assignIds(structuredClone(p.data));
    const analysis = await analyzeJob({ title: j.title, description: j.description, descriptionHash: `eval-${i}` }, { db, ai });
    const { cv, repairs, firstPassViolations } = await tailorCv({ profile, analysis, intensity, job: { title: j.title, company: j.company }, ai });
    const letter = await writeCoverLetter({ profile, analysis, job: { title: j.title, company: j.company, description: j.description }, ai });
    const violations = [...validateTailoredCv(cv, profile), ...validateCoverLetter(letter.letter, profile, { title: j.title, company: j.company, description: j.description }).map((v) => ({ ...v, path: `letter: ${v.path}` }))];
    const keys = evidencedKeywords(profile, analysis);
    const master = coverage(keys, prominentMasterText(profile));
    const tailored = coverage(keys, prominentTailoredText(cv));
    rows.push({ profile: j.profile, title: j.title, method: cv.method, repairs, firstPass: firstPassViolations, violations: violations.map((v) => `${v.path}: ${v.message}`), keywords: keys, master, tailored });
    console.log(`${violations.length ? '✗' : '✓'} [${j.profile}] ${j.title} · ${cv.method}${repairs ? ` (${repairs} repaired)` : ''} · keywords ${keys.length} · coverage ${master.toFixed(2)} → ${tailored.toFixed(2)}${violations.length ? ` · ${violations.map((v) => v.message).join('; ')}` : ''}`);
  }
  const grounded = rows.filter((r) => r.violations.length === 0).length / rows.length;
  const avg = (k: 'master' | 'tailored') => rows.reduce((a, r) => a + r[k], 0) / rows.length;
  const firstPassClean = rows.filter((r) => r.firstPass === 0).length / rows.length;
  const pass = missed.length === 0 && overBlocked.length === 0 && grounded === 1 && avg('tailored') >= avg('master');
  console.log(
    `\nvalidator recall ${missed.length ? 'FAIL' : '100%'} · precision ${overBlocked.length ? 'FAIL' : '100%'} · grounded ${(grounded * 100).toFixed(0)}% (gate 100%) · first answers clean ${(firstPassClean * 100).toFixed(0)}% (report) · coverage master ${avg('master').toFixed(2)} → tailored ${avg('tailored').toFixed(2)} (gate: not lower) → ${pass ? 'PASS' : 'FAIL'}`,
  );
  mkdirSync('evals/results/tailoring', { recursive: true });
  const out = `evals/results/tailoring/${new Date().toISOString().slice(0, 10)}-${label}.json`;
  writeFileSync(out, JSON.stringify({ label, validator: { missed, overBlocked }, grounded, firstPassClean, coverage: { master: avg('master'), tailored: avg('tailored') }, pass, rows }, null, 2));
  console.log(`results → ${out}`);
  close();
  rmSync(dir, { recursive: true, force: true });
  process.exit(pass ? 0 : 1);
}

main();
