import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileStore, StoragePaths, UnsafePathError } from './index';

let dir: string;
beforeEach(() => (dir = mkdtempSync(path.join(tmpdir(), 'job-scraper-files-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('file store', () => {
  it('writes and reads nested files, creating directories', async () => {
    const store = createFileStore(dir);
    const abs = await store.write('applications/7/cv.json', '{"a":1}');
    expect(abs).toBe(path.join(dir, 'applications/7/cv.json'));
    expect((await store.read('applications/7/cv.json')).toString()).toBe('{"a":1}');
    expect(await store.exists('applications/7/cv.json')).toBe(true);
  });

  it.each(['../escape.txt', 'a/../../escape.txt', '/etc/passwd', '', '.'])('rejects unsafe path %j', (p) => {
    const store = createFileStore(dir);
    expect(() => store.resolve(p)).toThrow(UnsafePathError);
  });

  it('removes a whole application directory and tolerates missing paths', async () => {
    const store = createFileStore(dir);
    await store.write(`${StoragePaths.applicationDir(3)}/cv.pdf`, 'x');
    await store.write(`${StoragePaths.masterCvDir(1)}/cv.pdf`, 'master');
    await store.remove(StoragePaths.applicationDir(3));
    expect(await store.exists(StoragePaths.applicationDir(3))).toBe(false);
    expect(await store.exists(`${StoragePaths.masterCvDir(1)}/cv.pdf`)).toBe(true);
    await expect(store.remove('applications/999')).resolves.toBeUndefined();
  });
});

describe.skipIf(process.platform === 'win32')('file permissions (other users on this computer)', () => {
  it('generated files are readable only by you', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'js-perm-'));
    try {
      const store = createFileStore(path.join(root, 'files'));
      await store.write('applications/1/CV.pdf', 'pdf');
      expect(statSync(path.join(root, 'files/applications/1/CV.pdf')).mode & 0o077).toBe(0);
      expect(statSync(path.join(root, 'files/applications/1')).mode & 0o077).toBe(0);
      expect(statSync(path.join(root, 'files')).mode & 0o077).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
