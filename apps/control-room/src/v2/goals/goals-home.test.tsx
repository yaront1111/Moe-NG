import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { LiveSetup } from "../../live/live-config.js";
import type { SurfaceFrame, SurfaceStep } from "../../live/live-board-feed.js";
import { CordumShell } from "../shell/cordum-shell.js";
import { deriveLiveGoals } from "./goal-model.js";
import { deriveGoalCatalog } from "./goal-catalog-model.js";
import { FIXTURE_GOALS_DATA } from "./goals-fixtures.js";
import { GoalsHome } from "./goals-home.js";
import { NewGoalForm } from "./new-goal-form.js";
import { createGoalDispatcher, goalCreateDisabledReason } from "./live-goals.js";

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

function surface(
  steps: readonly SurfaceStep[],
  offers: readonly Record<string, unknown>[] = [],
  goalCreatePlanningRunRef: string | null = "run-daemon-issued",
): SurfaceFrame {
  return {
    connection: "CONNECTED", detail: "", goalCreatePlanningRunRef,
    offers, outcome: "SURFACE", steps,
  } as SurfaceFrame;
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

  it("disables New goal explicitly after the daemon's single planning slot is bound", () => {
    const bound = { ...surface(LIVE_STEPS, [], null), planningGoalRef: "goal-bound" };
    const reason = goalCreateDisabledReason(bound);
    expect(reason).toContain("already bound");
    render(
      <GoalsHome
        createDisabledReason={reason}
        data={deriveLiveGoals(bound)}
        onCreateGoal={vi.fn()}
        onOpenBoard={vi.fn()}
      />,
    );
    const action = screen.getByTestId("cr.goals.new") as HTMLButtonElement;
    expect(action.disabled).toBe(true);
    expect(action.title).toBe(reason);
  });
});

describe("durable goal navigation", () => {
  it("opens the catalog goal with its stored title and real planning-run ref", async () => {
    const user = userEvent.setup();
    const onOpenBoard = vi.fn();
    const data = deriveGoalCatalog({
      connection: "CONNECTED", detail: "",
      goals: [{
        brief: { instructions: "Keep this exact intent.", title: "Operator title" },
        goalId: "goal-durable-random", planningRunRef: "run-durable-random", prd: null,
      }],
      outcome: "GOALS",
    });
    render(<GoalsHome data={data} onCreateGoal={vi.fn()} onOpenBoard={onOpenBoard} />);

    await user.click(screen.getByTestId("cr.goals.card.goal-durable-random.open"));

    expect(onOpenBoard).toHaveBeenCalledWith(
      "goal-durable-random", "Operator title", "run-durable-random",
    );
  });

  it("renders bounded catalog window controls without claiming a total count", async () => {
    const user = userEvent.setup();
    const onFirst = vi.fn();
    const onNext = vi.fn();
    const data = deriveGoalCatalog({
      connection: "CONNECTED", detail: "",
      goals: [{ brief: null, goalId: "goal-page-9", planningRunRef: "run-page-9", prd: null }],
      outcome: "GOALS",
    });
    render(
      <GoalsHome
        catalogNavigation={{
          currentPage: 9, hasEarlier: true, hasMore: true, onFirst, onNext,
        }}
        data={data}
        onCreateGoal={vi.fn()}
        onOpenBoard={vi.fn()}
      />,
    );

    expect(screen.getByTestId("cr.goals.count").textContent).toContain("CURRENT PAGE");
    expect(screen.getByTestId("cr.goals.catalog.page").textContent).toBe("PAGE 9");
    await user.click(screen.getByTestId("cr.goals.catalog.first"));
    await user.click(screen.getByTestId("cr.goals.catalog.next"));
    expect(onFirst).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledTimes(1);
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
    const onCreateGoal = vi.fn<(draft: unknown) => Promise<{ created: boolean; report: string }>>()
      .mockResolvedValue({ created: true, report: "CREATED" });
    render(<GoalsHome data={FIXTURE_GOALS_DATA} onCreateGoal={onCreateGoal} onOpenBoard={vi.fn()} />);

    expect(screen.queryByTestId("cr.goals.newgoal.form")).toBeNull();
    await user.click(screen.getByTestId("cr.goals.new"));
    await user.type(screen.getByTestId("cr.goals.newgoal.outcome"), "Ship the entry");
    await user.click(screen.getByTestId("cr.goals.newgoal.create"));

    expect(onCreateGoal).toHaveBeenCalledTimes(1);
    expect(onCreateGoal.mock.calls[0]?.[0]).toMatchObject({ outcome: "Ship the entry" });
    await screen.findByText("CREATED");
    expect(screen.queryByTestId("cr.goals.newgoal.form")).toBeNull();
  });

  it("keeps the operator draft open when creation resolves with a refusal", async () => {
    const user = userEvent.setup();
    const onCreateGoal = vi.fn().mockResolvedValue({
      created: false, report: "REFUSED: prose is not durable",
    });
    render(<GoalsHome data={FIXTURE_GOALS_DATA} onCreateGoal={onCreateGoal} onOpenBoard={vi.fn()} />);

    await user.click(screen.getByTestId("cr.goals.new"));
    await user.type(screen.getByTestId("cr.goals.newgoal.outcome"), "Do not discard me");
    await user.click(screen.getByTestId("cr.goals.newgoal.create"));
    await screen.findByText("REFUSED: prose is not durable");

    expect(screen.getByTestId("cr.goals.newgoal.form")).toBeTruthy();
    expect((screen.getByTestId("cr.goals.newgoal.outcome") as HTMLInputElement).value)
      .toBe("Do not discard me");
  });

  it("freezes an ambiguously delivered draft while allowing its exact retry", async () => {
    const user = userEvent.setup();
    const onCreateGoal = vi.fn().mockResolvedValue({
      created: false,
      report: "UNDELIVERED: TRANSPORT_REQUEST_FAILED",
      retryUnchanged: true,
    });
    render(<GoalsHome data={FIXTURE_GOALS_DATA} onCreateGoal={onCreateGoal} onOpenBoard={vi.fn()} />);

    await user.click(screen.getByTestId("cr.goals.new"));
    const outcome = screen.getByTestId("cr.goals.newgoal.outcome") as HTMLInputElement;
    await user.type(outcome, "Keep this exact retry");
    await user.click(screen.getByTestId("cr.goals.newgoal.create"));
    await screen.findByText("UNDELIVERED: TRANSPORT_REQUEST_FAILED");

    expect(outcome.disabled).toBe(true);
    expect((screen.getByTestId("cr.goals.newgoal.cancel") as HTMLButtonElement).disabled).toBe(true);
    const retry = screen.getByTestId("cr.goals.newgoal.create") as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
    expect(retry.textContent).toContain("Retry unchanged goal");
    expect((screen.getByTestId("cr.goals.new") as HTMLButtonElement).disabled).toBe(true);

    await user.click(retry);
    expect(onCreateGoal).toHaveBeenCalledTimes(2);
    expect(onCreateGoal.mock.calls[1]?.[0]).toStrictEqual(onCreateGoal.mock.calls[0]?.[0]);
  });

  it("shows local-only PRD metadata without authoring an outcome", async () => {
    const user = userEvent.setup();
    render(<NewGoalForm onCancel={vi.fn()} onCreate={vi.fn()} />);
    const file = new File(["# PRD\nbuild it"], "prd.md", { type: "text/markdown" });
    await user.upload(screen.getByTestId("cr.goals.newgoal.prd.input"), file);

    const shown = screen.getByTestId("cr.goals.newgoal.prd.file");
    expect(shown.textContent).toContain("prd.md");
    expect(shown.textContent).toContain("Nothing has been read or sent");
    expect((screen.getByTestId("cr.goals.newgoal.outcome") as HTMLInputElement).value).toBe("");
  });
});

describe("Create goal dispatches the complete operator draft", () => {
  it("reads an attached PRD only on Create and sends one explicit goal-bound payload", async () => {
    const sent: { kind?: string }[] = [];
    const builder = vi.fn((affordance: unknown, caller: unknown) => ({
      ok: true as const,
      envelope: { ...(affordance as object), kind: "goal.create", caller },
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
            response: {
              decision: {
                commandId: "cmd-goal-create", disposition: "DECIDED",
                effectId: "effect-goal", resultCode: "EFFECTS_COMMITTED",
              },
              httpStatus: 200, ok: true, outcome: "ACCEPTED",
            },
            status: 200,
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
    const dispatcher = createGoalDispatcher(setup, () => frame);
    const readText = vi.fn().mockResolvedValue("# Private PRD\nExact words");
    const report = await dispatcher({
      outcome: "Keep these exact operator words",
      acceptanceCriteria: ["The stored goal contains them"],
      budgetEnvelope: "45 min",
      riskClass: "ELEVATED",
      prd: { mediaType: "text/markdown", name: "private.md", readText, size: 25 },
    });

    expect(report).toMatchObject({ created: true });
    expect(readText).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    expect(builder).toHaveBeenCalledTimes(1);
    expect(builder.mock.calls[0]?.[1]).toMatchObject({
      payload: {
        brief: {
          title: "Keep these exact operator words",
          instructions: expect.stringContaining("The stored goal contains them"),
        },
        budgetAccountRef: "budget-goal-live-1",
        goalId: "goal-live-1",
        planningRunRef: "run-daemon-issued",
        prd: {
          displayPath: "private.md", mediaType: "text/markdown",
          text: "# Private PRD\nExact words",
        },
        witness: {},
      },
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
    expect(report).toMatchObject({ created: false });
    expect(report.report).toContain("No current goal.create offer");
    expect(setup.transport.sendCommand).not.toHaveBeenCalled();
  });

  it("reuses the exact prepared command and cached PRD bytes after an ambiguous delivery", async () => {
    const builder = vi.fn((affordance: unknown, caller: unknown) => ({
      ok: true as const, envelope: { ...(affordance as object), caller },
    }));
    const sendCommand = vi.fn()
      .mockResolvedValueOnce({ delivered: false, code: "TRANSPORT_REQUEST_FAILED" })
      .mockResolvedValueOnce({
        delivered: true, status: 200,
        response: {
          decision: {
            commandId: "cmd-retry", disposition: "REPLAYED",
            effectId: "effect-retry", resultCode: "EFFECTS_COMMITTED",
          },
          httpStatus: 200, ok: true, outcome: "ACCEPTED",
        },
      });
    const setup = {
      ok: true, client: { commands: { "goal.create": builder } }, headers: {},
      projection: "moe.board", sessionCredential: "cred", subscriberId: "control-room-1",
      transport: { sendCommand },
    } as unknown as LiveSetup;
    const offer = {
      commandId: "cmd-retry", commandKind: "goal.create", expectedVersion: 0,
      targetAggregateId: "goal-retry",
    };
    const dispatcher = createGoalDispatcher(setup, () => surface(LIVE_STEPS, [offer]));
    const readText = vi.fn().mockResolvedValue("retry bytes");
    const draft = {
      acceptanceCriteria: [], budgetEnvelope: "", outcome: "Retry me",
      prd: { mediaType: "text/plain", name: "retry.txt", readText, size: 11 },
      riskClass: "" as const,
    };

    expect(await dispatcher(draft)).toMatchObject({ created: false, retryUnchanged: true });
    expect(await dispatcher(draft)).toMatchObject({ created: true });
    expect(readText).toHaveBeenCalledTimes(1);
    expect(builder.mock.calls[0]?.[0]).toBe(builder.mock.calls[1]?.[0]);
    expect(builder.mock.calls[0]?.[1]).toEqual(builder.mock.calls[1]?.[1]);
  });

  it("locks an ambiguous create to its exact draft instead of minting a duplicate", async () => {
    const builder = vi.fn((affordance: unknown, caller: unknown) => ({
      ok: true as const, envelope: { ...(affordance as object), caller },
    }));
    const sendCommand = vi.fn()
      .mockResolvedValueOnce({ delivered: false, code: "TRANSPORT_REQUEST_FAILED" });
    const setup = {
      ok: true, client: { commands: { "goal.create": builder } }, headers: {},
      projection: "moe.board", sessionCredential: "cred", subscriberId: "control-room-1",
      transport: { sendCommand },
    } as unknown as LiveSetup;
    let offer = {
      commandId: "cmd-ambiguous", commandKind: "goal.create", expectedVersion: 0,
      targetAggregateId: "goal-ambiguous",
    };
    const dispatcher = createGoalDispatcher(setup, () => surface(LIVE_STEPS, [offer]));
    const original = {
      acceptanceCriteria: [], budgetEnvelope: "", outcome: "Original intent",
      riskClass: "" as const,
    };

    expect(await dispatcher(original)).toMatchObject({ created: false, retryUnchanged: true });
    // A later poll may mint a different offer, but changed intent must not be
    // sent while the first command's commit status is unknown.
    offer = { ...offer, commandId: "cmd-new", targetAggregateId: "goal-new" };
    const changed = await dispatcher({ ...original, outcome: "Changed intent" });

    expect(changed).toMatchObject({ created: false, retryUnchanged: true });
    expect(changed.report).toContain("AMBIGUOUS_CREATE_RETRY_LOCKED");
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(builder).toHaveBeenCalledTimes(1);
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
