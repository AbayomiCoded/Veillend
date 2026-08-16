import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export async function POST(request: Request) {
  try {
    const { walletAddress } = await request.json();

    if (!walletAddress) {
      return NextResponse.json({ error: 'walletAddress is required' }, { status: 400 });
    }

    const res = await fetch(`${API_BASE_URL}/auth/nonce`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress }),
    });

    if (!res.ok) {
      return NextResponse.json({ error: 'Challenge request failed' }, { status: res.status });
    }

    const data = await res.json();
    if (!data.nonce) {
      return NextResponse.json({ error: 'Backend did not return a nonce' }, { status: 500 });
    }

    const cookieStore = await cookies();
    // Temporarily store the nonce linked to the wallet address
    cookieStore.set(`nonce_${walletAddress}`, data.nonce, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 60, // 60 seconds
      path: '/',
    });

    return NextResponse.json({ nonce: data.nonce });
  } catch (error) {
    console.error('Nonce error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
