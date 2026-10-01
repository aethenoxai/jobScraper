import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySessionToken } from '@/server/access';
import { getAppContext } from '@/server/context';
import { getSystemStatus } from '@/server/status';
import { healthPayload } from '@/server/status/health';

export const dynamic = 'force-dynamic';

export async function GET() {
  const password = process.env.APP_PASSWORD;
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const signedIn = !!password && !!token && verifySessionToken(token, password, Date.now());
  return Response.json(healthPayload(getSystemStatus(getAppContext()), { passwordSet: !!password, signedIn }));
}
