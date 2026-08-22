import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { EMDASH } from "../glyphs.js";
import type { SurfaceFrame, SurfaceStep } from "../../live/live-board-feed.js";
import { WorkBoard } from "./work-board.js";

/**
 * The WORK BOARD (UI-5) is READ-ONLY presentation over a SurfaceFrame. It draws
 * exactly the three surface statuses (READY / BLOCKED / COMMITTED) as three
 * columns, carries a claim chip and the missing[] prerequisites where the surface
 * reports them, and always shows the coming-online panel naming the design's
 * execution lanes and node acceptance as NOT on the affordance surface yet. It
 * imports nothing that dispatches - a dispatch would post fabricated dev payloads.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => { cleanup(); });

function step(overrides: Partial<SurfaceStep> & Pick<SurfaceStep, "status">): SurfaceStep {
  return Object.freeze({
    aggregateId: null,
    claim: null,
    kind: "node.deliver",
    missing: [],
    version: null,
    ...overrides,
  });
}

function surface(steps: readonly SurfaceStep[]): SurfaceFrame {
  return Object.freeze({
    connection: "CONNECTED",
    detail: "",
    offers: Object.freeze([]),
    outcome: "SURFACE",
    steps: Object.freeze([...steps]),
  });
}

const READY_STEP = step({
  aggregateId: "agg-ready-1", kind: "node.plan", status: "READY",
});
const BLOCKED_STEP = step({
  aggregateId: "agg-blocked-1",
  kind: "node.deliver",
  missing: ["node-1 accepted", "budget approved"],
  status: "BLOCKED",
});
const COMMITTED_STEP = step({
  aggregateId: "agg-committed-1",
  claim: { claimedBy: "agent-7", expiresAt: "2026-08-22T12:00:00Z" },
  kind: "node.verify",
  status: "COMMITTED",
});

describe("the work board renders the three surface statuses", () => {
  it("renders Ready / Blocked / Committed columns with the right cards", () => {
    render(<WorkBoard frame={surface([READY_STEP, BLOCKED_STEP, COMMITTED_STEP])} />);

    expect(screen.getByTestId("cr.board.count").textContent).toBe("3 steps on the surface");
    expect(screen.getByTestId("cr.board.column.ready").textContent).toContain("node.plan");
    expect(screen.getByTestId("cr.board.column.ready").textContent).toContain("agg-ready-1");
    expect(screen.getByTestId("cr.board.column.blocked").textContent).toContain("node.deliver");
    expect(screen.getByTestId("cr.board.column.committed").textContent).toContain("node.verify");
  });

  it("renders a BLOCKED step's missing prerequisites as 'needs ...'", () => {
    render(<WorkBoard frame={surface([BLOCKED_STEP])} />);
    const missing = screen.getByTestId("cr.board.missing");
    expect(missing.textContent).toBe("needs node-1 accepted, budget approved");
  });

  it("renders a claim chip only when the step carries a durable claim", () => {
    render(<WorkBoard frame={surface([COMMITTED_STEP])} />);
    expect(screen.getByTestId("cr.board.claim").textContent)
      .toBe("held by agent-7 until 2026-08-22T12:00:00Z");
  });

  it("renders an em-dash for a null aggregateId", () => {
    render(<WorkBoard frame={surface([step({ aggregateId: null, kind: "node.plan", status: "READY" })])} />);
    expect(screen.getByTestId("cr.board.column.ready").textContent).toContain(EMDASH);
  });

  it("shows honest empties for columns with no steps", () => {
    render(<WorkBoard frame={surface([READY_STEP])} />);
    expect(screen.getByTestId("cr.board.empty.blocked").textContent).toBe("No steps blocked");
    expect(screen.getByTestId("cr.board.empty.committed").textContent).toBe("No steps committed");
    expect(screen.queryByTestId("cr.board.empty.ready")).toBeNull();
  });

  it("always shows the coming-online panel naming the lanes not on the surface", () => {
    render(<WorkBoard frame={surface([READY_STEP])} />);
    const panel = screen.getByTestId("cr.board.comingonline");
    expect(panel.textContent).toContain("PLAN / EXECUTING / REVIEW / ACCEPTED");
    expect(panel.textContent).toContain("node acceptance");
    expect(panel.textContent).toContain("not carried by the affordance surface yet");
  });
});

describe("the work board renders honest non-surface states", () => {
  it("renders the waiting state when the frame is null", () => {
    render(<WorkBoard frame={null} />);
    expect(screen.getByTestId("cr.board.waiting").textContent)
      .toBe("The affordance surface has not answered yet.");
    expect(screen.queryByTestId("cr.board.comingonline")).toBeNull();
  });

  it("renders a disconnected note for a DISCONNECTED frame", () => {
    const frame: SurfaceFrame = Object.freeze({
      connection: "DISCONNECTED",
      detail: "TRANSPORT_REQUEST_FAILED",
      offers: Object.freeze([]),
      outcome: "UNDELIVERED",
      steps: Object.freeze([]),
    });
    render(<WorkBoard frame={frame} />);
    expect(screen.getByTestId("cr.board.disconnected").textContent).toContain("Disconnected from the daemon");
  });

  it("renders a REFUSED outcome's code verbatim", () => {
    const frame: SurfaceFrame = Object.freeze({
      connection: "CONNECTED",
      detail: "AFFORDANCE_READ_CAPABILITY_DENIED",
      offers: Object.freeze([]),
      outcome: "REFUSED",
      steps: Object.freeze([]),
    });
    render(<WorkBoard frame={frame} />);
    const line = screen.getByTestId("cr.board.outcome");
    expect(line.textContent).toContain("REFUSED");
    expect(line.textContent).toContain("AFFORDANCE_READ_CAPABILITY_DENIED");
  });
});

describe("the work board is read-only", () => {
  it("imports nothing that dispatches (no live-dispatch, no sendCommand)", () => {
    // Resolve import.meta.url directly (no `new URL(".", base)`): the browser test
    // transform rewrites the relative form to an http URL fileURLToPath rejects.
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "work-board.tsx"), "utf8");
    expect(source).not.toContain("live-dispatch");
    expect(source).not.toContain("sendCommand");
    expect(source).not.toContain("dispatchAffordance");
  });
});
