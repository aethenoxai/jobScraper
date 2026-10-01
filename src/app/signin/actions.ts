'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createSessionToken, safeNext, SESSION_COOKIE, SESSION_DAYS, verifyPassword } from '@/server/access';

/** Slows down guessing: each wrong password costs a second. */
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function signInAction(_prev: { error: string } | null, formData: FormData): Promise<{ error: string } | null> {
  const password = process.env.APP_PASSWORD;
  if (!password) redirect('/');
  if (!verifyPassword(String(formData.get('password') ?? ''), password)) {
    await delay(1000);
    return { error: 'That password is not right.' };
  }
  (await cookies()).set(SESSION_COOKIE, createSessionToken(password, Date.now()), { httpOnly: true, sameSite: 'strict', path: '/', maxAge: SESSION_DAYS * 86_400 });
  redirect(safeNext(String(formData.get('next') ?? '/')));
}
