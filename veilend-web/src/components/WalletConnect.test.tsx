// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WalletProvider } from "@/context/WalletContext";
import { WalletConnect } from "./WalletConnect";

// Keep the real wallet helpers; only pin installation to "true" so the
// disconnected trigger (rather than an install prompt) is rendered.
vi.mock("@/lib/stellar/wallet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stellar/wallet")>();
  return { ...actual, isFreighterInstalled: () => true };
});

describe("WalletConnect trigger", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  const render = async () => {
    await act(async () => {
      root.render(
        <WalletProvider>
          <WalletConnect />
        </WalletProvider>
      );
    });
  };

  it("exposes dialog semantics and an accessible name on the trigger", async () => {
    await render();

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]');
    expect(trigger).not.toBeNull();
    expect(trigger?.tagName).toBe("BUTTON");
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    expect(trigger?.getAttribute("aria-controls")).toBe("wallet-connect-dialog");
    expect(trigger?.textContent).toContain("Connect Wallet");
  });

  it("toggles aria-expanded and opens the dialog on activation", async () => {
    await render();

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]');
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");

    await act(async () => {
      trigger?.click();
    });

    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("Connect Wallet");
  });
});
