import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { GoalSourceOutcome } from "../../live/live-goal-source.js";
import { LivePrd, PrdPanel } from "./prd-panel.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const SOURCE: GoalSourceOutcome = {
  byteLength: 42, contentSha256: "a".repeat(64), displayPath: "docs/PRD.md", mediaType: "text/markdown",
  sourceRef: "prd", status: "GOAL_SOURCE", text: "# UnAI\n\n## 1. Goal\n\nThe product.\n",
};

describe("PrdPanel", () => {
  it("folds the stored text behind its path, size and digest, as stored", () => {
    render(<PrdPanel outcome={SOURCE} />);
    expect(screen.getByTestId("cr.prd.summary").textContent).toBe("THE PRD · docs/PRD.md · 42 bytes · text/markdown");
    expect(screen.getByTestId("cr.prd.digest").textContent).toBe(`sha256 ${"a".repeat(64)}`);
    expect(screen.getByTestId("cr.prd.text").textContent).toBe(SOURCE.text);
    expect(screen.getByTestId("cr.prd.root").hasAttribute("open")).toBe(false);
  });

  it("says a goal has no PRD, shows other refusals by code, and the loading state", () => {
    render(<PrdPanel outcome={{ code: "GOAL_SOURCE_UNBOUND", layer: "DAEMON_READ_MODEL", status: "REFUSED" }} />);
    expect(screen.getByTestId("cr.prd.unbound").textContent).toBe("This goal was created without a PRD.");
    cleanup();
    render(<PrdPanel outcome={{ code: "GOAL_SOURCE_INVALID", layer: "DAEMON_READ_MODEL", status: "REFUSED" }} />);
    expect(screen.getByTestId("cr.prd.refusal").textContent).toBe("REFUSED · GOAL_SOURCE_INVALID · DAEMON_READ_MODEL");
    cleanup();
    render(<PrdPanel outcome={null} />);
    expect(screen.getByTestId("cr.prd.loading")).toBeTruthy();
  });
});

describe("LivePrd", () => {
  it("reads the goal's source once through the injected reader", async () => {
    const read = vi.fn(async (_goalRef: string) => SOURCE);
    render(<LivePrd goalRef="goal-1" headers={{}} read={read} />);
    expect((await screen.findByTestId("cr.prd.text")).textContent).toBe(SOURCE.text);
    expect(read).toHaveBeenCalledWith("goal-1");
    expect(read).toHaveBeenCalledTimes(1);
    cleanup();
    render(<LivePrd goalRef="goal-1" headers={{}} read={() => Promise.reject(new Error("x"))} />);
    expect((await screen.findByTestId("cr.prd.refusal")).textContent).toContain("GOAL_SOURCE_READ_FAILED");
  });
});
