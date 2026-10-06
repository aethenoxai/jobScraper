import type { Ai } from '../ai';
import type { JobRequirements } from '../matching/analysis';
import type { TailoringIntensity } from '../matching/slider';
import type { ProfileData } from '../profile/model';
import { TailoredCvSchema, type TailoredCv } from './model';
import { offlineTailor } from './offline';
import { allowedHeadlines, repairTailoredCv, validateTailoredCv, type Violation } from './validate';

const AiTailorSchema = TailoredCvSchema.omit({ intensity: true, method: true });

const INTENSITY: Record<TailoringIntensity, string> = {
  light: 'LIGHT: keep every bullet\'s wording; only reorder bullets, skills and sections and write a focused summary.',
  standard: 'STANDARD: reorder, and rewrite bullets to use the job\'s terminology where it is truthful; write a focused summary.',
  deep: 'DEEP: restructure for this job: lead with the most relevant achievements, merge related bullets (cite all their sources), drop irrelevant ones, choose the most relevant projects.',
};

const SYSTEM = `You tailor a candidate's CV to one job. You may only use facts from the candidate's profile.
Hard rules (violations are rejected automatically):
- Every bullet must cite the ids of the profile bullets it is based on (sources), from the SAME job or project.
- Never add numbers, skills, tools, employers, titles, degrees or responsibilities that are not in the cited sources or the profile.
- Keep every number exactly as written in the source.
- skills: only skills from the profile (you may reorder them, most relevant first).
- headline: one of the allowed headlines.
- Include every job and every degree of the profile (you may shorten bullets). List every section that has content exactly once in sectionOrder. Never claim more years of experience than the profile states.
- A bullet may only name skills, tools, clients and amounts that its cited lines (or that job's own lines) contain.
- summary: at most 70 words, first person implied, no buzzwords, only facts from the profile.`;

function profilePrompt(p: ProfileData): string {
  return [
    `Allowed headlines (titles the candidate has held): ${allowedHeadlines(p).join(' | ') || 'none'}`,
    `Years of experience: ${p.yearsExperience ?? 'unknown'}`,
    `Current summary: ${p.summary ?? 'none'}`,
    `Skills: ${p.skills.map((s) => s.name).join(', ')}`,
    'Jobs (id: title @ company):',
    ...p.experience.flatMap((e) => [`${e.id}: ${e.title ?? ''} @ ${e.company ?? ''}`, ...e.bullets.map((b) => `  - ${b.id}: ${b.text}`)]),
    'Projects (id: name):',
    ...p.projects.flatMap((pr) => [`${pr.id}: ${pr.name} — ${pr.description ?? ''} [${pr.technologies.join(', ')}]`, ...pr.bullets.map((b) => `  - ${b.id}: ${b.text}`)]),
    `Education ids: ${p.education.map((e) => `${e.id} (${e.degree ?? ''}, ${e.institution ?? ''})`).join('; ') || 'none'}`,
    `Certification ids: ${p.certifications.map((c) => `${c.id} (${c.name})`).join('; ') || 'none'}`,
    `Language ids: ${p.languages.map((l) => `${l.id} (${l.name})`).join('; ') || 'none'}`,
  ].join('\n');
}

export interface TailorResult {
  cv: TailoredCv;
  /** Parts replaced by master data after the model failed to fix them. */
  repairs: number;
  /** Rule violations in the model's first answer (quality signal for evals). */
  firstPassViolations: number;
  /** Why the AI could not be used, when the offline version was used instead. */
  aiError?: string;
}

export async function tailorCv(input: {
  profile: ProfileData;
  analysis: JobRequirements;
  intensity: TailoringIntensity;
  job: { title: string; company: string };
  ai: Ai | null;
  signal?: AbortSignal;
}): Promise<TailorResult> {
  const offline = offlineTailor(input.profile, input.analysis, input.intensity);
  if (!input.ai?.taskStatus('cv-tailor').configured) return { cv: offline, repairs: 0, firstPassViolations: 0 };

  const jobPrompt = [
    `Job: ${input.job.title} at ${input.job.company}`,
    'Requirements:',
    ...input.analysis.requirements.map((r) => `- [${r.mandatory ? 'required' : 'preferred'}] ${r.text}`),
    `Skills the job names: ${input.analysis.skills.join(', ')}`,
    `Tailoring level: ${INTENSITY[input.intensity]}`,
  ].join('\n');
  const ask = (extra = '') =>
    input.ai!.generateObject({ task: 'cv-tailor', schema: AiTailorSchema, system: SYSTEM, prompt: `${jobPrompt}\n\nCandidate profile:\n${profilePrompt(input.profile)}${extra}`, timeoutMs: 180_000, signal: input.signal });
  // Jobs always stay in the profile's (chronological) order; relevance shows through bullets, not by moving jobs.
  const rank = (id: string) => input.profile.experience.findIndex((x) => x.id === id);
  const complete = (out: Omit<TailoredCv, 'intensity' | 'method'>): TailoredCv => ({ ...out, experience: [...out.experience].sort((a, b) => rank(a.id) - rank(b.id)), intensity: input.intensity, method: 'ai' });

  try {
    let cv = complete(await ask());
    let violations: Violation[] = validateTailoredCv(cv, input.profile);
    const firstPassViolations = violations.length;
    if (violations.length) {
      const previous = JSON.stringify(cv);
      cv = complete(await ask(`\n\nYour previous answer broke these rules:\n${violations.map((v) => `- ${v.path}: ${v.message}`).join('\n')}\nPrevious answer:\n${previous}\nReturn a corrected CV.`));
      violations = validateTailoredCv(cv, input.profile);
    }
    if (!violations.length) return { cv, repairs: 0, firstPassViolations };
    return { cv: repairTailoredCv(cv, input.profile, offline.summary), repairs: violations.length, firstPassViolations };
  } catch (err) {
    // Shutting down: let the task be retried instead of saving the offline version.
    if (input.signal?.aborted) throw err;
    return { cv: offline, repairs: 0, firstPassViolations: 0, aiError: err instanceof Error ? err.message : String(err) };
  }
}
