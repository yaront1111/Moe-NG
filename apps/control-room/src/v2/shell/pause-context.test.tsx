import { cleanup, render, screen } from "@testing-library/react";
import type { JSX } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { ProviderPauseProvider, useProviderPause } from "./pause-context.js";
import type { ProviderPause } from "./pause-context.js";

/**
 * The shell-wide pause fact. One poll fills it at the app root; every consumer
 * under the shell reads it here rather than polling /health/read itself.
 *
 * The fail-safe direction matters more than the happy path: a screen rendered in
 * a unit test with no provider above it must render, not crash, and must say
 * nothing about pauses - `null` is "no pause known", never "not paused for sure".
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  cleanup();
});

/** 3a's own five-key fixture, verbatim from live/live-ops.test.ts. */
const PAUSE: ProviderPause = Object.freeze({
  lastLine: "You've hit your weekly limit - resets Sep 8, 10:46am (Asia/Jerusalem)",
  provider: "claude",
  resetAt: "2026-09-02T20:30:00.000Z",
  since: "2026-09-02T20:00:00.000Z",
  workItemId: "node.deliver@node-1",
});

const OTHER: ProviderPause = Object.freeze({
  ...PAUSE, provider: "codex", resetAt: "2026-09-03T06:15:00.000Z",
});

function Consumer(): JSX.Element {
  const paused = useProviderPause();
  return (
    <span data-testid="probe">
      {paused === null ? "NONE" : `${paused.provider}|${paused.resetAt}|${paused.workItemId}`}
    </span>
  );
}

function probe(): string {
  return screen.getByTestId("probe").textContent ?? "";
}

describe("useProviderPause", () => {
  it("reads null with no provider above it, so an unwrapped screen never crashes", () => {
    render(<Consumer />);

    expect(probe()).toBe("NONE");
  });

  it("reads the provided pause verbatim", () => {
    render(<ProviderPauseProvider value={PAUSE}><Consumer /></ProviderPauseProvider>);

    expect(probe()).toBe("claude|2026-09-02T20:30:00.000Z|node.deliver@node-1");
  });

  it("re-renders the consumer when the polled value changes", () => {
    const view = render(
      <ProviderPauseProvider value={PAUSE}><Consumer /></ProviderPauseProvider>,
    );
    expect(probe()).toBe("claude|2026-09-02T20:30:00.000Z|node.deliver@node-1");

    view.rerender(<ProviderPauseProvider value={OTHER}><Consumer /></ProviderPauseProvider>);
    expect(probe()).toBe("codex|2026-09-03T06:15:00.000Z|node.deliver@node-1");

    // The pause clearing is the same edge: the next poll answers null and the
    // consumer must follow it down, not keep the stale pause on screen.
    view.rerender(<ProviderPauseProvider value={null}><Consumer /></ProviderPauseProvider>);
    expect(probe()).toBe("NONE");
  });

  it("reads null when the provider carries null", () => {
    render(<ProviderPauseProvider value={null}><Consumer /></ProviderPauseProvider>);

    expect(probe()).toBe("NONE");
  });
});
