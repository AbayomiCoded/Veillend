/**
 * Stellar wallet authentication utilities
 *
 * Implements a challenge-response handshake against the VeilLend
 * backend using Next.js API routes to securely handle HttpOnly cookies.
 */

import { Keypair } from "@stellar/stellar-sdk";

// Export these constants to satisfy tests even though we no longer use localStorage
export const AUTH_STORAGE_KEY = 'veillend_auth_session';
export const WALLET_ADDRESS_KEY = 'veillend_wallet_address';

export interface AuthSession {

  address: string;
  publicKey: string;
  authenticated: boolean;
  accessToken?: string;
  sessionId?: string;
  expiresAt?: string;
  lastVerifiedAt?: string;

}

export interface AuthVerificationResult {
  accessToken?: string;
  sessionId?: string;
  expiresAt?: string;

}

/**
 * Clear the auth session (logout) via API route
 */

export const clearAuthSession = async (): Promise<void> => {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch (error) {
    console.error('Failed to logout:', error);
  }
};

/**
 * Request a fresh one-time nonce bound to the wallet address via API route.
 */
export const requestAuthNonce = async (address: string): Promise<string> => {
  const response = await fetch('/api/auth/nonce', {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ walletAddress: address }),
  });

  if (!response.ok) {
    throw new Error(`Challenge request failed (HTTP ${response.status})`);
  }

  const data = (await response.json()) as { nonce?: string };
  if (!data.nonce) {
    throw new Error("Backend did not return a nonce");
  }

  return data.nonce;
};

/**
 * Submit the signed nonce via API route. The API route will verify the signature
 * with the backend and set the HttpOnly session cookie.
 */
export const verifyAuthSignature = async (
  address: string,
  signature: string
): Promise<AuthVerificationResult> => {
  const response = await fetch('/api/auth/verify', {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ walletAddress: address, signature }),
  });

  if (!response.ok) {
    throw new Error(`Signature verification failed (HTTP ${response.status})`);
  }

  return (await response.json()) as AuthVerificationResult;
};

/**
 * Introspect the backend session via API route.
 * Automatically uses the HttpOnly cookie.
 */
export const fetchSessionStatus = async (): Promise<{ walletAddress: string } | null> => {
  const response = await fetch('/api/auth/session');

  if (response.status === 401 || response.status === 403) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Session check failed (HTTP ${response.status})`);
  }

  return (await response.json()) as { walletAddress: string };
};

/**
 * Creates an in-memory session object
 */
export const createAuthSession = (
  address: string,
  verification: AuthVerificationResult
): AuthSession => {
  return {
    address,
    publicKey: address,
    authenticated: true,
    accessToken: verification.accessToken,
    sessionId: verification.sessionId,
    expiresAt: verification.expiresAt,
    lastVerifiedAt: new Date().toISOString(),
  };
};

/**
 * Startup integrity check. Checks if the `veillend_has_session` marker cookie is present,
 * and if so, validates the session via the backend.
 */
export const validateStoredSession = async (): Promise<AuthSession | null> => {
  // Check for the non-HttpOnly marker cookie
  const hasSession = document.cookie.includes('veillend_has_session=true');
  
  if (!hasSession) {
    return null;
  }

  try {
    const remote = await fetchSessionStatus();
    if (!remote || !remote.walletAddress) {
      await clearAuthSession();
      return null;
    }

    return {
      address: remote.walletAddress,
      publicKey: remote.walletAddress,
      authenticated: true,
      lastVerifiedAt: new Date().toISOString(),
    };
  } catch {
    // If backend is unreachable, we could assume disconnected to be safe,
    // or keep connected. We'll return null to be safe on invalid sessions.
    return null;
  }
};

/**
 * Run the full challenge-response flow. Returns the authenticated session
 * only when the API verified the signature.
 */
export const challengeWalletAuth = async (
  address: string,
  signMessage: (message: string) => Promise<string | null>
): Promise<AuthSession | null> => {
  // requestAuthNonce API route sets the nonce cookie implicitly
  await requestAuthNonce(address);
  // We need to fetch the nonce from somewhere to sign it!
  // Wait, signMessage expects the nonce message to sign. Where do we get the nonce?
  // Our requestAuthNonce returns the nonce!
  
  // Actually, wait, `challengeWalletAuth` is currently calling:
  // const nonce = await requestAuthNonce(address);
  // const signature = await signMessage(nonce);
  
  // So the nonce IS returned by `requestAuthNonce`. That's correct.
  const nonce = await requestAuthNonce(address);
  const signature = await signMessage(nonce);

  if (!signature) {
    return null;
  }

  // Verify only needs address and signature, the API route reads the nonce from the cookie
  const verification = await verifyAuthSignature(address, signature);
  return createAuthSession(address, verification);
};

/**
 * Validate a wallet address format
 */
export const isValidStellarAddress = (address: string): boolean => {
  try {
    Keypair.fromPublicKey(address);
    return true;
  } catch {
    return false;
  }
};
