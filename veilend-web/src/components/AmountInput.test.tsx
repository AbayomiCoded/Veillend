// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AmountInput } from "./AmountInput";
import type { ValidationContext } from "@/lib/validation/amount";

const context: ValidationContext = {
  availableBalance: 100,
  priceUsd: 1,
  decimals: 7,
  borrowLimitUsd: 0,
  outstandingDebt: 0,
};

describe("AmountInput Max button", () => {
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
  });

  const render = async (value = "", onChange = vi.fn()) => {
    await act(async () => {
      root.render(
        <AmountInput
          action="DEPOSIT"
          context={context}
          assetSymbol="USDC"
          value={value}
          onChange={onChange}
        />
      );
    });
  };

  it("renders the Max button with the exact accessible label", async () => {
    await render();

    const max = container.querySelector('button[aria-label="Use maximum available amount"]');
    expect(max).not.toBeNull();
    expect(max?.tagName).toBe("BUTTON");
  });

  it("fills the maximum amount on keyboard-focusable activation", async () => {
    const onChange = vi.fn();
    await render("", onChange);

    const max = container.querySelector(
      'button[aria-label="Use maximum available amount"]'
    ) as HTMLButtonElement;

    max.focus();
    expect(document.activeElement).toBe(max);

    await act(async () => {
      max.click();
    });
    expect(onChange).toHaveBeenCalledWith("100");
  });
});
