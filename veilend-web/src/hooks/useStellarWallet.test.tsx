// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { useEffect } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WalletProvider, useWallet } from "@/context/WalletContext";
import type { WalletContextType } from "@/context/WalletContext";

const TEST_ADDRESS = "GBXFXNDLV4LSWA4VB7YIL5GBD7BVNR22SGBTDKMO2SBZZHDXSKZYCP7L";
const AUTH_KEY = "veillend_auth";
const WALLET_KEY = "veillend_wallet_address";

const mocks = vi.hoisted(() => ({
  connectFreighter: vi.fn(),
  signMessage: vi.fn(),
  disconnectWallet: vi.fn(),
}));

vi.mock("@/lib/stellar/wallet", () => ({
  isFreighterInstalled: () => true,
  connectFreighter: mocks.connectFreighter,
  signMessage: mocks.signMessage,
  disconnectWallet: mocks.disconnectWallet,
}));

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function Harness({ onUpdate }: { onUpdate: (state: WalletContextType) => void }) {
  const wallet = useWallet();

  useEffect(() => {
    onUpdate(wallet);
  });

  return (
    <div>
      <button
        data-testid="connect"
        onClick={() => {
          void wallet.connect();
        }}
      >
        Connect
      </button>
      <span data-testid="authed">{String(wallet.isAuthenticated)}</span>
    </div>
  );
}

describe("useStellarWallet / WalletProvider challenge-response flow", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    window.localStorage.clear();

    mocks.connectFreighter.mockResolvedValue({
      address: TEST_ADDRESS,
      publicKey: TEST_ADDRESS,
    });
    mocks.signMessage.mockResolvedValue("c2lnbmF0dXJl");
    mocks.disconnectWallet.mockResolvedValue(undefined);

    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  const renderProvider = async (updates: WalletContextType[]) => {
    await act(async () => {
      root.render(
        <WalletProvider>
          <Harness onUpdate={(state) => updates.push(state)} />
        </WalletProvider>
      );
    });
  };

  const clickConnect = async () => {
    const button = container.querySelector<HTMLButtonElement>(
      "[data-testid=connect]"
    );
    expect(button).not.toBeNull();
    await act(async () => {
      button?.click();
    });
  };

  it("becomes authenticated in the React context only after backend verification", async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      if (String(url).endsWith("/auth/nonce")) {
        return jsonResponse({ nonce: "nonce-123" });
      }
      if (String(url).endsWith("/auth/verify")) {
        return jsonResponse({
          accessToken: "access-token-1",
          sessionId: "session-1",
          expiresAt: "2027-01-01T00:00:00.000Z",
        });
      }
      throw new Error(`unexpected url ${String(url)}`);
    });

    const updates: WalletContextType[] = [];
    await renderProvider(updates);

    expect(updates.at(-1)?.isAuthenticated).toBe(false);
    expect(container.querySelector("[data-testid=authed]")?.textContent).toBe("false");

    await clickConnect();

    expect(updates.at(-1)?.isAuthenticated).toBe(true);
    expect(updates.at(-1)?.address).toBe(TEST_ADDRESS);
    expect(container.querySelector("[data-testid=authed]")?.textContent).toBe("true");
    expect(window.localStorage.getItem(WALLET_KEY)).toBe(TEST_ADDRESS);
    expect(window.localStorage.getItem(AUTH_KEY)).toContain("access-token-1");
  });

  it("stays disconnected when the wallet does not submit a signature", async () => {
    mocks.signMessage.mockResolvedValue(null);
    fetchMock.mockImplementation(async (url: string | URL) => {
      if (String(url).endsWith("/auth/nonce")) {
        return jsonResponse({ nonce: "nonce-123" });
      }
      throw new Error(`verify must not be reached (got ${String(url)})`);
    });

    const updates: WalletContextType[] = [];
    await renderProvider(updates);
    await clickConnect();

    expect(updates.at(-1)?.isAuthenticated).toBe(false);
    expect(window.localStorage.getItem(AUTH_KEY)).toBeNull();
    expect(window.localStorage.getItem(WALLET_KEY)).toBeNull();
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("/auth/verify"))
    ).toBe(false);
  });

  it("stays disconnected when the backend rejects the signature", async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      if (String(url).endsWith("/auth/nonce")) {
        return jsonResponse({ nonce: "nonce-123" });
      }
      if (String(url).endsWith("/auth/verify")) {
        return jsonResponse({ error: "invalid signature" }, 401);
      }
      throw new Error(`unexpected url ${String(url)}`);
    });

    const updates: WalletContextType[] = [];
    await renderProvider(updates);
    await clickConnect();

    expect(updates.at(-1)?.isAuthenticated).toBe(false);
    expect(window.localStorage.getItem(AUTH_KEY)).toBeNull();
    expect(window.localStorage.getItem(WALLET_KEY)).toBeNull();
  });

  it("clears a forged localStorage address on page load and falls back to disconnected", async () => {
    window.localStorage.setItem(WALLET_KEY, TEST_ADDRESS);

    const updates: WalletContextType[] = [];
    await renderProvider(updates);

    expect(updates.at(-1)?.isAuthenticated).toBe(false);
    expect(updates.at(-1)?.address).toBeNull();
    expect(window.localStorage.getItem(WALLET_KEY)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("auto-logs-out a forged session the backend rejects on page load", async () => {
    window.localStorage.setItem(
      AUTH_KEY,
      JSON.stringify({
        address: TEST_ADDRESS,
        publicKey: TEST_ADDRESS,
        authenticated: true,
        accessToken: "forged-token",
        expiresAt: "2027-01-01T00:00:00.000Z",
      })
    );
    window.localStorage.setItem(WALLET_KEY, TEST_ADDRESS);
    fetchMock.mockResolvedValue(jsonResponse({ error: "unauthorized" }, 401));

    const updates: WalletContextType[] = [];
    await renderProvider(updates);

    expect(updates.at(-1)?.isAuthenticated).toBe(false);
    expect(window.localStorage.getItem(AUTH_KEY)).toBeNull();
    expect(window.localStorage.getItem(WALLET_KEY)).toBeNull();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/auth/session");
  });

  it("restores a valid session confirmed by the backend on page load", async () => {
    window.localStorage.setItem(
      AUTH_KEY,
      JSON.stringify({
        address: TEST_ADDRESS,
        publicKey: TEST_ADDRESS,
        authenticated: true,
        accessToken: "access-token-1",
        expiresAt: "2027-01-01T00:00:00.000Z",
      })
    );
    window.localStorage.setItem(WALLET_KEY, TEST_ADDRESS);
    fetchMock.mockResolvedValue(jsonResponse({ walletAddress: TEST_ADDRESS }));

    const updates: WalletContextType[] = [];
    await renderProvider(updates);

    expect(updates.at(-1)?.isAuthenticated).toBe(true);
    expect(updates.at(-1)?.address).toBe(TEST_ADDRESS);
  });
});
