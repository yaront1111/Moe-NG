import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { EMDASH, MIDDOT } from "../glyphs.js";
import type { ProofPayload } from "../shell/proof-context.js";
import { ProofProvider } from "../shell/proof-context.js";
import type { SurfaceFrame, SurfaceStep } from "../../live/live-board-feed.js";
import { WorkBoard } from "./work-board.js";

/**
 * The WORK BOARD (UI-5) is READ-ONLY presentation over a SurfaceFrame. It draws
 * the three surface statuses (READY / BLOCKED / COMMITTED) as three columns named
 * in the owner's words with the raw token kept beside them, translates each
 * command kind through work-labels.ts while keeping the daemon's own kind and
 * aggregate id visible underneath, and opens a read-only receipt per card. It
 * never calls these commands "steps" - that word belongs to the plan above it -
 * and it imports nothing that dispatches.
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

const THREE_STEP_COUNT = "The daemon lists 3 commands for this project: "
  + "1 it would accept now, 1 waiting on something, 1 already recorded. "
  + "These are not the plan's steps above.";

describe("the work board renders the three surface statuses", () => {
  it("renders Ready / Blocked / Committed columns with the right cards", () => {
    render(<WorkBoard frame={surface([READY_STEP, BLOCKED_STEP, COMMITTED_STEP])} />);

    expect(screen.getByTestId("cr.board.count").textContent).toBe(THREE_STEP_COUNT);
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
    expect(screen.getByTestId("cr.board.empty.blocked").textContent).toBe("Nothing is waiting.");
    expect(screen.getByTestId("cr.board.empty.committed").textContent).toBe("Nothing recorded yet.");
    expect(screen.queryByTestId("cr.board.empty.ready")).toBeNull();
  });

  it("collapses the honesty note by default and words it for the owner", () => {
    render(<WorkBoard frame={surface([READY_STEP])} />);
    const panel = screen.getByTestId("cr.board.comingonline") as HTMLDetailsElement;
    expect(panel.tagName).toBe("DETAILS");
    expect(panel.open).toBe(false);
    expect(screen.getByTestId("cr.board.comingonline.summary").textContent)
      .toBe("What this board can't show yet");
    const body = screen.getByTestId("cr.board.comingonline.body").textContent ?? "";
    expect(body).toContain("left out rather than guessed");
    expect(body).toContain("Nothing here is estimated");
    expect(body).not.toContain("affordance surface");
    expect(body).not.toContain("fabricated");
    expect(body).not.toContain("node acceptance");
    expect(screen.getByTestId("cr.board.comingonline.raw").textContent)
      .toBe(`surface statuses: READY ${MIDDOT} BLOCKED ${MIDDOT} COMMITTED`);
  });
});

describe("the work board says what the daemon said, in the owner's words", () => {
  it("shows a plain label and a group, keeping the raw kind and id underneath", () => {
    render(<WorkBoard frame={surface([step({
      aggregateId: "e2e-proj-t0abzx", kind: "project.register", status: "COMMITTED",
    })])} />);
    const card = screen.getByTestId("cr.board.card.COMMITTED.0");
    expect(within(card).getByTestId("cr.board.label").textContent).toBe("Register the project");
    expect(within(card).getByTestId("cr.board.group").textContent).toBe("Project setup");
    expect(within(card).getByTestId("cr.board.raw").textContent)
      .toBe("project.register @ e2e-proj-t0abzx");
    expect(card.getAttribute("data-known")).toBe("true");
  });

  it("renders an unmapped kind verbatim and marks it unknown, inventing nothing", () => {
    render(<WorkBoard frame={surface([step({ aggregateId: "agg-1", kind: "node.plan", status: "READY" })])} />);
    const card = screen.getByTestId("cr.board.card.READY.0");
    expect(within(card).getByTestId("cr.board.label").textContent).toBe("node.plan");
    expect(within(card).getByTestId("cr.board.group").textContent).toBe("Other");
    expect(card.getAttribute("data-known")).toBe("false");
  });

  it("translates the daemon's prerequisite tokens into words", () => {
    render(<WorkBoard frame={surface([step({
      kind: "project.activate", missing: ["project.register", "provider.probe"], status: "BLOCKED",
    })])} />);
    expect(screen.getByTestId("cr.board.missing").textContent)
      .toBe("needs Register the project, Probe the model provider");
    cleanup();
    render(<WorkBoard frame={surface([step({
      kind: "plan.propose", missing: ["goal.binding"], status: "BLOCKED",
    })])} />);
    expect(screen.getByTestId("cr.board.missing").textContent)
      .toBe("needs a goal bound to this run");
  });

  it("names each column in plain words and keeps its raw status token", () => {
    render(<WorkBoard frame={surface([READY_STEP, COMMITTED_STEP])} />);
    expect(screen.getByTestId("cr.board.colhead.ready").textContent)
      .toBe(`Offered now ${MIDDOT} 1`);
    expect(screen.getByTestId("cr.board.colhead.blocked").textContent)
      .toBe(`Waiting on something ${MIDDOT} 0`);
    expect(screen.getByTestId("cr.board.colhead.committed").textContent)
      .toBe(`Already recorded ${MIDDOT} 1`);
    expect(screen.getByTestId("cr.board.colmeaning.ready").textContent)
      .toBe("The daemon says it would accept this command right now.");
    expect(screen.getByTestId("cr.board.colstatus.blocked").textContent).toBe("BLOCKED");
    expect(screen.getByTestId("cr.board.colstatus.committed").textContent).toBe("COMMITTED");
  });

  it("keeps the legacy 'cr.board.column.' prefix on the three column roots ONLY", () => {
    // src/styles/preview-board.css:27 and src/board/board-layout.css:21 style
    // EVERY element whose test id starts with "cr.board.column." as a v1 lane box
    // - min-block-size: 18rem, a border, a background, min-width 18rem. Both ship
    // in the same bundle as v2, so a NESTED id under that prefix silently inflates
    // a one-line heading into a 288px box on the live page (measured: the column
    // head, its meaning line and its status token each became 288px tall).
    render(<WorkBoard frame={surface([READY_STEP, BLOCKED_STEP, COMMITTED_STEP])} />);
    const ids = [...screen.getByTestId("cr.board.root")
      .querySelectorAll("[data-testid^='cr.board.column.']")]
      .map((node) => node.getAttribute("data-testid"));
    expect(ids).toEqual([
      "cr.board.column.ready", "cr.board.column.blocked", "cr.board.column.committed",
    ]);
  });

  it("never calls these commands 'steps', and says so where the plan could be confused", () => {
    render(<WorkBoard frame={surface([READY_STEP, BLOCKED_STEP, COMMITTED_STEP])} />);
    const heads = [
      "cr.board.heading",
      "cr.board.colhead.ready",
      "cr.board.colhead.blocked",
      "cr.board.colhead.committed",
    ];
    for (const id of heads) {
      expect((screen.getByTestId(id).textContent ?? "").toLowerCase(), id).not.toContain("step");
    }
    expect(screen.getByTestId("cr.board.heading").textContent)
      .toBe("Commands the daemon holds for this project");
    expect(screen.getByTestId("cr.board.count").textContent).toContain("not the plan's steps");
  });

  it("orders a column by the daemon's real chain, not the surface's array order", () => {
    const committed = [
      "approval.decide", "plan.propose", "policy.install", "project.activate",
      "project.bind_repository", "project.register", "provider.probe",
    ].map((kind) => step({ aggregateId: "x", kind, status: "COMMITTED" }));
    render(<WorkBoard frame={surface(committed)} />);
    const labels = within(screen.getByTestId("cr.board.column.committed"))
      .getAllByTestId("cr.board.label").map((node) => node.textContent);
    expect(labels).toEqual([
      "Register the project", "Bind the repository", "Probe the model provider",
      "Activate the project", "Install the policy", "Propose the plan",
      "Decide the plan approval",
    ]);
  });

  it("keeps the surface's own order among unknown kinds and puts them last", () => {
    render(<WorkBoard frame={surface([
      step({ aggregateId: "z", kind: "zeta.x", status: "READY" }),
      step({ aggregateId: "a", kind: "alpha.y", status: "READY" }),
      step({ aggregateId: "g", kind: "goal.create", status: "READY" }),
    ])} />);
    const labels = within(screen.getByTestId("cr.board.column.ready"))
      .getAllByTestId("cr.board.label").map((node) => node.textContent);
    expect(labels).toEqual(["Create a goal", "zeta.x", "alpha.y"]);
  });
});

describe("the work board holds a card's identity still across a poll", () => {
  it("keeps one identity for goal.create while the daemon mints a fresh target", () => {
    const view = render(<WorkBoard frame={surface([step({
      aggregateId: "goal-b8ae16be-2c20-4867-80c2-1248934cc218", kind: "goal.create",
      status: "READY", version: 0,
    })])} />);
    const first = screen.getByTestId("cr.board.card.READY.0");
    expect(first.getAttribute("data-card-id")).toBe("goal.create");
    expect(within(first).getByTestId("cr.board.label").textContent).toBe("Create a goal");
    expect(within(first).getByTestId("cr.board.raw").textContent)
      .toBe("goal.create @ goal-b8ae16be-2c20-4867-80c2-1248934cc218");
    expect(within(first).getByTestId("cr.board.minted").textContent)
      .toBe("The daemon mints that target fresh on every read; the command stays one command.");

    view.rerender(<WorkBoard frame={surface([step({
      aggregateId: "goal-383abb30-f684-4edd-8bc1-a0216a60ac9e", kind: "goal.create",
      status: "READY", version: 0,
    })])} />);
    const second = screen.getByTestId("cr.board.card.READY.0");
    expect(second.getAttribute("data-card-id")).toBe("goal.create");
    expect(within(second).getByTestId("cr.board.label").textContent).toBe("Create a goal");
    expect(within(second).getByTestId("cr.board.raw").textContent)
      .toBe("goal.create @ goal-383abb30-f684-4edd-8bc1-a0216a60ac9e");
  });

  it("binds a durable card's identity to the aggregate the daemon named", () => {
    render(<WorkBoard frame={surface([
      step({ aggregateId: "session/a", kind: "session.renew", status: "READY" }),
      step({ aggregateId: "session/b", kind: "session.renew", status: "READY" }),
    ])} />);
    expect(screen.getByTestId("cr.board.card.READY.0").getAttribute("data-card-id"))
      .toBe("session.renew@session/a");
    expect(screen.getByTestId("cr.board.card.READY.1").getAttribute("data-card-id"))
      .toBe("session.renew@session/b");
    expect(screen.queryAllByTestId("cr.board.minted")).toHaveLength(0);
  });
});

describe("the work board offers a read-only receipt per card", () => {
  function openedBy(frame: SurfaceFrame, testId: string): ProofPayload[] {
    const opened: ProofPayload[] = [];
    render(
      <ProofProvider controller={{ openProof: (payload) => { if (payload !== null) opened.push(payload); } }}>
        <WorkBoard frame={frame} />
      </ProofProvider>,
    );
    fireEvent.click(screen.getByTestId(testId));
    return opened;
  }

  it("opens the proof inspector on the card's own surface fields", () => {
    const opened = openedBy(
      surface([step({ aggregateId: "e2e-proj", kind: "project.register", status: "COMMITTED", version: 2 })]),
      "cr.board.card.COMMITTED.0.inspect",
    );
    expect(opened).toHaveLength(1);
    const payload = opened[0];
    expect(payload?.factId).toBe("board.project.register@e2e-proj");
    expect(payload?.label).toBe("Register the project");
    expect(payload?.truthClass).toBe("OBSERVED");
    const rows = Object.fromEntries((payload?.rows ?? []).map((row) => [row.k, row.v]));
    expect(rows["SOURCE"]).toBe("POST /affordances/read");
    expect(rows["COMMAND"]).toBe("project.register");
    expect(rows["TARGET"]).toBe("e2e-proj");
    expect(rows["STATUS"]).toBe("COMMITTED");
    expect(rows["VERSION"]).toBe("2");
  });

  it("names the card it inspects so many receipts are not one anonymous button", () => {
    render(<WorkBoard frame={surface([step({ aggregateId: "x", kind: "policy.install", status: "READY" })])} />);
    expect(screen.getByTestId("cr.board.card.READY.0.inspect").getAttribute("aria-label"))
      .toBe("Inspect the receipt for Install the policy");
  });

  it("gives every card a receipt, and none of them a dispatch", () => {
    render(<WorkBoard frame={surface([READY_STEP, BLOCKED_STEP, COMMITTED_STEP])} />);
    expect(screen.getAllByTestId(/^cr\.board\.card\.[A-Z]+\.\d+\.inspect$/u)).toHaveLength(3);
    for (const button of screen.getAllByRole("button")) {
      expect(button.getAttribute("type")).toBe("button");
    }
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
    for (const file of ["work-board.tsx", "work-labels.ts", "work-board-receipt.ts"]) {
      const source = readFileSync(join(here, file), "utf8");
      expect(source, file).not.toContain("live-dispatch");
      expect(source, file).not.toContain("sendCommand");
      expect(source, file).not.toContain("dispatchAffordance");
    }
  });
});
