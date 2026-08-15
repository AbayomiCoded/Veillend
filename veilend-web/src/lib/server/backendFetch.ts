import { cookies } from 'next/headers';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

/**
 * Wrapper around fetch for server-side requests to the backend.
 * Automatically attaches the veillend_session token if present.
 */
export async function backendFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get('veillend_session');

  const headers = new Headers(options.headers);
  if (sessionCookie) {
    headers.set('Authorization', `Bearer ${sessionCookie.value}`);
  }

  // Ensure path starts with a slash
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;

  return fetch(`${API_BASE_URL}${normalizedPath}`, {
    ...options,
    headers,
  });
}
