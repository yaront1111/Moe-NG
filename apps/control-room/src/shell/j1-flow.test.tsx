import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { JSX } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { BOARD_J1_COLUMNS, BoardJ1 } from "../board/board-j1.js";
import type { BoardJ1Card } from "../board/board-j1.js";
import { DoctorJ1 } from "../doctor/doctor-j1.js";
import { EvidenceJ1 } from "../evidence/evidence-j1.js";
import type { EvidenceJ1Receipt } from "../evidence/evidence-j1.js";
import { CONTROL_ROOM_FIXTURES } from "../fixtures.js";
import type { FixtureAffordanceSnapshot, FixtureFact, FixtureSurfaceId } from "../fixtures.js";
import { GoalsJ1 } from "../goals/goals-j1.js";
import { NodeInspectorJ1 } from "../nodes/node-inspector-j1.js";
import { ApprovalJ1 } from "../approvals/approval-j1.js";
import { ShellFrame } from "./frame.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

function factsFor(surfaceId: FixtureSurfaceId): readonly FixtureFact[] {
  const surface = CONTROL_ROOM_FIXTURES.surfaces.find((item) => item.surfaceId === surfaceId);
  if (surface === undefined) throw new Error(`no ${surfaceId} surface fixture`);
  return surface.facts;
}

function connectedAffordance(): FixtureAffordanceSnapshot {
  const found = CONTROL_ROOM_FIXTURES.affordances.find(
    (snapshot) => snapshot.connection === "CONNECTED",
  );
  if (found === undefined) throw new Error("no CONNECTED affordance fixture");
  return found;
}

/** The single-node J1 goal, one card per phase it passes through. */
const J1_CARDS: readonly BoardJ1Card[] = [
  { column: "review", name: "Fix the stale-port crash", nodeId: "node-j1",
    phase: "WORK_REVIEW", truthClass: "OBSERVED" },
];

const J1_RECEIPT: EvidenceJ1Receipt = {
  baseSha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  command: "pnpm typecheck && pnpm test",
  exitCode: 0,
  headSha: "0f1e2d3c4b5a69788796a5b4c3d2e1f098765432",
};

function J1App({ affordance }: { readonly affordance: FixtureAffordanceSnapshot }): JSX.Element {
  return (
    <ShellFrame
      affordance={affordance}
      inspector={<NodeInspectorJ1 facts={factsFor("node")} nodeId="node-j1" />}
    >
      <GoalsJ1 facts={factsFor("goals")} />
      <BoardJ1 cards={J1_CARDS} facts={factsFor("board")} />
      <ApprovalJ1 facts={factsFor("approval")} kinds={["plan", "acceptance"]} />
      <EvidenceJ1 facts={factsFor("evidence")} receipt={J1_RECEIPT} />
      <DoctorJ1 facts={factsFor("doctor")} />
    </ShellFrame>
  );
}

const graphNodes = (): readonly Element[] =>
  Array.from(document.querySelectorAll("[data-testid^='cr.graph.']"));

describe("J1 is operable from the board and inbox alone", () => {
  it("walks goal to board to node to approval to evidence to doctor", async () => {
    const user = userEvent.setup();
    render(<J1App affordance={connectedAffordance()} />);

    // 1. Goal creation form (§4.2 fields).
    const form = screen.getByTestId("cr.goals.form");
    expect(within(form).getByTestId("cr.goals.field.outcome")).toBeTruthy();
    expect(within(form).getByTestId("cr.goals.field.acceptance")).toBeTruthy();
    expect(within(form).getByTestId("cr.goals.field.budget")).toBeTruthy();
    expect(within(form).getByTestId("cr.goals.field.risk")).toBeTruthy();
    expect(graphNodes().length).toBe(0);

    // 2. Board: five columns, the node card carrying name + phase + chip.
    for (const column of BOARD_J1_COLUMNS) {
      expect(screen.getByTestId(`cr.board.column.${column}`)).toBeTruthy();
    }
    const card = screen.getByTestId("cr.board.card.node-j1");
    expect(card.textContent ?? "").toContain("Fix the stale-port crash");
    expect(within(card).getByTestId("cr.board.card.phase").textContent).toBe("WORK_REVIEW");
    expect(within(card).getByTestId("cr.chip.observed")).toBeTruthy();
    expect(graphNodes().length).toBe(0);

    // 3. Node inspector: chipped facts, and no attempt detail in this slice.
    const inspector = screen.getByTestId("cr.shell.inspector");
    expect(within(inspector).getByTestId("cr.inspector.section.identity")).toBeTruthy();
    expect(document.querySelectorAll("[data-testid^='cr.inspector.transcript.']").length).toBe(0);
    expect(graphNodes().length).toBe(0);

    // 4-5. Approval detail for both J1 decision points.
    expect(screen.getByTestId("cr.approvals.detail.plan")).toBeTruthy();
    expect(screen.getByTestId("cr.approvals.detail.acceptance")).toBeTruthy();
    const approve = screen.getByTestId("cr.action.approval-decide.approve");
    expect((approve as HTMLButtonElement).disabled).toBe(false);
    await user.click(approve);
    expect(graphNodes().length).toBe(0);

    // 6. Evidence receipt: exit 0 plus both SHAs.
    const receipt = screen.getByTestId("cr.evidence.receipt");
    const receiptText = receipt.textContent ?? "";
    expect(receiptText).toContain("exit 0");
    expect(receiptText).toContain(J1_RECEIPT.baseSha);
    expect(receiptText).toContain(J1_RECEIPT.headSha);

    // 7. Doctor: status summary only.
    expect(screen.getByTestId("cr.health.status")).toBeTruthy();
    expect(graphNodes().length).toBe(0);
  });

  it("keeps the three human actions reachable and each backed by a supplied command", () => {
    const affordance = connectedAffordance();
    render(<J1App affordance={affordance} />);
    const supplied = new Set(affordance.nextAllowedCommands.map((command) => command.commandId));
    expect(supplied.size).toBeGreaterThan(0);

    // Action 1 is the goal form's submit; actions 2 and 3 are daemon-supplied commands.
    expect(screen.getByTestId("cr.goals.create")).toBeTruthy();
    expect(screen.getByTestId("cr.action.approval-decide.approve")).toBeTruthy();
    expect(screen.getByTestId("cr.action.integration-accept-output")).toBeTruthy();

    for (const action of document.querySelectorAll("[data-testid^='cr.action.']")) {
      expect(supplied.has(action.getAttribute("data-command-id") ?? "")).toBe(true);
    }
  });

  it("never mounts a cr.graph.* element anywhere in the flow", async () => {
    const user = userEvent.setup();
    render(<J1App affordance={connectedAffordance()} />);
    expect(graphNodes().length).toBe(0);
    // Even selecting the graph projection mounts a placeholder, never a canvas.
    await user.click(screen.getByTestId("cr.shell.tab.graph"));
    expect(screen.getByTestId("cr.shell.graphplaceholder")).toBeTruthy();
    expect(graphNodes().length).toBe(0);
    expect(screen.queryByTestId("cr.graph.canvas")).toBeNull();
  });

  it("gives every rendered fact exactly one truth chip", () => {
    render(<J1App affordance={connectedAffordance()} />);
    const wrappers = Array.from(document.querySelectorAll("[data-testid^='cr.fact.']"));
    // Guard the audit itself: a slice that rendered no facts would pass vacuously.
    expect(wrappers.length).toBeGreaterThanOrEqual(12);
    for (const wrapper of wrappers) {
      expect(wrapper.querySelectorAll("[data-testid^='cr.chip.']").length).toBe(1);
    }
  });

  it("disables every J1 action when the transport drops, without hiding one", () => {
    const dropped: FixtureAffordanceSnapshot = {
      ...connectedAffordance(), connection: "DISCONNECTED", mutationsEnabled: false,
      statusLabel: "Connection to Moe lost.",
    };
    render(<J1App affordance={dropped} />);
    expect(screen.getByTestId("cr.banner.disconnected")).toBeTruthy();
    const actions = Array.from(
      document.querySelectorAll<HTMLButtonElement>("[data-testid^='cr.action.']"),
    );
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) expect(action.disabled).toBe(true);
  });

  it("ignores the p shortcut unless a truth chip holds focus", () => {
    render(<J1App affordance={connectedAffordance()} />);
    const slot = screen.getByTestId("cr.factslot.goal.title");
    // Raised on the slot itself rather than the chip: a later surface may render a
    // text field here, and a literal "p" must reach it.
    fireEvent.keyDown(slot, { key: "p" });
    expect(screen.queryByTestId("cr.chip.provenance")).toBeNull();
  });

  it("shows a failing receipt exit code as itself, never softened", () => {
    render(
      <ShellFrame affordance={connectedAffordance()}>
        <EvidenceJ1 facts={factsFor("evidence")} receipt={{ ...J1_RECEIPT, exitCode: 1 }} />
      </ShellFrame>,
    );
    expect(screen.getByTestId("cr.evidence.receipt.exit").textContent).toBe("exit 1");
  });

  it("submits the goal draft locally without reaching any transport", async () => {
    const user = userEvent.setup();
    const drafts: string[] = [];
    render(
      <ShellFrame affordance={connectedAffordance()}>
        <GoalsJ1
          facts={factsFor("goals")}
          onCreate={(draft) => {
            drafts.push(draft.outcome);
          }}
        />
      </ShellFrame>,
    );
    await user.type(screen.getByTestId("cr.goals.field.outcome"), "Fix the crash");
    await user.click(screen.getByTestId("cr.goals.create"));
    expect(drafts).toEqual(["Fix the crash"]);
  });
});
