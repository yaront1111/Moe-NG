import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { GoalCatalogFrame } from "../../live/live-goal-catalog.js";
import { CordumShell } from "../shell/cordum-shell.js";
import { deriveGoalCatalog } from "./goal-catalog-model.js";
import type { GoalCreateResult, GoalDraft, GoalsData } from "./goal-model.js";
import { FIXTURE_GOALS_DATA } from "./goals-fixtures.js";
import { GoalsHome } from "./goals-home.js";
import { NewGoalForm } from "./new-goal-form.js";

/**
 * The goals home (UI-3): the durable catalog presentation, the frozen fixtures
 * view, the new-goal form + PRD drop, and the create outcomes.
 * Components are rendered directly, not through the entry point.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const CATALOG_GOALS: GoalCatalogFrame["goals"] = Object.freeze([
  Object.freeze({
    binding: null,
    brief: null,
    goalId: "goal-durable-alpha",
    planningRunRef: "run-durable-alpha",
    truthClass: "DAEMON_VERIFIED",
  }),
  Object.freeze({
    binding: null,
    brief: Object.freeze({ instructions: "Retain durable identity.", title: "Second durable goal" }),
    goalId: "goal-durable-beta",
    planningRunRef: "run-durable-beta",
    truthClass: "HUMAN_APPROVED",
  }),
]);

function catalog(): GoalCatalogFrame {
  return { connection: "CONNECTED", detail: "", goals: CATALOG_GOALS, outcome: "GOALS" };
}

describe("coming-online fields never render a fabricated number", () => {
  it("shows a budget placeholder chip, not a spend number, on a live goal", () => {
    const data = deriveGoalCatalog(catalog());
    expect(data.goalCountLabel).toBe("2 goals");
    expect(data.goals.map(({ goalId }) => goalId)).toEqual([
      "goal-durable-alpha", "goal-durable-beta",
    ]);
    render(<GoalsHome data={data} onCreateGoal={vi.fn()} onOpenBoard={vi.fn()} />);

    expect(screen.getByTestId("cr.goals.card.goal-durable-alpha")).toBeTruthy();
    expect(screen.getByTestId("cr.goals.card.goal-durable-beta")).toBeTruthy();
    // No placeholder chip: a fact the catalog cannot source is left out, not announced as coming.
    expect(screen.getByTestId("cr.goals.card.goal-durable-alpha").textContent).not.toContain("COMING ONLINE");
    // The card body carries no minutes-spent number the catalog cannot source.
    expect(screen.getByTestId("cr.goals.card.goal-durable-alpha").textContent).not.toContain("min spent");

    // The expander names the catalog-supplied facts by their real production count.
    const expander = screen.getByTestId("cr.goals.card.goal-durable-alpha.expand");
    expect(expander.textContent).toContain(String(data.goals[0]?.facts.length));
    expect(expander.textContent).not.toContain("16");
  });

  it("expands only the supplied facts; un-sourced fields are left out rather than announced", async () => {
    const user = userEvent.setup();
    const data = deriveGoalCatalog(catalog());
    render(<GoalsHome data={data} onCreateGoal={vi.fn()} onOpenBoard={vi.fn()} />);
    await user.click(screen.getByTestId("cr.goals.card.goal-durable-alpha.expand"));
    expect(screen.getByTestId("cr.goals.card.goal-durable-alpha.facts").textContent).not.toContain("COMING ONLINE");
  });
});

describe("the new-goal form and PRD drop", () => {
  it("opens the form from New goal and hands a draft to onCreateGoal", async () => {
    const user = userEvent.setup();
    const onCreateGoal = vi.fn<(draft: unknown) => Promise<string>>().mockResolvedValue("ok");
    render(<GoalsHome data={FIXTURE_GOALS_DATA} onCreateGoal={onCreateGoal} onOpenBoard={vi.fn()} />);

    expect(screen.queryByTestId("cr.goals.newgoal.form")).toBeNull();
    await user.click(screen.getByTestId("cr.goals.new"));
    await user.type(screen.getByTestId("cr.goals.newgoal.outcome"), "Ship the entry");
    await user.type(screen.getByTestId("cr.goals.newgoal.title"), "Ship the entry");
    await user.click(screen.getByTestId("cr.goals.newgoal.create"));

    expect(onCreateGoal).toHaveBeenCalledTimes(1);
    expect(onCreateGoal.mock.calls[0]?.[0]).toMatchObject({ outcome: "Ship the entry" });
  });

  it("shows the dropped file name and size once the browser has read it", async () => {
    const user = userEvent.setup();
    render(<NewGoalForm onCancel={vi.fn()} onCreate={vi.fn()} />);
    const file = new File(["# PRD"], "prd.md", { type: "text/markdown" });
    await user.upload(screen.getByTestId("cr.goals.newgoal.prd.input"), file);

    const shown = await screen.findByTestId("cr.goals.newgoal.prd.file");
    expect(shown.textContent).toContain("prd.md");
    expect(shown.textContent).toContain("5 B");
  });
});

describe("the form closes on a committed create and on nothing else", () => {
  async function submitDraft(): Promise<void> {
    const user = userEvent.setup();
    await user.click(screen.getByTestId("cr.goals.new"));
    await user.type(screen.getByTestId("cr.goals.newgoal.outcome"), "Behind bearer credentials");
    await user.type(screen.getByTestId("cr.goals.newgoal.title"), "Ship stdio entry");
    await user.click(screen.getByTestId("cr.goals.newgoal.create"));
  }

  it("closes the form exactly once when the create commits", async () => {
    const onCreateGoal = vi.fn<(draft: GoalDraft) => Promise<GoalCreateResult>>()
      .mockResolvedValue({ commandId: "cmd-1", ok: true, report: "DECIDED EFFECTS_COMMITTED" });
    render(<GoalsHome data={FIXTURE_GOALS_DATA} onCreateGoal={onCreateGoal} onOpenBoard={vi.fn()} />);
    await submitDraft();

    await waitFor(() => { expect(screen.queryByTestId("cr.goals.newgoal.form")).toBeNull(); });
    expect(screen.getByTestId("cr.goals.newgoal.report").textContent)
      .toBe("DECIDED EFFECTS_COMMITTED");
    expect(onCreateGoal).toHaveBeenCalledTimes(1);
  });

  it("keeps the form open and shows code at layer when the create is refused", async () => {
    const onCreateGoal = vi.fn<(draft: GoalDraft) => Promise<GoalCreateResult>>()
      .mockResolvedValue({ ok: false, report: "SESSION_AUTHORITY_REQUIRED @ DAEMON_AUTHORIZATION" });
    render(<GoalsHome data={FIXTURE_GOALS_DATA} onCreateGoal={onCreateGoal} onOpenBoard={vi.fn()} />);
    await submitDraft();

    await waitFor(() => {
      expect(screen.getByTestId("cr.goals.newgoal.report").textContent)
        .toBe("SESSION_AUTHORITY_REQUIRED @ DAEMON_AUTHORIZATION");
    });
    expect(screen.getByTestId("cr.goals.newgoal.form")).toBeTruthy();
    expect((screen.getByTestId("cr.goals.newgoal.title") as HTMLInputElement).value)
      .toBe("Ship stdio entry");
  });

  it("keeps the form open when the dispatch throws", async () => {
    const onCreateGoal = vi.fn<(draft: GoalDraft) => Promise<GoalCreateResult>>()
      .mockRejectedValue(new Error("socket closed"));
    render(<GoalsHome data={FIXTURE_GOALS_DATA} onCreateGoal={onCreateGoal} onOpenBoard={vi.fn()} />);
    await submitDraft();

    await waitFor(() => {
      expect(screen.getByTestId("cr.goals.newgoal.report").textContent).toContain("UNDELIVERED:");
    });
    expect(screen.getByTestId("cr.goals.newgoal.form")).toBeTruthy();
    expect((screen.getByTestId("cr.goals.newgoal.outcome") as HTMLInputElement).value)
      .toBe("Behind bearer credentials");
  });

  it("treats a report-only caller as not having created anything", async () => {
    const onCreateGoal = vi.fn<(draft: GoalDraft) => Promise<string>>()
      .mockResolvedValue("goal.create is not dispatched in fixtures mode");
    render(<GoalsHome data={FIXTURE_GOALS_DATA} onCreateGoal={onCreateGoal} onOpenBoard={vi.fn()} />);
    await submitDraft();

    await waitFor(() => {
      expect(screen.getByTestId("cr.goals.newgoal.report").textContent)
        .toBe("goal.create is not dispatched in fixtures mode");
    });
    // Nothing was created, so nothing may be discarded.
    expect(screen.getByTestId("cr.goals.newgoal.form")).toBeTruthy();
    expect((screen.getByTestId("cr.goals.newgoal.title") as HTMLInputElement).value)
      .toBe("Ship stdio entry");
  });
});

describe("selecting a PRD from the goals home reaches no route", () => {
  it("makes zero calls to the document ingest route", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn((_path: string): Response => {
      throw new Error("the goals home must not call any route");
    });
    vi.stubGlobal("fetch", fetchSpy);
    render(<GoalsHome data={FIXTURE_GOALS_DATA} onCreateGoal={vi.fn()} onOpenBoard={vi.fn()} />);

    await user.click(screen.getByTestId("cr.goals.new"));
    const file = new File(["# PRD"], "prd.md", { type: "text/markdown" });
    await user.upload(screen.getByTestId("cr.goals.newgoal.prd.input"), file);
    await waitFor(() => {
      expect(screen.getByTestId("cr.goals.newgoal.prd.file").textContent).toContain("prd.md");
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    const paths = fetchSpy.mock.calls.map((call) => String(call[0]));
    expect(paths).not.toContain("/documents/ingest");
  });

  it("tells the operator the file stays in this browser until Create", async () => {
    const user = userEvent.setup();
    render(<GoalsHome data={FIXTURE_GOALS_DATA} onCreateGoal={vi.fn()} onOpenBoard={vi.fn()} />);
    await user.click(screen.getByTestId("cr.goals.new"));

    expect(screen.getByTestId("cr.goals.newgoal.prd").textContent).toContain(
      "It is read in this browser only; nothing is sent until you click Create goal.",
    );
  });
});

describe("the fixtures view reproduces the designed goals home", () => {
  it("renders the three designed goals and the designed triage strips", () => {
    render(<GoalsHome data={FIXTURE_GOALS_DATA} onCreateGoal={vi.fn()} onOpenBoard={vi.fn()} />);
    expect(within(screen.getByTestId("cr.goals.list")).getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByTestId("cr.goals.triage.approvals").textContent).toContain("Approvals waiting on you");
    expect(screen.getByTestId("cr.goals.count").textContent).toContain("3 GOALS");
    // Each fixture goal expands to exactly the 16 supplied facts the design names.
    expect(screen.getByTestId("cr.goals.card.goal-j1.expand").textContent).toContain("16 supplied facts");
  });

  /**
   * Every card in the frozen fixture catalog is runless - `goals-fixtures.ts` sets
   * no `planningRunRef` on any of the three - so the fixtures alone can only witness
   * the REFUSING half. The opening half needs a card carrying a run, built here from
   * the same fixture goal so the two arms differ in exactly one field.
   */
  function withDurableRun(planningRunRef: string): GoalsData {
    return {
      ...FIXTURE_GOALS_DATA,
      goals: FIXTURE_GOALS_DATA.goals.map((goal) =>
        goal.goalId === "goal-recovery" ? { ...goal, planningRunRef } : goal),
    };
  }

  it("filters to the blocked goal and refuses to open a board it has no run for", async () => {
    const user = userEvent.setup();
    const onOpenBoard = vi.fn();
    render(<GoalsHome data={FIXTURE_GOALS_DATA} onCreateGoal={vi.fn()} onOpenBoard={onOpenBoard} />);

    await user.click(screen.getByTestId("cr.goals.filter.blocked"));
    const items = within(screen.getByTestId("cr.goals.list")).getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(screen.getByTestId("cr.goals.card.goal-recovery")).toBeTruthy();

    // The fixture goal has no durable planning run, so neither door opens a board.
    expect(screen.queryByTestId("cr.goals.card.goal-recovery.open")).toBeNull();
    const unavailable = screen.getByTestId("cr.goals.card.goal-recovery.open-unavailable") as HTMLButtonElement;
    expect(unavailable.disabled).toBe(true);
    expect(unavailable.title).toBe("No durable planning run is recorded for this goal.");
    await user.click(unavailable);
    await user.click(screen.getByTestId("cr.goals.card.goal-recovery.title"));
    expect(onOpenBoard).not.toHaveBeenCalled();
  });

  /**
   * THE TRIAGE STRIP IS A THIRD DOOR, and the only one where this component is the
   * SOLE decider: it does not render through GoalCard, so the disabled-Open control the
   * sibling landed never gets a say. Its guard therefore needs its own coverage - found
   * missing by the adversarial review on this row, not by the plan.
   */
  function withTriageTo(goalId: string, data: GoalsData): GoalsData {
    return {
      ...data,
      triage: [{
        count: "1", id: "openable", label: "Open this goal",
        openGoalId: goalId, sub: "one goal", tone: "accent",
      }],
    };
  }

  it("refuses a triage strip that names a goal with no durable run", async () => {
    const user = userEvent.setup();
    const onOpenBoard = vi.fn();
    // The strip points at a REAL fixture goal that simply has no run. Every fixture
    // card is runless, so this is the untouched fixture plus one strip.
    const runless = FIXTURE_GOALS_DATA.goals.find((goal) => goal.planningRunRef === undefined);
    expect(runless).toBeDefined();
    render(
      <GoalsHome
        data={withTriageTo(runless?.goalId ?? "", FIXTURE_GOALS_DATA)}
        onCreateGoal={vi.fn()}
        onOpenBoard={onOpenBoard}
      />,
    );

    await user.click(screen.getByTestId("cr.goals.triage.openable"));
    // Not opened, and NOTHING placeholder-shaped was substituted to make the call fit.
    expect(onOpenBoard).not.toHaveBeenCalled();
  });

  it("opens from a triage strip with the same three durable arguments a card supplies", async () => {
    const user = userEvent.setup();
    const onOpenBoard = vi.fn();
    const data = withDurableRun("run-recovery");
    const opened = data.goals.find((goal) => goal.planningRunRef !== undefined);
    expect(opened).toBeDefined();
    render(
      <GoalsHome
        data={withTriageTo(opened?.goalId ?? "", data)}
        onCreateGoal={vi.fn()}
        onOpenBoard={onOpenBoard}
      />,
    );

    await user.click(screen.getByTestId("cr.goals.triage.openable"));
    // The SAME three values the card door supplies: one composer, not two lookups.
    expect(onOpenBoard).toHaveBeenCalledWith(
      opened?.goalId, opened?.planningRunRef, opened?.title,
    );
  });

  it("filters to the blocked goal and opens its board when it has a durable run", async () => {
    const user = userEvent.setup();
    const onOpenBoard = vi.fn();
    const data = withDurableRun("run-recovery");
    // Every expected argument is READ BACK from the fixture that produced it. A run id
    // or title spelled beside the assertion is a fixed point: the producer could change
    // under it and the arm would keep passing on a value nothing supplies any more.
    const opened = data.goals.find((goal) => goal.planningRunRef !== undefined);
    expect(opened).toBeDefined();
    render(<GoalsHome data={data} onCreateGoal={vi.fn()} onOpenBoard={onOpenBoard} />);

    await user.click(screen.getByTestId("cr.goals.filter.blocked"));
    const items = within(screen.getByTestId("cr.goals.list")).getAllByRole("listitem");
    expect(items).toHaveLength(1);

    await user.click(screen.getByTestId(`cr.goals.card.${opened?.goalId}.open`));
    // POSITIONAL, not merely arity: title moves from second to THIRD and both it and the
    // run are strings, so a swap of the last two typechecks silently. Drill D2 proves it.
    expect(onOpenBoard).toHaveBeenCalledWith(
      opened?.goalId, opened?.planningRunRef, opened?.title,
    );
    // Nothing placeholder-shaped ever reaches the run slot (DoD 3).
    const runSlot = onOpenBoard.mock.calls[0]?.[1];
    expect(runSlot).toBe(opened?.planningRunRef);
    expect(runSlot).not.toBe("");
    expect(runSlot).not.toBeUndefined();
  });
});

describe("a truth chip on a goal fact opens the proof drawer", () => {
  it("routes a headline chip through the shell's proof inspector", async () => {
    const user = userEvent.setup();
    render(
      <CordumShell>
        <GoalsHome data={deriveGoalCatalog(catalog())} onCreateGoal={vi.fn()} onOpenBoard={vi.fn()} />
      </CordumShell>,
    );
    const pill = screen.getByTestId("cr.goals.pill.goal-durable-alpha.goal");
    await user.click(within(pill).getByTestId("cr.chip.daemon_verified"));
    const claim = screen.getByTestId("cr.shell.inspector.claim");
    expect(claim.querySelector(".cr2-proof-label")?.textContent).toBe("Goal");
    expect(claim.querySelector(".cr2-proof-value > span:last-child")?.textContent)
      .toBe("goal-durable-alpha");
  });
});

/**
 * THE CONSUMER ROSTER FOR `onOpenBoard`, and the arity of every declaration of it.
 *
 * This exists because the detector that guarded the callback was written as
 * `onOpenBoard(` WITH a paren, which finds only the two direct call sites and is BLIND
 * to every `onOpenBoard={...}` prop-passing consumer - including the three in
 * cordum-app.tsx that are the only ones a widening can break. That blindness deadlocked
 * this row against its own parent for days.
 *
 * So the sweep matches the BARE symbol, and it walks the tree rather than naming files
 * by path: a consumer added in a new file, or one moved by a file split, still lands in
 * `found` and must be accounted for here. Set equality is asserted in BOTH directions,
 * so a new consumer reds this arm instead of silently escaping the roster.
 */
const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const ONOPENBOARD_CONSUMERS: readonly string[] = Object.freeze([
  "v2/approvals/live-needs-you.test.tsx",
  "v2/approvals/live-needs-you.tsx",
  "v2/approvals/needs-you.test.tsx",
  "v2/approvals/needs-you.tsx",
  "v2/approvals/preview-card.test.tsx",
  "v2/approvals/preview-rejection-invariants.test.tsx",
  "v2/cordum-app.tsx",
  "v2/goals/goal-card.test.tsx",
  "v2/goals/goal-card.tsx",
  "v2/goals/goal-create-disabled.test.tsx",
  "v2/goals/goal-nodes.tsx",
  "v2/goals/goals-home.test.tsx",
  "v2/goals/goals-home.tsx",
  "v2/goals/live-goals.test.tsx",
  "v2/goals/live-goals.tsx",
  "v2/runs/live-runs.test.tsx",
  "v2/runs/live-runs.tsx",
  "v2/runs/runs-screen.test.tsx",
  "v2/runs/runs-screen.tsx",
]);

/** Every file under the control room's src that mentions the symbol, at any spelling. */
function sweepConsumers(): readonly string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.tsx?$/u.test(entry.name)) continue;
      if (!readFileSync(full, "utf8").includes("onOpenBoard")) continue;
      found.push(relative(SRC_ROOT, full).split(sep).join("/"));
    }
  };
  walk(SRC_ROOT);
  return found.sort();
}

describe("the onOpenBoard consumer roster is complete and its arity is pinned", () => {
  it("sweeps the bare symbol and matches the frozen roster in both directions", () => {
    const found = sweepConsumers();
    // A sweep that generated nothing would satisfy every assertion below vacuously.
    expect(found.length).toBeGreaterThan(0);
    // EXACT, not `> 0`: a one-member roster satisfies a lower bound.
    expect(ONOPENBOARD_CONSUMERS).toHaveLength(19);
    expect(Object.isFrozen(ONOPENBOARD_CONSUMERS)).toBe(true);
    // Both directions at once: nothing missing from the roster, nothing stale in it.
    expect(found).toEqual([...ONOPENBOARD_CONSUMERS]);
  });

  it("declares exactly three parameters wherever the widened callback is a prop", () => {
    const declarations = sweepConsumers()
      .filter((rel) => !rel.includes(".test."))
      .flatMap((rel) => {
        const match = /readonly onOpenBoard: \(([^)]*)\) => void;/u
          .exec(readFileSync(join(SRC_ROOT, rel), "utf8"));
        return match === null ? [] : [{ params: (match[1] ?? "").trim(), rel }];
      });
    // The sweep found declarations at all, so the assertions below are not vacuous.
    expect(declarations.length).toBeGreaterThan(0);

    const widened = declarations.filter((entry) => entry.params !== "");
    const thunks = declarations.filter((entry) => entry.params === "");
    // GoalCard's prop is a ZERO-ARG THUNK and is deliberately NOT widened: goals-home
    // adapts it, so the arity never reaches it. taskRail 3 owns that file elsewhere.
    expect(thunks.map((entry) => entry.rel)).toEqual(["v2/goals/goal-card.tsx"]);
    expect(widened.map((entry) => entry.rel)).toEqual([
      "v2/approvals/live-needs-you.tsx", "v2/approvals/needs-you.tsx",
      "v2/goals/goals-home.tsx", "v2/goals/live-goals.tsx",
      "v2/runs/live-runs.tsx", "v2/runs/runs-screen.tsx",
    ]);
    // THREE, asserted as a property rather than as an incident: a fourth parameter added
    // later must move this assertion instead of arriving unannounced.
    for (const entry of widened) {
      expect(entry.params.split(",").map((part) => part.trim()), entry.rel).toEqual([
        "goalId: string", "planningRunRef: string", "title: string",
      ]);
    }
  });

  /**
   * THE CONSUMER SIDE, and it is the one nothing else guards.
   *
   * A consumer that takes FEWER parameters than the callback supplies is ACCEPTED by
   * TypeScript, and here the discarded position is a `string` sitting against another
   * `string` - so narrowing `openBoard` back to `(goalId, title)` typechecks cleanly
   * while binding the planning run into the title slot. Measured on this row: that
   * mutant passed `tsc` AND all 1430 package tests. Only a source-text arity pin sees
   * it, so this arm is that pin.
   */
  it("pins the arity of the shell's openBoard producer, which the checker cannot", () => {
    const producers = sweepConsumers()
      .filter((rel) => !rel.includes(".test."))
      .flatMap((rel) => {
        const match = /const openBoard = useCallback\(\(([^)]*)\)/u
          .exec(readFileSync(join(SRC_ROOT, rel), "utf8"));
        return match === null ? [] : [{ params: (match[1] ?? "").trim(), rel }];
      });
    // Non-vacuous: the sweep found a producer to grade.
    expect(producers).toHaveLength(1);
    expect(producers[0]?.rel).toBe("v2/cordum-app.tsx");
    expect(producers[0]?.params.split(",").map((part) => part.trim())).toEqual([
      "goalId: string", "planningRunRef: string", "title: string",
    ]);
  });
});
