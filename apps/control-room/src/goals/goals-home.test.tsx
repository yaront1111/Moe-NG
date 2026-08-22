import type { NextAllowedCommand, RuntimeCommandKind } from "@moe/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { FixtureAffordanceSnapshot } from "../fixtures.js";
import type { PresentedFact } from "../nodes/node-authority.js";
import { ShellFrame } from "../shell/frame.js";
import { GoalsHome } from "./goals-home.js";
import type { GoalDraftValues, GoalRowProjection, GoalsHomeProps } from "./goals-home.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`corpus entry ${index} is missing`);
  return item;
}

const obs = (value: string): PresentedFact => ({ truthClass: "OBSERVED", value });
const ver = (value: string): PresentedFact => ({ truthClass: "DAEMON_VERIFIED", value });

/**
 * Hand-written because the point of the assertion is that the surface renders what the
 * daemon said. Deriving these from the module under test would only prove it agrees
 * with itself.
 */
const ROW_FACT_SUFFIXES = [
  "state", "phasedistribution", "providercapacity", "readywidth", "frontier",
  "budget.spent", "budget.reserved", "budget.quarantined", "budget.unknown", "budget.basis",
  "approvals", "held", "suspect", "reconciliation", "lasteventage", "completion",
] as const;

/** A goal id the router must escape and the test id must not. */
const CLOSING_GOAL_ID = "g/closing goal";

const ACTIVE: GoalRowProjection = {
  approvals: obs("1 approval pending"), budgetBasis: ver("metered provider receipts"),
  budgetQuarantined: ver("$0"), budgetReserved: ver("$7"), budgetSpent: ver("$31 of $50"),
  budgetUnknown: ver("$0"), completion: obs("not complete"), frontierStatus: obs("frontier moving"),
  goalId: "g-payments", held: obs("1 held"), lastEventAge: obs("last event 12s ago"),
  phaseDistribution: obs("Plan 1 - Exec 2 - Review 1 - Acc 3"), providerCapacity: obs("2 of 4 sessions"),
  readyWidth: obs("ready width 2"), reconciliation: obs("none"), state: ver("ACTIVE"),
  suspect: obs("none"), title: "payments-retry-hardening",
};

const COMPLETED: GoalRowProjection = {
  approvals: obs("none"), budgetBasis: obs("wall-clock estimate"), budgetQuarantined: obs("$0"),
  budgetReserved: obs("$0"), budgetSpent: obs("$12 of $20"), budgetUnknown: obs("$0"),
  completion: ver("complete 2026-08-08T09:41:00.000Z"), frontierStatus: obs("no frontier"),
  goalId: "g-embed", held: obs("none"), lastEventAge: obs("last event 2m ago"),
  phaseDistribution: obs("Acc 4"), providerCapacity: obs("0 of 4 sessions"),
  readyWidth: obs("ready width 0"), reconciliation: obs("none"), state: ver("COMPLETED"),
  suspect: obs("none"), title: "jetbrains-embed-spike",
};

const CLOSING: GoalRowProjection = {
  approvals: obs("none"), budgetBasis: obs("metered provider receipts"),
  budgetQuarantined: obs("$0"), budgetReserved: obs("$3"), budgetSpent: obs("$44 of $60"),
  budgetUnknown: obs("$0"), completion: obs("blocked on 1 lease, 1 effect"),
  frontierStatus: obs("stalled frontier - 1 avoidable idle slot"), goalId: CLOSING_GOAL_ID,
  held: obs("none"), lastEventAge: obs("last event 41m ago"), phaseDistribution: obs("Exec 1"),
  providerCapacity: obs("1 of 4 sessions"), readyWidth: obs("ready width 0"),
  reconciliation: obs("none"), state: ver("CLOSING"), suspect: obs("1 SUSPECT lease"),
  title: "legacy-cutover",
};

/** Missing and blank facts on purpose: neither may be upgraded to a confident zero. */
const QUARANTINED: GoalRowProjection = {
  approvals: null, budgetBasis: null, budgetQuarantined: obs("2 records quarantined"),
  budgetReserved: undefined, budgetSpent: null, budgetUnknown: obs("$? unknown liability"),
  completion: null, frontierStatus: { truthClass: "OBSERVED", value: "   " }, goalId: "g-import",
  held: null, lastEventAge: null, phaseDistribution: null, providerCapacity: undefined,
  readyWidth: null, reconciliation: ver("NEEDS_RECONCILIATION"), state: obs("ACTIVE"),
  suspect: null, title: "import-legacy-moes",
};

const CORPUS: readonly GoalRowProjection[] = [ACTIVE, COMPLETED, CLOSING, QUARANTINED];

const CREATE_COMMAND: NextAllowedCommand = Object.freeze({
  commandEnvelopeVersion: "moe-runtime-command/1",
  commandId: "cmd-create-1",
  commandKind: "goal.create" as RuntimeCommandKind,
  expectedVersion: 9,
  inputSchemaVersion: "moe-runtime-command-input/1",
  targetAggregateId: "project-alpha",
});

function affordance(
  commands: readonly NextAllowedCommand[],
  mutationsEnabled: boolean,
): FixtureAffordanceSnapshot {
  return {
    connection: "CONNECTED", mutationsEnabled, nextAllowedCommands: commands,
    requiresAffordanceRefresh: false, statusLabel: "",
  };
}

function homeProps(): GoalsHomeProps {
  return {
    creation: {
      budget: "125", policyNote: "default from policy p-14", risk: "elevated",
      riskOptions: ["cautious", "elevated"],
    },
    filterOptions: ["all", "active", "cancelled"],
    filterValue: "all",
    projectAggregateId: "project-alpha",
    rows: CORPUS,
    searchValue: "",
  };
}

function renderHome(
  overrides: Partial<GoalsHomeProps> = {},
  snapshot: FixtureAffordanceSnapshot = affordance([CREATE_COMMAND], true),
): void {
  render(
    <ShellFrame affordance={snapshot}>
      <GoalsHome {...homeProps()} {...overrides} />
    </ShellFrame>,
  );
}

const rowOf = (goalId: string): HTMLElement => screen.getByTestId(`cr.goals.row.${goalId}`);

const valueOf = (factId: string): string =>
  within(screen.getByTestId(`cr.fact.${factId}`)).getByTestId("cr.value").textContent ?? "";

const chipOf = (factId: string): HTMLElement =>
  within(screen.getByTestId(`cr.fact.${factId}`)).getByTestId(/^cr\.chip\./u);

const renderedRowIds = (): readonly string[] =>
  [...document.querySelectorAll("[data-testid^='cr.goals.row.']")].map(
    (node) => (node.getAttribute("data-testid") ?? "").slice("cr.goals.row.".length),
  );

describe("goals home renders the daemon's goal projection in supplied order", () => {
  it("renders one addressable row per supplied goal, in server order", () => {
    renderHome();
    expect(CORPUS.length).toBe(4);
    expect(renderedRowIds()).toEqual(CORPUS.map((row) => row.goalId));
  });

  it("does not sort: a reversed payload renders reversed", () => {
    renderHome({ rows: [...CORPUS].reverse() });
    expect(renderedRowIds()).toEqual([...CORPUS].reverse().map((row) => row.goalId));
  });

  it("renders exactly the declared fact kinds for every row, one chip each", () => {
    renderHome();
    for (const row of CORPUS) {
      const ids = [...within(rowOf(row.goalId)).getAllByTestId(/^cr\.fact\./u)].map(
        (node) => node.getAttribute("data-testid") ?? "",
      );
      expect(ids).toEqual(ROW_FACT_SUFFIXES.map((suffix) => `cr.fact.goal.${row.goalId}.${suffix}`));
      for (const id of ids) {
        expect(within(screen.getByTestId(id)).getAllByTestId(/^cr\.chip\./u)).toHaveLength(1);
      }
    }
  });

  it("shows the supplied goal state, phase distribution, capacity, and frontier verbatim", () => {
    renderHome();
    expect(valueOf("goal.g-payments.state")).toBe("ACTIVE");
    expect(valueOf("goal.g-embed.state")).toBe("COMPLETED");
    expect(valueOf(`goal.${CLOSING_GOAL_ID}.state`)).toBe("CLOSING");
    expect(valueOf("goal.g-payments.phasedistribution")).toBe("Plan 1 - Exec 2 - Review 1 - Acc 3");
    expect(valueOf("goal.g-payments.providercapacity")).toBe("2 of 4 sessions");
    expect(valueOf("goal.g-payments.readywidth")).toBe("ready width 2");
    expect(valueOf(`goal.${CLOSING_GOAL_ID}.frontier`)).toBe(
      "stalled frontier - 1 avoidable idle slot",
    );
  });

  it("shows every supplied budget component beside its basis", () => {
    renderHome();
    expect(valueOf("goal.g-payments.budget.spent")).toBe("$31 of $50");
    expect(valueOf("goal.g-payments.budget.reserved")).toBe("$7");
    expect(valueOf("goal.g-payments.budget.quarantined")).toBe("$0");
    expect(valueOf("goal.g-payments.budget.unknown")).toBe("$0");
    expect(valueOf("goal.g-payments.budget.basis")).toBe("metered provider receipts");
    expect(valueOf("goal.g-embed.budget.basis")).toBe("wall-clock estimate");
  });

  it("shows approvals, held, SUSPECT, reconciliation, age, and completion as supplied", () => {
    renderHome();
    expect(valueOf("goal.g-payments.approvals")).toBe("1 approval pending");
    expect(valueOf("goal.g-payments.held")).toBe("1 held");
    expect(valueOf(`goal.${CLOSING_GOAL_ID}.suspect`)).toBe("1 SUSPECT lease");
    expect(valueOf("goal.g-import.reconciliation")).toBe("NEEDS_RECONCILIATION");
    expect(valueOf("goal.g-embed.lasteventage")).toBe("last event 2m ago");
    expect(valueOf("goal.g-embed.completion")).toBe("complete 2026-08-08T09:41:00.000Z");
    expect(valueOf(`goal.${CLOSING_GOAL_ID}.completion`)).toBe("blocked on 1 lease, 1 effect");
  });

  it("renders a missing or blank fact as UNKNOWN with no borrowed truth class", () => {
    renderHome();
    for (const suffix of ["budget.spent", "budget.basis", "providercapacity", "frontier"]) {
      expect(valueOf(`goal.g-import.${suffix}`)).toBe("UNKNOWN");
      expect(chipOf(`goal.g-import.${suffix}`).getAttribute("data-origin")).toBe("ABSENT");
    }
    expect(valueOf("goal.g-import.budget.quarantined")).toBe("2 records quarantined");
  });

  it("qualifies every provenance callback with the entity that owns the fact", async () => {
    const seen: string[] = [];
    renderHome({ onProvenance: (factId) => seen.push(factId) });
    await userEvent.click(chipOf("goal.g-payments.budget.spent"));
    await userEvent.click(chipOf("goal.g-embed.budget.spent"));
    expect(seen).toEqual(["goal.g-payments.budget.spent", "goal.g-embed.budget.spent"]);
  });

  it("links every goal to its board projection with an encoded id", () => {
    renderHome();
    expect(screen.getByTestId("cr.goals.link.g-payments").getAttribute("href")).toBe(
      "/goal/g-payments/board",
    );
    expect(screen.getByTestId(`cr.goals.link.${CLOSING_GOAL_ID}`).getAttribute("href")).toBe(
      "/goal/g%2Fclosing%20goal/board",
    );
  });
});

describe("goals home keeps filter, search, and row keyboard control with its caller", () => {
  it("renders the supplied filter options and reports changes without self-filtering", async () => {
    const picked: string[] = [];
    renderHome({ filterValue: "active", onFilterChange: (value) => picked.push(value) });
    const filter = screen.getByTestId<HTMLSelectElement>("cr.goals.filter");
    expect([...filter.options].map((option) => option.value)).toEqual([
      "all", "active", "cancelled",
    ]);
    expect(filter.value).toBe("active");
    await userEvent.selectOptions(filter, "cancelled");
    expect(picked).toEqual(["cancelled"]);
    expect(renderedRowIds()).toEqual(CORPUS.map((row) => row.goalId));
  });

  it("reports each search keystroke and never narrows the list itself", async () => {
    const typed: string[] = [];
    renderHome({ onSearchChange: (value) => typed.push(value) });
    await userEvent.type(screen.getByTestId("cr.goals.search"), "pay");
    expect(typed).toEqual(["p", "a", "y"]);
    expect(renderedRowIds()).toHaveLength(CORPUS.length);
  });

  it("moves focus with j/k and opens the focused row with Enter", async () => {
    const focused: string[] = [];
    const opened: string[] = [];
    renderHome({
      onFocusRow: (goalId) => focused.push(goalId),
      onOpenGoal: (goalId) => opened.push(goalId),
    });
    screen.getByTestId("cr.goals.list").focus();
    await userEvent.keyboard("j");
    expect(document.activeElement).toBe(rowOf(at(CORPUS, 0).goalId));
    await userEvent.keyboard("j");
    expect(document.activeElement).toBe(rowOf(at(CORPUS, 1).goalId));
    await userEvent.keyboard("k");
    expect(document.activeElement).toBe(rowOf(at(CORPUS, 0).goalId));
    await userEvent.keyboard("{Enter}");
    expect(focused).toEqual(["g-payments", "g-embed", "g-payments"]);
    expect(opened).toEqual(["g-payments"]);
  });

  it("leaves Enter on a row's own link to the link, opening no goal", async () => {
    const opened: string[] = [];
    const followed: string[] = [];
    renderHome({ onOpenGoal: (goalId) => opened.push(goalId) });
    const link = screen.getByTestId(`cr.goals.link.${CLOSING_GOAL_ID}`);
    link.addEventListener("click", (event) => {
      event.preventDefault();
      followed.push(link.getAttribute("href") ?? "");
    });
    link.focus();
    await userEvent.keyboard("{Enter}");
    expect(followed).toEqual(["/goal/g%2Fclosing%20goal/board"]);
    expect(opened).toEqual([]);
    expect(document.activeElement).toBe(link);
  });

  it("walks from the row focus actually sits on, not from the remembered cursor", async () => {
    const focused: string[] = [];
    const opened: string[] = [];
    renderHome({
      onFocusRow: (goalId) => focused.push(goalId),
      onOpenGoal: (goalId) => opened.push(goalId),
    });
    rowOf(CLOSING_GOAL_ID).focus();
    await userEvent.keyboard("{Enter}");
    expect(opened).toEqual([CLOSING_GOAL_ID]);
    expect(document.activeElement).toBe(rowOf(CLOSING_GOAL_ID));
    rowOf("g-payments").focus();
    await userEvent.keyboard("j");
    expect(document.activeElement).toBe(rowOf("g-embed"));
    expect(focused).toEqual(["g-embed"]);
  });
});

describe("goals home is honest while loading, empty, and degraded", () => {
  it("renders exactly three skeleton rows and no goal rows while loading", () => {
    renderHome({ loading: true });
    expect(screen.getAllByTestId("cr.goals.skeleton")).toHaveLength(3);
    expect(renderedRowIds()).toEqual([]);
  });

  it("renders the pinned empty copy when the daemon supplied no goals", () => {
    renderHome({ rows: [] });
    expect(screen.getByTestId("cr.goals.empty").textContent).toBe(
      "No goals yet. [New goal] — one sentence is enough to start.",
    );
  });

  it("labels last-known rows with the applied cursor instead of looking current", () => {
    renderHome({ appliedCursorLabel: "#4821", degraded: true });
    const note = screen.getByTestId("cr.goals.asof");
    expect(note.textContent).toBe("Showing last-known goals as of #4821");
    expect(note.getAttribute("role")).toBe("status");
    expect(renderedRowIds()).toEqual(CORPUS.map((row) => row.goalId));
  });
});

describe("goal creation uses only the supplied affordance and supplied policy defaults", () => {
  it("prefills budget and risk from the supplied policy, not from a client default", () => {
    renderHome();
    expect(screen.getByTestId<HTMLInputElement>("cr.goals.field.budget").value).toBe("125");
    const risk = screen.getByTestId<HTMLSelectElement>("cr.goals.field.risk");
    expect([...risk.options].map((option) => option.value)).toEqual(["cautious", "elevated"]);
    expect(risk.value).toBe("elevated");
    expect(screen.getByTestId("cr.goals.policynote").textContent).toBe(
      "default from policy p-14",
    );
  });

  it("hands the caller the identical supplied command object plus the local draft", async () => {
    const calls: { command: NextAllowedCommand; draft: GoalDraftValues }[] = [];
    renderHome({ onCreate: (command, draft) => calls.push({ command, draft }) });
    await userEvent.type(screen.getByTestId("cr.goals.field.outcome"), "Fix stale-port crash");
    const button = screen.getByTestId("cr.action.goal-create");
    expect(button.getAttribute("data-command-id")).toBe("cmd-create-1");
    expect(button.getAttribute("data-command-kind")).toBe("goal.create");
    expect(button.getAttribute("data-command-target")).toBe("project-alpha");
    await userEvent.click(button);
    expect(calls).toHaveLength(1);
    expect(at(calls, 0).command).toBe(CREATE_COMMAND);
    expect(at(calls, 0).draft).toEqual({
      acceptance: "", budget: "125", outcome: "Fix stale-port crash", risk: "elevated",
    });
  });

  it("renders no creation control when the supplied command targets another aggregate", () => {
    const foreign: NextAllowedCommand = { ...CREATE_COMMAND, targetAggregateId: "project-beta" };
    renderHome({}, affordance([foreign], true));
    expect(screen.queryByTestId("cr.action.goal-create")).toBeNull();
    expect(screen.getByTestId("cr.goals.create").children).toHaveLength(0);
  });

  it("renders no creation control when the daemon supplied no command at all", () => {
    renderHome({}, affordance([], true));
    expect(screen.queryByTestId("cr.action.goal-create")).toBeNull();
  });

  it("cannot call back while the supplied snapshot disables mutations", async () => {
    const calls: NextAllowedCommand[] = [];
    renderHome(
      { onCreate: (command) => calls.push(command) },
      affordance([CREATE_COMMAND], false),
    );
    const button = screen.getByTestId<HTMLButtonElement>("cr.action.goal-create");
    expect(button.disabled).toBe(true);
    await userEvent.click(button);
    expect(calls).toEqual([]);
  });
});
