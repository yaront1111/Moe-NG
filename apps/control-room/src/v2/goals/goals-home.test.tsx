import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { LiveSetup } from "../../live/live-config.js";
import type { SurfaceFrame, SurfaceStep } from "../../live/live-board-feed.js";
import { CordumShell } from "../shell/cordum-shell.js";
import { deriveLiveGoals } from "./goal-model.js";
import { FIXTURE_GOALS_DATA } from "./goals-fixtures.js";
import { GoalsHome } from "./goals-home.js";
import { NewGoalForm } from "./new-goal-form.js";
import { createGoalDispatcher } from "./live-goals.js";

/**
 * The goals home (UI-3): the live derivation over a fake affordance surface, the
 * frozen fixtures view, the new-goal form + PRD drop, and the goal.create
 * dispatch. Components are rendered directly, not through the entry point.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

function step(partial: Partial<SurfaceStep> & Pick<SurfaceStep, "kind" | "status">): SurfaceStep {
  return {
    aggregateId: partial.aggregateId ?? null,
    claim: partial.claim ?? null,
    kind: partial.kind,
    missing: partial.missing ?? [],
    status: partial.status,
    version: partial.version ?? 0,
  };
}

function surface(steps: readonly SurfaceStep[], offers: readonly Record<string, unknown>[] = []): SurfaceFrame {
  return { connection: "CONNECTED", detail: "", offers, outcome: "SURFACE", steps };
}

const LIVE_STEPS: readonly SurfaceStep[] = [
  step({ kind: "work.dispatch", aggregateId: "node-21", status: "READY" }),
  step({ kind: "plan.propose", aggregateId: "run-live-1", status: "BLOCKED", missing: ["provider.probe"] }),
  step({
    kind: "node.deliver", aggregateId: "node-31", status: "READY",
    claim: { claimedBy: "agent/session-a", expiresAt: "2027-01-01T00:00:00.000Z" },
  }),
  step({ kind: "project.register", aggregateId: "project-1", status: "COMMITTED", version: 1 }),
];

describe("the goals home renders a goal from a fake affordance surface", () => {
  it("derives one goal card with surface-backed headline facts", () => {
    const data = deriveLiveGoals(surface(LIVE_STEPS));
    expect(data.goals).toHaveLength(1);
    render(<GoalsHome data={data} onCreateGoal={vi.fn()} onOpenBoard={vi.fn()} />);

    const card = screen.getByTestId("cr.goals.card.goal-live-1");
    expect(within(card).getByTestId("cr.goals.card.goal-live-1.title").textContent).toBe("goal-live-1");
    // Ready = 2 (one unclaimed + one claimed), blocked = 1, committed = 1.
    expect(within(card).getByTestId("cr.goals.pill.goal-live-1.ready").textContent).toContain("2 steps");
    expect(within(card).getByTestId("cr.goals.pill.goal-live-1.blocked").textContent).toContain("1 step");
    expect(within(card).getByTestId("cr.goals.pill.goal-live-1.committed").textContent).toContain("1 step");
    // The one project, never a fabricated second goal.
    expect(data.goalCountLabel).toContain("1 GOAL");
  });

  it("returns an honest coming-online empty state before the surface answers", () => {
    const data = deriveLiveGoals(null);
    expect(data.goals).toHaveLength(0);
    expect(data.comingOnlineNote).toContain("Waiting for the daemon");
    render(<GoalsHome data={data} onCreateGoal={vi.fn()} onOpenBoard={vi.fn()} />);
    expect(screen.getByTestId("cr.goals.empty").textContent).toContain("Waiting for the daemon");
    expect(screen.queryByTestId("cr.goals.list")).toBeNull();
  });
});

describe("coming-online fields never render a fabricated number", () => {
  it("shows a budget placeholder chip, not a spend number, on a live goal", () => {
    const data = deriveLiveGoals(surface(LIVE_STEPS));
    render(<GoalsHome data={data} onCreateGoal={vi.fn()} onOpenBoard={vi.fn()} />);

    const budget = screen.getByTestId("cr.goals.card.goal-live-1.budget.comingonline");
    expect(budget.textContent).toBe("BUDGET COMING ONLINE");
    // The card body carries no minutes-spent number the surface cannot source.
    expect(screen.getByTestId("cr.goals.card.goal-live-1").textContent).not.toContain("min spent");

    // The expander names the surface-supplied facts by real count, not a fabricated 16.
    const expander = screen.getByTestId("cr.goals.card.goal-live-1.expand");
    expect(expander.textContent).toContain(String(data.goals[0]?.facts.length));
    expect(expander.textContent).not.toContain("16");
  });

  it("lists the un-sourced fields as coming online in the expanded facts", async () => {
    const user = userEvent.setup();
    const data = deriveLiveGoals(surface(LIVE_STEPS));
    render(<GoalsHome data={data} onCreateGoal={vi.fn()} onOpenBoard={vi.fn()} />);
    await user.click(screen.getByTestId("cr.goals.card.goal-live-1.expand"));
    expect(screen.getByTestId("cr.goals.comingonline.budgetenvelope").textContent).toContain("COMING ONLINE");
    expect(screen.getByTestId("cr.goals.comingonline.suppliedfactsbundle")).toBeTruthy();
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
    await user.click(screen.getByTestId("cr.goals.newgoal.create"));

    expect(onCreateGoal).toHaveBeenCalledTimes(1);
    expect(onCreateGoal.mock.calls[0]?.[0]).toMatchObject({ outcome: "Ship the entry" });
  });

  it("shows the dropped file name and size, marked as not yet read", async () => {
    const user = userEvent.setup();
    render(<NewGoalForm onCancel={vi.fn()} onCreate={vi.fn()} />);
    const file = new File(["# PRD\nbuild it"], "prd.md", { type: "text/markdown" });
    await user.upload(screen.getByTestId("cr.goals.newgoal.prd.input"), file);

    const shown = screen.getByTestId("cr.goals.newgoal.prd.file");
    expect(shown.textContent).toContain("prd.md");
    expect(shown.textContent).toContain("Moe will read this once ingest is wired");
    // The outcome is pre-filled with a clearly-marked placeholder, not silent prose.
    expect((screen.getByTestId("cr.goals.newgoal.outcome") as HTMLInputElement).value)
      .toContain("prd.md");
  });
});

describe("Create goal dispatches goal.create through the kept dispatch layer", () => {
  it("hands the daemon's own goal.create offer back as a goal.create envelope", async () => {
    const user = userEvent.setup();
    const sent: { kind?: string }[] = [];
    const builder = vi.fn((affordance: unknown, caller: unknown) => ({
      ok: true as const,
      envelope: { kind: "goal.create", affordance, caller },
    }));
    const setup = {
      ok: true,
      client: { commands: { "goal.create": builder } },
      headers: {},
      projection: "moe.board",
      sessionCredential: "cred-1",
      subscriberId: "control-room-1",
      transport: {
        sendCommand: async (envelope: { kind?: string }) => {
          sent.push(envelope);
          return {
            delivered: true as const,
            response: { ok: true, decision: { disposition: "DECIDED", resultCode: "EFFECTS_COMMITTED" } },
          };
        },
      },
    } as unknown as LiveSetup;

    const frame = surface(LIVE_STEPS, [{
      commandId: "cmd-goal-create",
      commandKind: "goal.create",
      expectedVersion: 0,
      targetAggregateId: "goal-live-1",
    }]);
    const onCreateGoal = createGoalDispatcher(setup, () => frame);

    render(
      <CordumShell>
        <GoalsHome data={deriveLiveGoals(frame)} onCreateGoal={onCreateGoal} onOpenBoard={vi.fn()} />
      </CordumShell>,
    );
    await user.click(screen.getByTestId("cr.goals.new"));
    await user.click(screen.getByTestId("cr.goals.newgoal.create"));

    await waitFor(() => { expect(sent).toHaveLength(1); });
    expect(sent[0]?.kind).toBe("goal.create");
    expect(builder).toHaveBeenCalledTimes(1);
    // The report surfaces the daemon's own answer and the prose-not-durable leftover.
    await waitFor(() => {
      expect(screen.getByTestId("cr.goals.createreport").textContent).toContain("goal prose is not persisted");
    });
  });

  it("reports plainly when the surface offers no goal.create affordance", async () => {
    const setup = {
      ok: true, client: { commands: {} }, headers: {}, projection: "moe.board",
      sessionCredential: "c", subscriberId: "control-room-1",
      transport: { sendCommand: vi.fn() },
    } as unknown as LiveSetup;
    const dispatcher = createGoalDispatcher(setup, () => surface(LIVE_STEPS));
    const report = await dispatcher({
      outcome: "x", acceptanceCriteria: [], budgetEnvelope: "", riskClass: "STANDARD",
    });
    expect(report).toContain("goal.create is not on the affordance surface");
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

  it("filters to the blocked goal and opens its board", async () => {
    const user = userEvent.setup();
    const onOpenBoard = vi.fn();
    render(<GoalsHome data={FIXTURE_GOALS_DATA} onCreateGoal={vi.fn()} onOpenBoard={onOpenBoard} />);

    await user.click(screen.getByTestId("cr.goals.filter.blocked"));
    const items = within(screen.getByTestId("cr.goals.list")).getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(screen.getByTestId("cr.goals.card.goal-recovery")).toBeTruthy();

    await user.click(screen.getByTestId("cr.goals.card.goal-recovery.open"));
    expect(onOpenBoard).toHaveBeenCalledWith("goal-recovery", "Genesis recovery binding on a fresh store");
  });
});

describe("a truth chip on a goal fact opens the proof drawer", () => {
  it("routes a headline chip through the shell's proof inspector", async () => {
    const user = userEvent.setup();
    render(
      <CordumShell>
        <GoalsHome data={deriveLiveGoals(surface(LIVE_STEPS))} onCreateGoal={vi.fn()} onOpenBoard={vi.fn()} />
      </CordumShell>,
    );
    const pill = screen.getByTestId("cr.goals.pill.goal-live-1.ready");
    await user.click(within(pill).getByTestId("cr.chip.daemon_verified"));
    const claim = screen.getByTestId("cr.shell.inspector.claim");
    expect(claim.textContent).toContain("Ready");
    expect(claim.textContent).toContain("2 steps");
  });
});
