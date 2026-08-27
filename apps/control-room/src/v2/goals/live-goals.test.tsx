import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { admitGoalBrief } from "@moe/contracts";

import type { LiveSetup } from "../../live/live-config.js";
import type { GoalDraft } from "./goal-model.js";
import { briefOfDraft } from "./live-goal-create.js";
import { LiveGoalsHome } from "./live-goals.js";

/**
 * task-dc9341112f9a40dca68fc92697f22c50 - the LIVE Create goal flow end to end.
 *
 * Every arm drives the real component over a stubbed `fetch`, so the affordance
 * surface, the durable goal catalog, and the command transport are the only
 * seams. The daemon-side authority is never reimplemented here: the expected
 * payload is computed through the PRODUCTION `briefOfDraft` and normalised by
 * `admitGoalBrief` from @moe/contracts.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const COMMAND_ID = "cmd-goal-create-1";
const DURABLE_GOAL_ID = `goal-${COMMAND_ID}`;
/** The fixed dev prose HEAD used to send; no arm may ever reproduce it. */
const FIXED_PROSE = "Land the live board's demo node.";

const OFFER = Object.freeze({
  commandEnvelopeVersion: "moe-runtime-command/1",
  commandId: COMMAND_ID,
  commandKind: "goal.create",
  expectedVersion: 0,
  inputSchemaVersion: "moe-goal-create/1",
  targetAggregateId: "project-live-1",
});

interface SentEnvelope {
  readonly commandId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

function catalogRow(goalId: string): Record<string, unknown> {
  return {
    brief: { instructions: "durable instructions", title: "Durable title" },
    goalId,
    planningRunRef: `run-${goalId}`,
  };
}

interface WireState {
  /** Swapped between arms and between polls; the catalog is the only goal source. */
  catalogGoals: Record<string, unknown>[];
  readonly sent: SentEnvelope[];
  send: (envelope: SentEnvelope) => unknown;
}

function stubWire(state: WireState): void {
  vi.stubGlobal("fetch", vi.fn(async (path: string): Promise<Response> => {
    if (path === "/affordances/read") {
      return {
        json: async () => ({ nextAllowedCommands: [{ ...OFFER }], outcome: "SURFACE", steps: [] }),
        status: 200,
      } as unknown as Response;
    }
    if (path === "/goals/read") {
      return {
        json: async () => ({ goals: [...state.catalogGoals], nextCursor: null, outcome: "GOALS" }),
        status: 200,
      } as unknown as Response;
    }
    throw new Error(`unexpected fetch path ${path}`);
  }));
}

function attachedSetup(state: WireState): LiveSetup {
  return {
    client: { commands: {} },
    headers: { authorization: "Bearer live" },
    ok: true,
    projectId: "project-live-1",
    projection: "moe.board",
    sessionCredential: "cred-live-1",
    subscriberId: "control-room-1",
    transport: {
      sendCommand: vi.fn(async (envelope: SentEnvelope) => {
        state.sent.push(envelope);
        return state.send(envelope);
      }),
    },
  } as unknown as LiveSetup;
}

function wire(send: WireState["send"], catalogGoals: Record<string, unknown>[] = []): WireState {
  return { catalogGoals, send, sent: [] };
}

const OK_ANSWER = {
  delivered: true as const,
  response: { decision: { disposition: "DECIDED", resultCode: "EFFECTS_COMMITTED" }, ok: true },
  status: 200,
};

function refusalAnswer(code: string, layer: string): unknown {
  return { delivered: true as const, response: { ok: false, refusal: { code, layer } }, status: 200 };
}

async function openForm(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await waitFor(() => { expect(screen.getByTestId("cr.goals.new")).not.toHaveProperty("disabled", true); });
  await user.click(screen.getByTestId("cr.goals.new"));
  await screen.findByTestId("cr.goals.newgoal.form");
}

function fill(draft: { budget: string; criteria: string; outcome: string; title: string }): void {
  fireEvent.change(screen.getByTestId("cr.goals.newgoal.title"), { target: { value: draft.title } });
  fireEvent.change(screen.getByTestId("cr.goals.newgoal.outcome"), { target: { value: draft.outcome } });
  fireEvent.change(screen.getByTestId("cr.goals.newgoal.criteria"), { target: { value: draft.criteria } });
  fireEvent.change(screen.getByTestId("cr.goals.newgoal.budget"), { target: { value: draft.budget } });
}

const DRAFT_A = {
  budget: "90 min",
  criteria: "pnpm test:security exits 0\nthe stdio entry answers a handshake",
  outcome: "Behind bearer credentials",
  title: "Ship stdio entry",
};
const DRAFT_B = {
  budget: "20 min agent time",
  criteria: "the release archive carries the broker",
  outcome: "Publish the windows candidate",
  title: "Rotate the publication digest",
};

/** The exact payload the production composition + the shared contract produce. */
function expectedPayload(draft: typeof DRAFT_A): { instructions: string; title: string } {
  const composed: GoalDraft = {
    acceptanceCriteria: draft.criteria.split("\n").map((line) => line.trim()).filter((l) => l !== ""),
    budgetEnvelope: draft.budget,
    outcome: draft.outcome,
    title: draft.title,
  };
  const admitted = admitGoalBrief(briefOfDraft(composed));
  if (!admitted.ok) throw new Error("the arm's own fixture draft must be admissible");
  return admitted.brief;
}

describe("the live Create goal flow sends the operator's actual draft", () => {
  it("sends each distinct draft verbatim and never the fixed dev prose", async () => {
    const user = userEvent.setup({ delay: null });
    const state = wire(() => OK_ANSWER);
    stubWire(state);
    render(<LiveGoalsHome onOpenBoard={vi.fn()} setup={attachedSetup(state)} />);

    await openForm(user);
    fill(DRAFT_A);
    await user.click(screen.getByTestId("cr.goals.newgoal.create"));
    await waitFor(() => { expect(state.sent).toHaveLength(1); });

    await openForm(user);
    fill(DRAFT_B);
    await user.click(screen.getByTestId("cr.goals.newgoal.create"));
    await waitFor(() => { expect(state.sent).toHaveLength(2); });

    expect(state.sent[0]?.payload).toEqual(expectedPayload(DRAFT_A));
    expect(state.sent[1]?.payload).toEqual(expectedPayload(DRAFT_B));
    expect(state.sent[0]?.payload).not.toEqual(state.sent[1]?.payload);

    for (const envelope of state.sent) {
      expect(Object.keys(envelope.payload).sort()).toEqual(["instructions", "title"]);
      expect(envelope.payload["instructions"]).not.toBe(FIXED_PROSE);
      expect(envelope.payload["title"]).not.toBe("Live board goal");
    }
    // The pre-contract shape is gone: no caller-named identity rides the payload.
    expect(state.sent[0]?.payload).not.toHaveProperty("budgetAccountRef");
    expect(state.sent[0]?.payload).not.toHaveProperty("goalId");
    expect(state.sent[0]?.payload).not.toHaveProperty("planningRunRef");
    expect(state.sent[0]?.payload).not.toHaveProperty("witness");
    // The operator's own words reach the daemon, one composed brief per draft.
    expect(String(state.sent[0]?.payload["instructions"])).toContain("Behind bearer credentials");
    expect(String(state.sent[0]?.payload["instructions"])).toContain("pnpm test:security exits 0");
    expect(state.sent[0]?.payload["title"]).toBe("Ship stdio entry");
  });
});

describe("only a durable goal read back from the catalog drives goal state", () => {
  it("shows and opens the catalog entry the daemon minted for the sent command", async () => {
    const user = userEvent.setup({ delay: null });
    const onOpenBoard = vi.fn();
    const state = wire(() => OK_ANSWER);
    stubWire(state);
    render(<LiveGoalsHome onOpenBoard={onOpenBoard} setup={attachedSetup(state)} />);

    await openForm(user);
    fill(DRAFT_A);
    // The daemon mints goal-<commandId>; the catalog starts carrying it only after the write.
    state.catalogGoals = [catalogRow(DURABLE_GOAL_ID)];
    await user.click(screen.getByTestId("cr.goals.newgoal.create"));

    const card = await screen.findByTestId(`cr.goals.card.${DURABLE_GOAL_ID}`);
    expect(card).toBeTruthy();
    expect(state.sent[0]?.commandId).toBe(COMMAND_ID);
    await waitFor(() => { expect(screen.queryByTestId("cr.goals.awaitingcatalog")).toBeNull(); });

    await user.click(screen.getByTestId(`cr.goals.card.${DURABLE_GOAL_ID}.open`));
    expect(onOpenBoard).toHaveBeenCalledWith(DURABLE_GOAL_ID, "Durable title");
  });

  it("opens nothing and renders no goal when the catalog does not carry the write", async () => {
    const user = userEvent.setup({ delay: null });
    const onOpenBoard = vi.fn();
    const state = wire(() => OK_ANSWER);
    stubWire(state);
    render(<LiveGoalsHome onOpenBoard={onOpenBoard} setup={attachedSetup(state)} />);

    await openForm(user);
    fill(DRAFT_A);
    await user.click(screen.getByTestId("cr.goals.newgoal.create"));

    const awaiting = await screen.findByTestId("cr.goals.awaitingcatalog");
    expect(awaiting.textContent).toContain("awaiting catalog");
    // The locally derivable id is a lookup key only; it is never rendered as a goal.
    expect(screen.queryByTestId(`cr.goals.card.${DURABLE_GOAL_ID}`)).toBeNull();
    expect(screen.queryByTestId("cr.goals.list")).toBeNull();
    expect(onOpenBoard).not.toHaveBeenCalled();
  });
});

describe("selecting a PRD writes nothing anywhere", () => {
  it("reaches no ingest route and sends no command until Create is clicked", async () => {
    const user = userEvent.setup({ delay: null });
    const state = wire(() => OK_ANSWER);
    stubWire(state);
    render(<LiveGoalsHome onOpenBoard={vi.fn()} setup={attachedSetup(state)} />);

    await openForm(user);
    const file = new File(["# PRD\nbuild it"], "prd.md", { type: "text/markdown" });
    await user.upload(screen.getByTestId("cr.goals.newgoal.prd.input"), file);
    await waitFor(() => {
      expect(screen.getByTestId("cr.goals.newgoal.prd.file").textContent).toContain("prd.md");
    });

    const paths = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((call) => String(call[0]));
    // The affordance and catalog polls are reads; nothing here writes.
    expect(paths).not.toContain("/documents/ingest");
    expect(paths.every((path) => path === "/affordances/read" || path === "/goals/read")).toBe(true);
    expect(state.sent).toHaveLength(0);
  });
});

describe("a refused create keeps the operator's draft on screen with its reason code", () => {
  it("refuses an over-limit title at the shared brief contract without reaching the daemon", async () => {
    const user = userEvent.setup({ delay: null });
    const state = wire(() => { throw new Error("the daemon must not be reached"); });
    stubWire(state);
    render(<LiveGoalsHome onOpenBoard={vi.fn()} setup={attachedSetup(state)} />);

    await openForm(user);
    fill(DRAFT_A);
    // Non-empty, so the form's own emptiness guard cannot refuse; over 1024 UTF-8
    // bytes, so `admitGoalBrief` inside `buildGoalBriefCommand` is the ONLY
    // mechanism able to refuse this input, and the transport is never called.
    const overLimit = "x".repeat(1_025);
    fireEvent.change(screen.getByTestId("cr.goals.newgoal.title"), { target: { value: overLimit } });
    await user.click(screen.getByTestId("cr.goals.newgoal.create"));

    const report = await screen.findByTestId("cr.goals.newgoal.report");
    await waitFor(() => { expect(report.textContent).toContain("GOAL_BRIEF_INPUT_INVALID"); });
    expect(report.textContent).toContain("GOAL_BRIEF_CONTRACT");
    expect(state.sent).toHaveLength(0);
    // The draft survives the refusal, field for field.
    expect(screen.getByTestId("cr.goals.newgoal.form")).toBeTruthy();
    expect((screen.getByTestId("cr.goals.newgoal.outcome") as HTMLInputElement).value)
      .toBe(DRAFT_A.outcome);
    expect((screen.getByTestId("cr.goals.newgoal.budget") as HTMLInputElement).value)
      .toBe(DRAFT_A.budget);
  });

  it("keeps the draft and names the transport code when the round trip never delivers", async () => {
    const user = userEvent.setup({ delay: null });
    const state = wire(() => ({ code: "TRANSPORT_REQUEST_FAILED", delivered: false as const }));
    stubWire(state);
    render(<LiveGoalsHome onOpenBoard={vi.fn()} setup={attachedSetup(state)} />);

    await openForm(user);
    fill(DRAFT_A);
    await user.click(screen.getByTestId("cr.goals.newgoal.create"));

    const report = await screen.findByTestId("cr.goals.newgoal.report");
    await waitFor(() => { expect(report.textContent).toContain("UNDELIVERED"); });
    expect(report.textContent).toContain("TRANSPORT_REQUEST_FAILED");
    expect(screen.getByTestId("cr.goals.newgoal.form")).toBeTruthy();
    expect((screen.getByTestId("cr.goals.newgoal.title") as HTMLInputElement).value)
      .toBe(DRAFT_A.title);
  });

  it("keeps the draft and shows both code and layer when authorization refuses", async () => {
    const user = userEvent.setup({ delay: null });
    const state = wire(() => refusalAnswer("SESSION_AUTHORITY_REQUIRED", "DAEMON_AUTHORIZATION"));
    stubWire(state);
    render(<LiveGoalsHome onOpenBoard={vi.fn()} setup={attachedSetup(state)} />);

    await openForm(user);
    fill(DRAFT_A);
    await user.click(screen.getByTestId("cr.goals.newgoal.create"));

    const report = await screen.findByTestId("cr.goals.newgoal.report");
    await waitFor(() => { expect(report.textContent).toContain("SESSION_AUTHORITY_REQUIRED"); });
    expect(report.textContent).toContain("DAEMON_AUTHORIZATION");
    expect(screen.getByTestId("cr.goals.newgoal.form")).toBeTruthy();
    expect((screen.getByTestId("cr.goals.newgoal.title") as HTMLInputElement).value)
      .toBe(DRAFT_A.title);
  });

  it("keeps the draft and shows both code and layer when the durable write conflicts", async () => {
    const user = userEvent.setup({ delay: null });
    const state = wire(() => refusalAnswer("EXPECTED_VERSION_CONFLICT", "DURABLE_STORE"));
    stubWire(state);
    render(<LiveGoalsHome onOpenBoard={vi.fn()} setup={attachedSetup(state)} />);

    await openForm(user);
    fill(DRAFT_A);
    await user.click(screen.getByTestId("cr.goals.newgoal.create"));

    const report = await screen.findByTestId("cr.goals.newgoal.report");
    await waitFor(() => { expect(report.textContent).toContain("EXPECTED_VERSION_CONFLICT"); });
    expect(report.textContent).toContain("DURABLE_STORE");
    expect(screen.getByTestId("cr.goals.newgoal.form")).toBeTruthy();
    expect((screen.getByTestId("cr.goals.newgoal.outcome") as HTMLInputElement).value)
      .toBe(DRAFT_A.outcome);
  });
});

describe("only a committed create discards the draft", () => {
  it("closes the form once and reopens it empty", async () => {
    const user = userEvent.setup({ delay: null });
    const state = wire(() => OK_ANSWER, [catalogRow(DURABLE_GOAL_ID)]);
    stubWire(state);
    render(<LiveGoalsHome onOpenBoard={vi.fn()} setup={attachedSetup(state)} />);

    await openForm(user);
    fill(DRAFT_A);
    await user.click(screen.getByTestId("cr.goals.newgoal.create"));

    await waitFor(() => { expect(screen.queryByTestId("cr.goals.newgoal.form")).toBeNull(); });
    await openForm(user);
    expect((screen.getByTestId("cr.goals.newgoal.title") as HTMLInputElement).value).toBe("");
    expect((screen.getByTestId("cr.goals.newgoal.outcome") as HTMLInputElement).value).toBe("");
    expect((screen.getByTestId("cr.goals.newgoal.criteria") as HTMLTextAreaElement).value).toBe("");
    expect((screen.getByTestId("cr.goals.newgoal.budget") as HTMLInputElement).value).toBe("");
    expect(state.sent).toHaveLength(1);
  });
});
