import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

export async function POST() {
  const cookieStore = await cookies();
  cookieStore.delete('veillend_session');
  cookieStore.delete('veillend_has_session');
  
  return NextResponse.json({ success: true });
}
