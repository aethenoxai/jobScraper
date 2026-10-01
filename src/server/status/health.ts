/**
 * What /api/health answers. It stays reachable without signing in (Docker's health check uses it), so with
 * APP_PASSWORD set an anonymous caller only learns whether the app and its worker are up.
 */
import type { SystemStatus } from './index';

export function healthPayload(status: SystemStatus, access: { passwordSet: boolean; signedIn: boolean }) {
  if (access.passwordSet && !access.signedIn) return { ok: true, worker: { online: status.worker.online } };
  return { ok: true, ...status };
}
