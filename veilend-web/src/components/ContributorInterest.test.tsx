// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ContributorInterest } from "./ContributorInterest";

describe("ContributorInterest", () => {
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

  const render = async () => {
    await act(async () => {
      root.render(<ContributorInterest />);
    });
  };

  it("renders toggle chips as native buttons with aria-pressed", async () => {
    await render();

    const chips = Array.from(container.querySelectorAll("button"));
    expect(chips).toHaveLength(5);
    expect(chips.every((c) => c.tagName === "BUTTON")).toBe(true);
    expect(chips.every((c) => c.getAttribute("aria-pressed") === "false")).toBe(true);
  });

  it("exposes the selected state via aria-pressed on activation", async () => {
    await render();

    const first = container.querySelector("button") as HTMLButtonElement;

    await act(async () => {
      first.click();
    });

    expect(first.getAttribute("aria-pressed")).toBe("true");
    const others = Array.from(container.querySelectorAll("button")).slice(1);
    expect(others.every((c) => c.getAttribute("aria-pressed") === "false")).toBe(true);
  });

  it("supports keyboard focus for every chip", async () => {
    await render();

    const chips = Array.from(container.querySelectorAll("button")) as HTMLButtonElement[];
    for (const chip of chips) {
      chip.focus();
      expect(document.activeElement).toBe(chip);
    }
  });
});
