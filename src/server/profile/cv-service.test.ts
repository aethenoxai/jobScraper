import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDb } from '../../../tests/helpers/temp-db';
import { createLogger } from '../logging';
import { createQueue, PermanentError } from '../queue';
import { masterCvs } from '../db/schema';
import { createFileStore } from '../storage';
import { CvTooLargeError, MAX_CV_BYTES, UnsupportedCvTypeError } from './cv-text';
import { createCvService, PROFILE_EXTRACT_TASK } from './cv-service';
import { createProfileService } from './service';
import type { Ai } from '../ai';
import { fakeRoutes } from '../ai/fake';
import { heuristicExtract } from './heuristic';

/** A valid answer from the model (contents don't matter to these tests). */
const okExtraction = () => ({ ...heuristicExtract('Asha Rao', new Date()), personal: { fullName: 'Asha Rao', email: null, phone: null, location: null, country: null, timezone: null, links: [] }, careerLevel: null }) as never;
const fixture = (name: string) => readFileSync(path.resolve('tests/fixtures/cvs/files', name));
const log = createLogger({ level: 'silent' });
let t: ReturnType<typeof createTempDb>;
beforeEach(() => (t = createTempDb()));
afterEach(() => t.cleanup());

function setup() {
  const files = createFileStore(path.join(t.dir, 'files'));
  const queue = createQueue(t.db);
  const profiles = createProfileService({ db: t.db, files });
  const cvs = createCvService({ db: t.db, files, queue, profiles, ai: null, log });
  return { files, queue, profiles, cvs };
}

describe('cv service', () => {
  it('stores an uploaded CV and queues extraction', async () => {
    const { cvs, profiles, queue, files } = setup();
    const p = profiles.create('Engineer');
    const cv = await cvs.upload(p.id, '../../Asha CV (final).pdf', fixture('software-engineer-india.pdf'));
    expect(cv).toMatchObject({ profileId: p.id, status: 'uploaded', mime: 'application/pdf', originalName: '../../Asha CV (final).pdf' });
    expect(cv.path).toMatch(/^profiles\/\d+\/master-cv\/\d+-Asha_CV_final_.pdf$/);
    expect(await files.exists(cv.path)).toBe(true);
    const task = queue.claim('w', [PROFILE_EXTRACT_TASK]);
    expect(task?.payload).toEqual({ masterCvId: cv.id });
  });

  it('rejects unsupported and oversized files before storing anything', async () => {
    const { cvs, profiles } = setup();
    const p = profiles.create('A');
    await expect(cvs.upload(p.id, 'cv.txt', Buffer.from('plain text'))).rejects.toBeInstanceOf(UnsupportedCvTypeError);
    await expect(cvs.upload(p.id, 'big.pdf', Buffer.alloc(MAX_CV_BYTES + 1))).rejects.toBeInstanceOf(CvTooLargeError);
    expect(cvs.list(p.id)).toEqual([]);
  });

  it('fills a fresh profile directly from its first CV', async () => {
    const { cvs, profiles } = setup();
    const p = profiles.create('Engineer');
    const cv = await cvs.upload(p.id, 'cv.docx', fixture('software-engineer-india.docx'));
    await cvs.runExtraction(cv.id);
    expect(cvs.get(cv.id)).toMatchObject({ status: 'applied', extractionMethod: 'heuristic' });
    expect(profiles.get(p.id)?.data.personal.email).toBe('asha.rao@example.com');
  });

  it('holds a later CV for review when the profile already has data, then applies accepted fields', async () => {
    const { cvs, profiles } = setup();
    const p = profiles.create('Engineer');
    const first = await cvs.upload(p.id, 'cv.pdf', fixture('software-engineer-india.pdf'));
    await cvs.runExtraction(first.id);
    const edited = profiles.get(p.id)!.data;
    edited.headline = 'Staff Engineer';
    profiles.updateData(p.id, edited, { byUser: true });

    const second = await cvs.upload(p.id, 'nurse.pdf', fixture('nurse-uk.pdf'));
    await cvs.runExtraction(second.id);
    expect(cvs.get(second.id)?.status).toBe('extracted');
    expect(profiles.get(p.id)?.data.headline).toBe('Staff Engineer');

    const pending = cvs.pendingReview(p.id);
    expect(pending?.changes.map((c) => c.key)).toContain('personal.email');
    cvs.applyPending(second.id, ['personal.email']);
    const after = profiles.get(p.id)!.data;
    expect(after.personal.email).toBe('olivia.bennett@example.org');
    expect(after.headline).toBe('Staff Engineer');
    expect(cvs.get(second.id)?.status).toBe('applied');
    expect(cvs.pendingReview(p.id)).toBeNull();
  });

  it('records unreadable CVs as failed without retrying', async () => {
    const { cvs, profiles } = setup();
    const p = profiles.create('A');
    const cv = await cvs.upload(p.id, 'scan.pdf', fixture('image-only.pdf'));
    await expect(cvs.runExtraction(cv.id)).rejects.toBeInstanceOf(PermanentError);
    expect(cvs.get(cv.id)).toMatchObject({ status: 'failed' });
    expect(cvs.get(cv.id)?.error).toMatch(/scanned image/);
  });

  it('two CVs uploaded to a new profile: only one fills it, the other waits for review (M1 deferred minor)', async () => {
    const { cvs, profiles } = setup();
    const p = profiles.create('A');
    const a = await cvs.upload(p.id, 'a.pdf', fixture('software-engineer-india.pdf'));
    const b = await cvs.upload(p.id, 'b.pdf', fixture('nurse-uk.pdf'));
    await Promise.all([cvs.runExtraction(a.id), cvs.runExtraction(b.id)]);
    expect([cvs.get(a.id)?.status, cvs.get(b.id)?.status].sort()).toEqual(['applied', 'extracted']);
  });

  it('explains a PDF that is far too long to be a CV', async () => {
    const { cvs, profiles } = setup();
    const p = profiles.create('A');
    const pages = Array.from({ length: 40 }, (_, i) => `${4 + i * 2} 0 R`).join(' ');
    // Pages without content are enough: the page count is checked before any text is read.
    const objs = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${pages}] /Count 40 >>`, '<< >>'];
    for (let i = 0; i < 40; i++) objs.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>', '<< /Length 0 >>\nstream\n\nendstream');
    const pdf = Buffer.from(`%PDF-1.4\n${objs.map((o, i) => `${i + 1} 0 obj\n${o}\nendobj\n`).join('')}trailer\n<< /Root 1 0 R >>\n%%EOF\n`, 'latin1');
    const cv = await cvs.upload(p.id, 'thesis.pdf', pdf);
    await expect(cvs.runExtraction(cv.id)).rejects.toBeInstanceOf(PermanentError);
    expect(cvs.get(cv.id)?.error).toMatch(/40 pages/);
  });

  it('dismisses a pending review', async () => {
    const { cvs, profiles } = setup();
    const p = profiles.create('A');
    profiles.updateData(p.id, profiles.get(p.id)!.data, { byUser: true });
    const cv = await cvs.upload(p.id, 'cv.pdf', fixture('sales-manager-us.pdf'));
    await cvs.runExtraction(cv.id);
    cvs.dismissPending(cv.id);
    expect(cvs.get(cv.id)?.status).toBe('dismissed');
    expect(cvs.pendingReview(p.id)).toBeNull();
  });

  it('never overwrites edits the user saves while extraction is running', async () => {
    const files = createFileStore(path.join(t.dir, 'files'));
    const queue = createQueue(t.db);
    const profiles = createProfileService({ db: t.db, files });
    const p = profiles.create('Engineer');
    const slowAi: Ai = {
      ...fakeRoutes(['cv-extract']),
      generateObject: async () => {
        const edited = profiles.get(p.id)!.data;
        edited.personal.fullName = 'Typed By User';
        profiles.updateData(p.id, edited, { byUser: true }); // user saves mid-extraction
        return okExtraction();
      },
    };
    const cvs = createCvService({ db: t.db, files, queue, profiles, ai: slowAi, log });
    const cv = await cvs.upload(p.id, 'cv.pdf', fixture('software-engineer-india.pdf'));
    await cvs.runExtraction(cv.id);
    expect(profiles.get(p.id)?.data.personal.fullName).toBe('Typed By User');
    expect(cvs.get(cv.id)?.status).toBe('extracted');
  });

  it('marks a CV failed (not stuck extracting) when it cannot be parsed', async () => {
    const { cvs, profiles } = setup();
    const p = profiles.create('A');
    const cv = await cvs.upload(p.id, 'broken.pdf', Buffer.from('%PDF-1.7\n garbage that is not a pdf at all'));
    await expect(cvs.runExtraction(cv.id)).rejects.toBeInstanceOf(PermanentError);
    expect(cvs.get(cv.id)).toMatchObject({ status: 'failed' });
    expect(cvs.get(cv.id)?.error).toMatch(/could not be read/i);
  });

  it('recovers CVs left mid-extraction by a crash', async () => {
    const { cvs, profiles, queue } = setup();
    const p = profiles.create('A');
    const cv = await cvs.upload(p.id, 'cv.pdf', fixture('nurse-uk.pdf'));
    for (let t = queue.claim('w', [PROFILE_EXTRACT_TASK]); t; t = queue.claim('w', [PROFILE_EXTRACT_TASK])) queue.complete(t.id);
    t.db.update(masterCvs).set({ status: 'extracting' }).run();
    expect(cvs.recoverInterrupted()).toBe(1);
    expect(cvs.get(cv.id)?.status).toBe('uploaded');
    expect(queue.claim('w', [PROFILE_EXTRACT_TASK])?.payload).toEqual({ masterCvId: cv.id });
  });
});

describe('heuristic output', () => {
  it('is always valid, even for bullet-only lines', () => {
    const p = heuristicExtract('Jane Doe\njane@example.com\n\nProjects\nThing — a project\n•\n• real bullet\n', new Date());
    expect(p.projects[0].bullets.map((b) => b.text)).toEqual(['real bullet']);
  });

  describe('reading with the AI the user set up', () => {
    function withAi(fail: boolean) {
      const files = createFileStore(path.join(t.dir, 'files'));
      const queue = createQueue(t.db);
      const profiles = createProfileService({ db: t.db, files });
      const seen: Array<{ mediaType?: string }> = [];
      const ai: Ai = {
        ...fakeRoutes(['cv-extract']),
        generateObject: async (req) => {
          seen.push({ mediaType: req.file?.mediaType });
          if (fail) throw new Error('model overloaded');
          return okExtraction();
        },
      };
      return { queue, profiles, seen, cvs: createCvService({ db: t.db, files, queue, profiles, ai, log }) };
    }

    it('gives the model a PDF as a document; Word files go as their text', async () => {
      const { cvs, profiles, seen } = withAi(false);
      const p = profiles.create('A');
      await cvs.runExtraction((await cvs.upload(p.id, 'cv.pdf', fixture('software-engineer-india.pdf'))).id);
      const q = profiles.create('B');
      await cvs.runExtraction((await cvs.upload(q.id, 'cv.doc', fixture('software-engineer-india.doc'))).id);
      expect(seen).toEqual([{ mediaType: 'application/pdf' }, { mediaType: undefined }]);
    });

    it('a CV the AI could not read is marked failed with the reason (no retry loop), and can be tried again', async () => {
      const { cvs, profiles, queue } = withAi(true);
      const p = profiles.create('A');
      const cv = await cvs.upload(p.id, 'cv.pdf', fixture('software-engineer-india.pdf'));
      const task = queue.claim('w', [PROFILE_EXTRACT_TASK])!;
      const err = await cvs.runExtraction(cv.id).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PermanentError);
      queue.fail(task.id, err as Error); // as the worker does
      expect(cvs.get(cv.id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/AI couldn.t read your CV: model overloaded/) });
      cvs.retry(cv.id);
      expect(cvs.get(cv.id)).toMatchObject({ status: 'uploaded', error: null });
      expect(queue.claim('w', [PROFILE_EXTRACT_TASK])?.payload).toEqual({ masterCvId: cv.id });
    });
  });
});
