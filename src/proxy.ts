/**
 * Every request passes here first (Next.js proxy): only this computer's addresses are served (DNS-rebinding
 * protection), and with APP_PASSWORD set, a signed session cookie is required (PRD §54).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { checkAccess, SESSION_COOKIE } from '@/server/access';

export function proxy(request: NextRequest) {
  const decision = checkAccess({ host: request.headers.get('host'), path: request.nextUrl.pathname, cookie: request.cookies.get(SESSION_COOKIE)?.value ?? null }, process.env, Date.now());
  if (decision.allow) return NextResponse.next();
  if (decision.redirect) return NextResponse.redirect(new URL(decision.redirect, request.url));
  return new NextResponse(decision.reason, { status: decision.status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

export const config = {
  // Everything except Next's own static assets.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
