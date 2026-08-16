// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import VeilLendLandingPage from "@/components/VeilLendLandingPage";
import { WalletProvider } from "@/context/WalletContext";

const dashboardMocks = vi.hoisted(() => ({
  walletState: {
    isConnected: true,
    isAuthenticated: true,
    address: "GBXFXNDLV4LSWA4VB7YIL5GBD7BVNR22SGBTDKMO2SBZZHDXSKZYCP7L",
    isLoading: false,
    error: null as string | null,
  },
}));

vi.mock("@/context/WalletContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/context/WalletContext")>();
  return {
    ...actual,
    useWallet: () => dashboardMocks.walletState,
  };
});

vi.mock("@/components/WalletConnect", () => ({
  WalletConnect: () => <div>wallet-connect-stub</div>,
}));
vi.mock("@/components/WalletStatus", () => ({
  WalletStatus: () => <div>wallet-status-stub</div>,
}));
vi.mock("@/components/ActionTray", () => ({
  ActionTray: () => <div>action-tray-stub</div>,
}));

import VeilLendDashboard from "@/app/(dashboard)/page";

function getFocusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  );
}

describe("page landmarks and keyboard access", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("landing page", () => {
    it("has exactly one main landmark and one visible h1", async () => {
      await act(async () => {
        root.render(
          <WalletProvider>
            <VeilLendLandingPage />
          </WalletProvider>
        );
      });

      expect(container.querySelectorAll("main")).toHaveLength(1);
      expect(container.querySelectorAll("h1")).toHaveLength(1);
    });

    it("keeps every interactive control keyboard focusable", async () => {
      await act(async () => {
        root.render(
          <WalletProvider>
            <VeilLendLandingPage />
          </WalletProvider>
        );
      });

      const focusables = getFocusableElements(container);
      expect(focusables.length).toBeGreaterThan(0);

      for (const el of focusables) {
        el.focus();
        expect(document.activeElement).toBe(el);
      }
    });
  });

  describe("dashboard page", () => {
    it("has exactly one main landmark and one visible h1 when connected", async () => {
      dashboardMocks.walletState.isConnected = true;
      dashboardMocks.walletState.isAuthenticated = true;

      await act(async () => {
        root.render(<VeilLendDashboard />);
      });

      expect(container.querySelectorAll("main")).toHaveLength(1);
      expect(container.querySelectorAll("h1")).toHaveLength(1);
    });

    it("has exactly one main landmark and one visible h1 when disconnected", async () => {
      dashboardMocks.walletState.isConnected = false;
      dashboardMocks.walletState.isAuthenticated = false;

      await act(async () => {
        root.render(<VeilLendDashboard />);
      });

      expect(container.querySelectorAll("main")).toHaveLength(1);
      expect(container.querySelectorAll("h1")).toHaveLength(1);
      expect(container.querySelector("h1")?.textContent).toContain("Connect Wallet");
    });
  });
});
