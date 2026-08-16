import { NextResponse } from 'next/server';
import { backendFetch } from '@/lib/server/backendFetch';

export async function GET() {
  try {
    const res = await backendFetch('/auth/session');
    
    if (!res.ok) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: res.status });
    }
    
    const data = await res.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Session error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
