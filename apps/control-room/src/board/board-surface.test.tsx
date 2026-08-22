import type { NextAllowedCommand, RuntimeCommandKind } from "@moe/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { FixtureAffordanceSnapshot } from "../fixtures.js";
import type { PresentedFact } from "../nodes/node-authority.js";
import { ShellFrame } from "../shell/frame.js";
import type {
  BoardCardProjection, BoardFrontierLane, BoardJoinSummary, BoardSurfaceProps,
} from "./board-contract.js";
import { BoardSurface } from "./board-surface.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const obs =(value: string): PresentedFact => ({ truthClass: "OBSERVED", value });
const ver = (value: string): PresentedFact => ({ truthClass: "DAEMON_VERIFIED", value });

/** Declared card fact kinds, hand-written so production cannot define its own oracle. */
const CARD_FACTS = [
  "phase", "owner", "lease.state", "lease.epoch", "lease.expiry", "lease.renewalsilence",
  "lease.activitysilence", "progress", "latestclaim", "blocker.type", "blocker.owner",
  "blocker.reason", "wait.owner", "wait.reason", "wait.recheck", "budget.spent", "budget.basis",
  "criticalpath", "slack", "suspect", "held", "disposition", "qualification",
] as const;

const COLUMNS = ["plan", "ready", "executing", "review", "accepted"] as const;

function baseCard(nodeId: string): BoardCardProjection {
  return {
    actionTargetId: `run-${nodeId}`, activitySilence: obs("quiet 0m"), blockerOwner: null,
    blockerReason: null, blockerType: null, budgetBasis: obs("wall-clock estimate"),
    budgetSpent: obs("$0"), criticalPath: obs("off critical path"), disposition: null,
    held: obs("none"), latestClaim: obs("no claim"), leaseEpoch: obs("0"), leaseExpiry: obs("none"),
    leaseState: obs("RELEASED"), nodeId, owner: obs("unowned"), phase: obs("DRAFT"),
    placement: "plan", progress: obs("steps 0/0"), qualification: null,
    renewalSilence: obs("renewed 0s ago"), slack: obs("slack UNKNOWN"), suspect: null,
    sourceAggregate: "PlanningRun", title: nodeId, waitOwner: null, waitReason: null,
    waitRecheck: null,
  };
}

/** The J5 pairing: a healthy renewal beside a long activity silence, never merged. */
const EXECUTING_CARD: BoardCardProjection = {
  ...baseCard("api-endpnt"), activitySilence: obs("quiet 41m"),
  blockerOwner: ver("human/operator-1"), blockerReason: ver("waiting on schema fixture"),
  blockerType: ver("DEPENDENCY_UNPROVEN"), budgetBasis: ver("metered provider receipts"),
  budgetSpent: ver("$18 of $50"), criticalPath: ver("on critical path"), held: ver("held"),
  latestClaim: obs("retry endpoint returns 202"), leaseEpoch: obs("7"),
  leaseExpiry: obs("2026-08-08T09:41:00.000Z"), leaseState: obs("ACTIVE"), owner: obs("w-3"),
  phase: obs("EXECUTING"), placement: "executing", progress: obs("steps 2/3"),
  renewalSilence: obs("renewed 41s ago"), slack: ver("slack 0m"), sourceAggregate: "WorkItem",
  suspect: ver("SUSPECT"), waitOwner: ver("agent/session-a"),
  waitReason: ver("intentional wait: fixture milestone"), waitRecheck: ver("recheck in 5m"),
};

/**
 * Two cards spell the same state and belong to different aggregates and different
 * supplied lanes; one card's placement flatly contradicts its phase. Any implementation
 * that folds phase into a column instead of honouring the supplied placement fails here.
 */
const CARDS: readonly BoardCardProjection[] = [
  { ...baseCard("plan-doc"), phase: obs("PLANNING") },
  { ...baseCard("same-spelled-a"), phase: obs("READY") },
  { ...baseCard("contradiction"), phase: obs("EXECUTING"), sourceAggregate: "WorkItem" },
  { ...baseCard("ready-1"), phase: obs("EXECUTION_READY"), placement: "ready",
    sourceAggregate: "WorkItem" },
  { ...baseCard("same-spelled-b"), phase: obs("READY"), placement: "ready",
    sourceAggregate: "WorkItem" },
  EXECUTING_CARD,
  { ...baseCard("dup"), placement: "executing" },
  { ...baseCard("dup"), placement: "executing" },
  { ...baseCard(""), placement: "executing" },
  { ...baseCard("ui-panel"), phase: obs("WORK_REVIEW"), placement: "review" },
  { ...baseCard("schema"), disposition: ver("REBOUND"), phase: obs("ACCEPTED"),
    placement: "accepted", qualification: ver("INVALIDATED") },
  { ...baseCard("ghost"), phase: obs("DRAFT"), placement: null },
  { ...baseCard("cancelled-1"), phase: obs("CANCELLED"), placement: "terminated" },
];

const VISIBLE_ORDER = [
  "plan-doc", "same-spelled-a", "contradiction", "ready-1", "same-spelled-b",
  "api-endpnt", "dup", "dup", "UNKNOWN", "ui-panel", "schema", "ghost",
] as const;

const FRONTIER: readonly BoardFrontierLane[] = [
  { cursor: obs("#4821"), graphEpoch: obs("epoch 12"), idleCapacity: obs("1 idle slot"),
    lane: "READY_NOW", readinessExplanation: obs("admission and inputs proven"),
    summary: obs("2 nodes ready now") },
  { cursor: obs("#4821"), graphEpoch: obs("epoch 12"), idleCapacity: obs("1 idle slot"),
    lane: "UNBLOCK_NEXT", readinessExplanation: obs("resolve schema fixture first"),
    summary: obs("1 node unblocks next") },
  { cursor: obs("#4821"), graphEpoch: obs("epoch 12"), idleCapacity: obs("0 idle slots"),
    lane: "INTENTIONAL_WAIT", readinessExplanation: obs("waiting by operator decision"),
    summary: obs("1 node waiting on purpose") },
  { cursor: null, graphEpoch: null, idleCapacity: null, lane: "UNSAFE_OR_UNKNOWN",
    readinessExplanation: null, summary: obs("1 node unsafe or unknown") },
];

const JOINS: readonly BoardJoinSummary[] = [
  { inputs: ver("api-endpnt, ui-panel"), joinId: "integrate",
    summary: obs("join integrate - waiting 2/3") },
];

function command(
  commandId: string, commandKind: RuntimeCommandKind, targetAggregateId: string,
): NextAllowedCommand {
  return Object.freeze({
    commandEnvelopeVersion: "moe-runtime-command/1", commandId, commandKind, expectedVersion: 3,
    inputSchemaVersion: "moe-runtime-command-input/1", targetAggregateId,
  });
}

const BLOCKER_OPEN = command("cmd-blocker-1", "blocker.open", "run-api-endpnt");
const WORK_RELEASE = command("cmd-release-1", "work.release" as RuntimeCommandKind,
  "run-api-endpnt");
const FOREIGN = command("cmd-foreign-1", "blocker.open", "run-not-on-this-board");

function affordance(
  commands: readonly NextAllowedCommand[], mutationsEnabled = true,
): FixtureAffordanceSnapshot {
  return {
    connection: "CONNECTED", mutationsEnabled, nextAllowedCommands: commands,
    requiresAffordanceRefresh: false, statusLabel: "",
  };
}

function boardProps(): BoardSurfaceProps {
  return {
    cards: CARDS, frontier: FRONTIER, joins: JOINS, loadedEmptyColumns: [], showTerminated: false,
  };
}

function renderBoard(
  overrides: Partial<BoardSurfaceProps> = {},
  snapshot: FixtureAffordanceSnapshot = affordance([]),
): void {
  render(
    <ShellFrame affordance={snapshot}>
      <BoardSurface {...boardProps()} {...overrides} />
    </ShellFrame>,
  );
}

const cardIdsIn = (root: ParentNode = document): readonly string[] =>
  [...root.querySelectorAll("[data-testid^='cr.board.card.']")]
    .filter((node) => !(node.getAttribute("data-testid") ?? "").startsWith("cr.board.card.silence"))
    .map((node) => (node.getAttribute("data-testid") ?? "").slice("cr.board.card.".length));

const valueOf = (factId: string): string =>
  within(screen.getByTestId(`cr.fact.${factId}`)).getByTestId("cr.value").textContent ?? "";

const chipOf = (factId: string): HTMLElement =>
  within(screen.getByTestId(`cr.fact.${factId}`)).getByTestId(/^cr\.chip\./u);

describe("board columns are the daemon's supplied placement, not a client phase fold", () => {
  it("applies card chrome to canonical card articles without styling nested silence facts", () => {
    renderBoard({ cards: [EXECUTING_CARD] });
    expect(screen.getByTestId("cr.board.card.api-endpnt").className).toContain("cr-board-card");
    expect(screen.getByTestId("cr.board.card.silence.api-endpnt").className)
      .not.toContain("cr-board-card");
  });

  it("renders five columns column-major, keeping duplicate and blank identities visible", () => {
    renderBoard();
    expect(CARDS.length).toBe(13);
    for (const col of COLUMNS) expect(screen.getByTestId(`cr.board.column.${col}`)).toBeTruthy();
    expect(cardIdsIn()).toEqual([...VISIBLE_ORDER]);
    expect(screen.getAllByTestId("cr.board.card.dup")).toHaveLength(2);
    expect(screen.getByTestId("cr.board.card.UNKNOWN")).toBeTruthy();
  });

  it("keeps phase, source aggregate, and supplied placement independent of each other", () => {
    renderBoard();
    expect(valueOf("node.same-spelled-a.phase")).toBe("READY");
    expect(valueOf("node.same-spelled-b.phase")).toBe("READY");
    expect(screen.getByTestId("cr.board.card.same-spelled-a")
      .getAttribute("data-source-aggregate")).toBe("PlanningRun");
    expect(screen.getByTestId("cr.board.card.same-spelled-b")
      .getAttribute("data-source-aggregate")).toBe("WorkItem");
    const plan = cardIdsIn(screen.getByTestId("cr.board.column.plan"));
    expect(plan).toContain("same-spelled-a");
    expect(cardIdsIn(screen.getByTestId("cr.board.column.ready"))).toContain("same-spelled-b");
    expect(plan).toContain("contradiction");
    expect(cardIdsIn(screen.getByTestId("cr.board.column.executing"))).not.toContain(
      "contradiction",
    );
    expect(valueOf("node.contradiction.phase")).toBe("EXECUTING");
  });

  it("retains an unplaced record in the unmapped region instead of guessing a lane", () => {
    renderBoard();
    expect(cardIdsIn(screen.getByTestId("cr.board.unmapped"))).toEqual(["ghost"]);
    for (const col of COLUMNS) {
      expect(cardIdsIn(screen.getByTestId(`cr.board.column.${col}`))).not.toContain("ghost");
    }
  });

  it("hides terminated records until the controlled filter asks for them", async () => {
    const asked: boolean[] = [];
    renderBoard({ onShowTerminatedChange: (value) => asked.push(value) });
    expect(screen.queryByTestId("cr.board.card.cancelled-1")).toBeNull();
    await userEvent.click(screen.getByTestId("cr.board.filter.terminated"));
    expect(asked).toEqual([true]);
    expect(screen.queryByTestId("cr.board.card.cancelled-1")).toBeNull();
    cleanup();
    renderBoard({ showTerminated: true });
    expect(cardIdsIn(screen.getByTestId("cr.board.terminated"))).toEqual(["cancelled-1"]);
  });
});

describe("board lanes stay honest while loading, empty, and degraded", () => {
  it("keeps Ready drawn while loading, because absent data is not an empty lane", () => {
    renderBoard({ cards: [], loadedEmptyColumns: ["ready"], loading: true });
    expect(screen.getByTestId("cr.board.column.ready")).toBeTruthy();
    expect(screen.queryByTestId("cr.board.column.ready.collapsed")).toBeNull();
    expect(screen.getAllByTestId("cr.board.skeleton")).toHaveLength(COLUMNS.length);
  });

  it("collapses Ready only on an authoritative loaded-empty lane", () => {
    renderBoard({ cards: [], loadedEmptyColumns: ["ready"] });
    expect(screen.queryByTestId("cr.board.column.ready")).toBeNull();
    expect(screen.getByTestId("cr.board.column.ready.collapsed").textContent).toBe(
      "Ready — the daemon reported this lane empty",
    );
    expect(screen.getByTestId("cr.board.column.executing")).toBeTruthy();
    expect(screen.getByTestId("cr.board.empty.executing").textContent).toBe("Nothing executing");
  });

  it("labels last-known cards as of the applied cursor, and mounts no graph canvas", () => {
    renderBoard({ appliedCursorLabel: "#4821", degraded: true });
    const note = screen.getByTestId("cr.board.asof");
    expect(note.textContent).toBe("Showing last-known cards as of #4821");
    expect(note.getAttribute("role")).toBe("status");
    expect(cardIdsIn()).toEqual([...VISIBLE_ORDER]);
    expect(screen.getByTestId("cr.shell.tab.board").getAttribute("aria-pressed")).toBe("true");
    expect(within(screen.getByTestId("cr.shell.main")).getByTestId("cr.surface.board")).toBeTruthy();
    expect(document.querySelectorAll("[data-testid^='cr.graph.']")).toHaveLength(0);
  });
});

describe("board cards render the supplied node facts and nothing else", () => {
  it("renders exactly the declared fact kinds, one truth chip each", () => {
    renderBoard();
    const ids = [...within(screen.getByTestId("cr.board.card.api-endpnt")).getAllByTestId(
      /^cr\.fact\./u,
    )].map((node) => node.getAttribute("data-testid") ?? "");
    expect(ids).toEqual(CARD_FACTS.map((suffix) => `cr.fact.node.api-endpnt.${suffix}`));
    for (const id of ids) {
      expect(within(screen.getByTestId(id)).getAllByTestId(/^cr\.chip\./u)).toHaveLength(1);
    }
  });

  it("keeps renewal silence and activity silence as two separate facts", () => {
    renderBoard();
    expect(valueOf("node.api-endpnt.lease.renewalsilence")).toBe("renewed 41s ago");
    expect(valueOf("node.api-endpnt.lease.activitysilence")).toBe("quiet 41m");
    expect(
      within(screen.getByTestId("cr.board.card.silence.api-endpnt")).getByTestId(
        "cr.fact.node.api-endpnt.lease.activitysilence",
      ),
    ).toBeTruthy();
  });

  it("shows owner, lease, progress, claim, blocker, wait, budget, and path as supplied", () => {
    renderBoard();
    const expected: readonly (readonly [string, string])[] = [
      ["owner", "w-3"], ["lease.state", "ACTIVE"], ["lease.epoch", "7"], ["slack", "slack 0m"],
      ["lease.expiry", "2026-08-08T09:41:00.000Z"], ["progress", "steps 2/3"],
      ["latestclaim", "retry endpoint returns 202"], ["blocker.type", "DEPENDENCY_UNPROVEN"],
      ["blocker.owner", "human/operator-1"], ["blocker.reason", "waiting on schema fixture"],
      ["wait.owner", "agent/session-a"], ["wait.reason", "intentional wait: fixture milestone"],
      ["wait.recheck", "recheck in 5m"], ["budget.spent", "$18 of $50"],
      ["budget.basis", "metered provider receipts"], ["criticalpath", "on critical path"],
    ];
    expect(expected).toHaveLength(16);
    for (const [suffix, value] of expected) expect(valueOf(`node.api-endpnt.${suffix}`)).toBe(value);
  });

  it("shows overlays exactly as supplied and leaves absent overlays UNKNOWN", () => {
    renderBoard();
    expect(valueOf("node.api-endpnt.suspect")).toBe("SUSPECT");
    expect(valueOf("node.api-endpnt.held")).toBe("held");
    expect(valueOf("node.schema.disposition")).toBe("REBOUND");
    expect(valueOf("node.schema.qualification")).toBe("INVALIDATED");
    expect(valueOf("node.ui-panel.qualification")).toBe("UNKNOWN");
    expect(chipOf("node.ui-panel.qualification").getAttribute("data-origin")).toBe("ABSENT");
  });

  it("qualifies provenance callbacks with the node that owns the fact", async () => {
    const seen: string[] = [];
    renderBoard({ onProvenance: (factId) => seen.push(factId) });
    await userEvent.click(chipOf("node.api-endpnt.lease.epoch"));
    await userEvent.click(chipOf("node.schema.qualification"));
    expect(seen).toEqual(["node.api-endpnt.lease.epoch", "node.schema.qualification"]);
  });

  it("renders no property the contract did not declare, however hostile the payload", () => {
    const hostile = { ...baseCard("leaky"), placement: "review",
      sessionToken: "shhh-bearer-secret" } as BoardCardProjection;
    renderBoard({ cards: [hostile] });
    expect(document.body.innerHTML).not.toContain("shhh-bearer-secret");
    expect(screen.getByTestId("cr.board.card.leaky")).toBeTruthy();
  });
});

describe("board summaries and actions repeat the daemon verbatim", () => {
  it("renders every supplied frontier lane with its cursor, epoch, capacity, and reason", () => {
    renderBoard();
    expect(FRONTIER.length).toBe(4);
    for (const l of FRONTIER) expect(screen.getByTestId(`cr.board.frontier.${l.lane}`)).toBeTruthy();
    expect(valueOf("frontier.READY_NOW.summary")).toBe("2 nodes ready now");
    expect(valueOf("frontier.READY_NOW.cursor")).toBe("#4821");
    expect(valueOf("frontier.READY_NOW.graphepoch")).toBe("epoch 12");
    expect(valueOf("frontier.UNBLOCK_NEXT.idlecapacity")).toBe("1 idle slot");
    expect(valueOf("frontier.INTENTIONAL_WAIT.readiness")).toBe("waiting by operator decision");
    expect(valueOf("frontier.UNSAFE_OR_UNKNOWN.readiness")).toBe("UNKNOWN");
    expect(screen.getByTestId("cr.board.joinstrip").getAttribute("aria-live")).toBe("polite");
    expect(valueOf("join.integrate.summary")).toBe("join integrate - waiting 2/3");
    expect(valueOf("join.integrate.inputs")).toBe("api-endpnt, ui-panel");
  });

  it("renders exactly the supplied commands whose target is this card", async () => {
    const activated: NextAllowedCommand[] = [];
    renderBoard(
      { onActivateCommand: (cmd) => activated.push(cmd) },
      affordance([BLOCKER_OPEN, WORK_RELEASE, FOREIGN]),
    );
    const tuples = [...document.querySelectorAll("[data-testid^='cr.action.']")].map((node) => [
      node.getAttribute("data-command-id"), node.getAttribute("data-command-kind"),
      node.getAttribute("data-command-target"),
    ]);
    expect(tuples).toEqual([
      ["cmd-blocker-1", "blocker.open", "run-api-endpnt"],
      ["cmd-release-1", "work.release", "run-api-endpnt"],
    ]);
    await userEvent.click(screen.getByTestId("cr.action.blocker-open"));
    expect(activated).toHaveLength(1);
    expect(activated[0]).toBe(BLOCKER_OPEN);
    cleanup();
    renderBoard({}, affordance([FOREIGN]));
    expect(document.querySelectorAll("[data-testid^='cr.action.']")).toHaveLength(0);
    cleanup();
    renderBoard({}, affordance([]));
    expect(document.querySelectorAll("[data-testid^='cr.action.']")).toHaveLength(0);
  });

  it("never activates while the supplied snapshot disables mutations", async () => {
    const activated: NextAllowedCommand[] = [];
    renderBoard(
      { onActivateCommand: (cmd) => activated.push(cmd) },
      affordance([BLOCKER_OPEN], false),
    );
    const button = screen.getByTestId<HTMLButtonElement>("cr.action.blocker-open");
    expect(button.disabled).toBe(true);
    await userEvent.click(button);
    await userEvent.click(button);
    expect(activated).toEqual([]);
  });
});

describe("board keyboard walks the supplied lanes in column-major order", () => {
  const focusColumns = (): void => { screen.getByTestId("cr.board.columns").focus(); };
  const focused = (): string | null =>
    document.activeElement?.getAttribute("data-board-card") ?? null;

  it("moves within a lane with j/k, clamps at its end, and opens the focused node", async () => {
    const opened: string[] = [];
    renderBoard({ onOpenCard: (nodeId) => opened.push(nodeId) });
    focusColumns();
    await userEvent.keyboard("j");
    expect(focused()).toBe("plan-doc");
    await userEvent.keyboard("jjj");
    expect(focused()).toBe("contradiction");
    await userEvent.keyboard("k{Enter}");
    expect(opened).toEqual(["same-spelled-a"]);
  });

  it("moves across visible columns with h/l and arrows, clamping the row", async () => {
    renderBoard();
    focusColumns();
    await userEvent.keyboard("jjj");
    expect(focused()).toBe("contradiction");
    await userEvent.keyboard("l");
    expect(focused()).toBe("same-spelled-b");
    await userEvent.keyboard("{ArrowRight}");
    expect(focused()).toBe("dup");
    await userEvent.keyboard("h{ArrowLeft}h");
    expect(focused()).toBe("same-spelled-a");
  });

  it("jumps to a visible column's first card and keeps unequal lanes column-major", async () => {
    renderBoard({ cards: CARDS.filter((card) => card.placement !== "ready"),
      loadedEmptyColumns: ["ready"] });
    const jump = screen.getByTestId<HTMLSelectElement>("cr.board.columnjump");
    expect([...jump.options].map((o) => o.value)).toEqual(["plan", "executing", "review",
      "accepted"]);
    await userEvent.selectOptions(jump, "executing");
    expect(focused()).toBe("api-endpnt");
    expect(cardIdsIn()).toEqual(["plan-doc", "same-spelled-a", "contradiction", "api-endpnt",
      "dup", "dup", "UNKNOWN", "ui-panel", "schema", "ghost"]);
  });

  it("leaves Enter on a card's command button to the button, opening no card", async () => {
    const activated: NextAllowedCommand[] = [];
    const opened: string[] = [];
    renderBoard(
      { onActivateCommand: (cmd) => activated.push(cmd), onOpenCard: (id) => opened.push(id) },
      affordance([BLOCKER_OPEN]),
    );
    const button = screen.getByTestId("cr.action.blocker-open");
    expect(screen.getByTestId("cr.board.card.api-endpnt").contains(button)).toBe(true);
    button.focus();
    await userEvent.keyboard("{Enter}");
    expect(activated).toEqual([BLOCKER_OPEN]);
    expect(opened).toEqual([]);
    expect(document.activeElement).toBe(button);
  });

  it("leaves Enter on a chip inside a card to the chip", async () => {
    const opened: string[] = [];
    const seen: string[] = [];
    renderBoard({ onOpenCard: (id) => opened.push(id), onProvenance: (id) => seen.push(id) });
    const chip = chipOf("node.ui-panel.phase");
    chip.focus();
    await userEvent.keyboard("{Enter}");
    expect(seen).toEqual(["node.ui-panel.phase"]);
    expect(opened).toEqual([]);
  });

  it("walks from the card focus actually sits on, not from the remembered cursor", async () => {
    const opened: string[] = [];
    renderBoard({ onOpenCard: (id) => opened.push(id) });
    screen.getByTestId("cr.board.card.ui-panel").focus();
    await userEvent.keyboard("{Enter}");
    expect(opened).toEqual(["ui-panel"]);
    expect(focused()).toBe("ui-panel");
    cleanup();
    renderBoard();
    screen.getByTestId("cr.board.card.same-spelled-b").focus();
    await userEvent.keyboard("k");
    expect(focused()).toBe("ready-1");
    await userEvent.keyboard("h");
    expect(focused()).toBe("plan-doc");
  });
});
