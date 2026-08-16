"use client";

import { useState, useEffect, useCallback } from "react";
import {
  validateStoredSession,
  clearAuthSession,
  createAuthSession,
  requestAuthNonce,
  verifyAuthSignature,
} from "@/lib/stellar/auth";
import {
  connectFreighter,
  isFreighterInstalled,
  disconnectWallet,
  signMessage,
} from "@/lib/stellar/wallet";

export interface WalletState {
  address: string | null;
  publicKey: string | null;
  isConnected: boolean;
  isAuthenticated: boolean;
  isInstalled: boolean;
  isLoading: boolean;
  error: string | null;
}

export interface WalletActions {
  connect: () => Promise<boolean>;
  disconnect: () => Promise<void>;
  clearError: () => void;
}

export function useStellarWallet(): WalletState & WalletActions {
  const [state, setState] = useState<WalletState>({
    address: null,
    publicKey: null,
    isConnected: false,
    isAuthenticated: false,
    isInstalled: false,
    isLoading: false,
    error: null,
  });

  // On mount: check Freighter installation and reconcile any stored session
  // against the backend. Forged / stale records are cleared (auto-logout).
  useEffect(() => {
    let cancelled = false;

    const initializeWallet = async () => {
      const installed = isFreighterInstalled();
      const session = await validateStoredSession();

      if (cancelled) return;

      setState((prev) => ({
        ...prev,
        isInstalled: installed,
        address: session?.address ?? null,
        publicKey: session?.publicKey ?? null,
        isConnected: session !== null,
        isAuthenticated: session !== null,
      }));
    };

    initializeWallet();

    return () => {
      cancelled = true;
    };
  }, []);

  const connect = useCallback(async (): Promise<boolean> => {
    if (state.isLoading) return false;

    setState((prev) => ({ ...prev, isLoading: true, error: null }));

    try {
      const wallet = await connectFreighter();

      // Challenge-response: only the backend can authorise the session.
      const nonce = await requestAuthNonce(wallet.address);
      const signature = await signMessage(nonce, wallet.publicKey);

      if (!signature) {
        throw new Error("Signature was not submitted; authentication cancelled.");
      }

      const verification = await verifyAuthSignature(
        wallet.address,
        signature
      );

      // Persist ONLY after the backend confirmed the signature.
      const session = createAuthSession(wallet.address, verification);

      setState((prev) => ({
        ...prev,
        address: session.address,
        publicKey: session.publicKey,
        isConnected: true,
        isAuthenticated: true,
        isLoading: false,
        error: null,
      }));

      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Failed to connect wallet";
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: errorMessage,
        isConnected: false,
        isAuthenticated: false,
      }));

      return false;
    }
  }, [state.isLoading]);

  const disconnect = useCallback(async () => {
    try {
      await disconnectWallet();
      await clearAuthSession();

      setState((prev) => ({
        ...prev,
        address: null,
        publicKey: null,
        isConnected: false,
        isAuthenticated: false,
        error: null,
      }));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Failed to disconnect wallet";
      setState((prev) => ({
        ...prev,
        error: errorMessage,
      }));
    }
  }, []);

  const clearError = useCallback(() => {
    setState((prev) => ({ ...prev, error: null }));
  }, []);

  return {
    ...state,
    connect,
    disconnect,
    clearError,
  };
}
