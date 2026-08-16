import { NextRequest, NextResponse } from 'next/server';
import { generateCsrfValue, signCsrfToken, verifyCsrfToken } from '@/lib/server/csrf';

export const config = {
  matcher: '/api/:path*',
};

const CSRF_COOKIE = 'csrf_token';
const CSRF_HEADER = 'x-csrf-token';
const WRITE_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

export async function proxy(request: NextRequest) {
  const response = NextResponse.next();
  const existingCookie = request.cookies.get(CSRF_COOKIE)?.value;

  // Bootstrap a signed token for clients that don't have one yet so the
  // double-submit pattern has something to compare against next request.
  if (!existingCookie) {
    const signed = await signCsrfToken(generateCsrfValue());
    response.cookies.set(CSRF_COOKIE, signed, {
      httpOnly: false,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
    });
  }

  if (!WRITE_METHODS.has(request.method)) {
    return response;
  }

  const headerToken = request.headers.get(CSRF_HEADER);
  const cookieToken = existingCookie;

  // Public GET-style opt-outs aren't relevant here since we already
  // returned above for non-write methods.
  if (!headerToken || !cookieToken) {
    return NextResponse.json({ error: 'Missing CSRF token' }, { status: 401 });
  }

  const cookieIsValid = await verifyCsrfToken(cookieToken);
  if (!cookieIsValid || headerToken !== cookieToken) {
    return NextResponse.json({ error: 'CSRF token mismatch' }, { status: 403 });
  }

  return response;
}
