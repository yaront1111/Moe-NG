import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { classifyViewportWidth, useViewportMode } from "./viewport.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const ORIGINAL_WIDTH = window.innerWidth;

function setWidth(width: number): void {
  window.innerWidth = width;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setWidth(ORIGINAL_WIDTH);
});

describe("classifyViewportWidth", () => {
  it.each([
    [959, "NARROW"],
    [960, "FUNCTIONAL"],
    [1199, "FUNCTIONAL"],
    [1200, "COMFORTABLE"],
  ] as const)("classifies the exclusive boundary at %d", (width, mode) => {
    expect(classifyViewportWidth(width)).toEqual({ mode, ok: true });
  });

  it("is total over a non-empty sweep of finite non-negative widths", () => {
    const widths = Array.from({ length: 2_001 }, (_, width) => width);
    expect(widths.length).toBeGreaterThan(0);

    const counts = { COMFORTABLE: 0, FUNCTIONAL: 0, NARROW: 0 };
    for (const width of widths) {
      const result = classifyViewportWidth(width);
      if (!result.ok) throw new Error(`finite width ${String(width)} was refused`);
      counts[result.mode] += 1;
    }

    expect(counts).toEqual({ COMFORTABLE: 801, FUNCTIONAL: 240, NARROW: 960 });
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "refuses invalid width %s with its stable reason",
    (width) => {
      expect(classifyViewportWidth(width)).toEqual({
        ok: false,
        reason: "INVALID_VIEWPORT_WIDTH",
      });
    },
  );
});

describe("useViewportMode", () => {
  it("updates from resize events in both directions", () => {
    setWidth(1_024);
    const hook = renderHook(useViewportMode);
    expect(hook.result.current).toEqual({ mode: "FUNCTIONAL", ok: true });

    act(() => {
      setWidth(800);
      window.dispatchEvent(new Event("resize"));
    });
    expect(hook.result.current).toEqual({ mode: "NARROW", ok: true });

    act(() => {
      setWidth(1_280);
      window.dispatchEvent(new Event("resize"));
    });
    expect(hook.result.current).toEqual({ mode: "COMFORTABLE", ok: true });
  });

  it("removes the exact resize listener on unmount", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const hook = renderHook(useViewportMode);
    const registration = add.mock.calls.find(([type]) => type === "resize");
    if (registration === undefined) throw new Error("resize listener was not registered");

    hook.unmount();

    expect(remove).toHaveBeenCalledWith("resize", registration[1]);
    expect(remove.mock.calls.filter(([type]) => type === "resize")).toHaveLength(1);
  });
});
