import { randomBytes } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class UnsafePathError extends Error {
  override name = 'UnsafePathError';
}

export interface FileStore {
  root: string;
  resolve(relPath: string): string;
  write(relPath: string, data: string | Uint8Array): Promise<string>;
  read(relPath: string): Promise<Buffer>;
  exists(relPath: string): Promise<boolean>;
  remove(relPath: string): Promise<void>;
}

export const StoragePaths = {
  profileDir: (profileId: number) => `profiles/${profileId}`,
  masterCvDir: (profileId: number) => `profiles/${profileId}/master-cv`,
  applicationDir: (applicationId: number) => `applications/${applicationId}`,
} as const;

export function createFileStore(rootDir: string): FileStore {
  const root = path.resolve(rootDir);

  function resolve(relPath: string): string {
    const abs = path.resolve(root, relPath);
    if (!abs.startsWith(root + path.sep)) throw new UnsafePathError(`Path is outside the data directory: ${relPath}`);
    return abs;
  }

  return {
    root,
    resolve,
    async write(relPath, data) {
      const abs = resolve(relPath);
      // Readable only by the user: CVs, letters and screenshots carry personal data (also on shared computers).
      await mkdir(path.dirname(abs), { recursive: true, mode: 0o700 });
      // Write then rename, so a reader (e.g. a download during a re-render) never sees a half-written file.
      const tmp = `${abs}.${randomBytes(4).toString('hex')}.tmp`;
      await writeFile(tmp, data, { mode: 0o600 });
      await rename(tmp, abs);
      return abs;
    },
    read: (relPath) => readFile(resolve(relPath)),
    async exists(relPath) {
      try {
        await access(resolve(relPath));
        return true;
      } catch {
        return false;
      }
    },
    async remove(relPath) {
      await rm(resolve(relPath), { recursive: true, force: true });
    },
  };
}
