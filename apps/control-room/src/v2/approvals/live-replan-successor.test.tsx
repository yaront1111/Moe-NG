import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createHash } from "node:crypto";
import { admitByWireProtocol } from "@moe/control-room-client";
import type { RuntimeCommandEnvelope } from "@moe/contracts";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { LiveSetup } from "../../live/live-config.js";
import type { RunsOutcome } from "../../live/live-runs.js";
import type { OfferOutcome } from "./offer-wire.js";
import type { ReplanPreparation } from "./replan-successor-port.js";
import { LiveNeedsYou } from "./live-needs-you.js";

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const SETUP = { client: { commands: {} }, headers: {}, ok: true, projectId: "project",
  projection: "moe.board", sessionCredential: "test-session", subscriberId: "control-room-1", transport: {} } as unknown as LiveSetup;
const OFFER = { commandEnvelopeVersion: "moe-runtime-command/1", commandId: "replan-v4", commandKind: "escalation.decide",
  expectedVersion: 4, inputSchemaVersion: "moe-review-command/1", targetAggregateId: "node-own" };
const RUNS: RunsOutcome = { status: "RUNS", goals: [{ goalId: "goal-own", lifecycle: "EXECUTION_ENABLED", title: "Own",
  publish: null, run: { approval: "BOUND", lifecycle: "ACTIVATED", reviewable: false, runId: "run-own" }, nodes: [{
    accepted: null, claim: null, criterionIds: [], declaredMigrations: null, dependsOn: [], landing: null, lastActivityAt: null,
    nodeKey: "api", nodeRef: "node-own", objective: "Implement API", receipt: null, sharedKey: false, status: "ESCALATION_REQUIRED",
    review: { escalated: false, findings: [], latestRoute: "ESCALATE", rounds: 3, unreadable: false, unsuccessfulRounds: 3, version: 4 },
  }] }], totals: { ACCEPTED: 0, BLOCKED: 0, DELIVERED: 0, ESCALATED: 0, ESCALATION_REQUIRED: 1,
    IN_PROGRESS: 0, READY: 0, REPLANNED: 0, UNATTRIBUTABLE: 0, goals: 1, nodes: 1 } };
const PREPARED = { draft: { acceptanceCriteria: [], budgetEnvelope: "", outcome: "Exact review context", title: "Own · replan" } };
const REFUSAL: OfferOutcome = { ok: false, code: "EXACT_SOURCE_UNAVAILABLE", layer: "CONTROL_ROOM_REPLAN" };

function fixture() {
  vi.useFakeTimers();
  let offered = true;
  vi.stubGlobal("fetch", vi.fn(async (path: string): Promise<Response> => {
    if (path === "/affordances/read") return { status: 200, json: async () => ({ outcome: "SURFACE", steps: [],
      nextAllowedCommands: offered ? [OFFER] : [], planningGoalRefs: {} }) } as Response;
    if (path === "/goals/read") return { status: 200, json: async () => ({ outcome: "GOALS", nextCursor: null,
      goals: [{ brief: { instructions: "PRD", title: "Own" }, goalId: "goal-own", planningRunRef: "run-own", truthClass: "DAEMON_VERIFIED" }] }) } as Response;
    throw new Error("unexpected route");
  }));
  const order: string[] = [];
  const prepare = vi.fn(async (): Promise<ReplanPreparation> => { order.push("prepare"); return { ok: true, prepared: PREPARED }; });
  const submit = vi.fn(async () => { order.push("REPLAN"); offered = false; return { ok: true as const, commandId: "replan-v4" }; });
  const createPrepared = vi.fn(async (): Promise<OfferOutcome> => { order.push("create"); return { ok: true, commandId: "successor" }; });
  const props = { escalationPort: { submit }, onOpenBoard: vi.fn(), readRuns: async () => RUNS,
    setup: SETUP, successorPort: { prepare, createPrepared } };
  return { createPrepared, order, prepare, props, submit };
}
async function settle(): Promise<void> { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }

describe("live replan successor sequencing", () => {
  it("restores a lost retirement through the actual live callback and public read decoders after remount", async () => {
    const source = { byteLength: 5, contentSha256: createHash("sha256").update("# PRD").digest("hex"),
      displayPath: "PRD.md", mediaType: "text/markdown", outcome: "GOAL_SOURCE", sourceRef: "source-own", text: "# PRD" };
    const createOffer = { commandEnvelopeVersion: "moe-runtime-command/1", commandId: "captured-create",
      commandKind: "goal.create_with_source", expectedVersion: 0, inputSchemaVersion: "moe-goal-create-with-source/1", targetAggregateId: "create-target" };
    let retired = false;
    const sent: RuntimeCommandEnvelope[] = [];
    const fetcher = vi.fn(async (path: string): Promise<Response> => {
      if (path === "/affordances/read") return new Response(JSON.stringify({ outcome: "SURFACE", steps: [],
        nextAllowedCommands: retired ? [createOffer] : [OFFER, createOffer], planningGoalRefs: {} }));
      if (path === "/goals/read") return new Response(JSON.stringify({ outcome: "GOALS", nextCursor: null,
        goals: [{ brief: { instructions: "PRD", title: "Own" }, goalId: "goal-own", planningRunRef: "run-own", truthClass: "DAEMON_VERIFIED",
          binding: { byteLength: 5, contentSha256: source.contentSha256, sourceAggregateId: "source-own", sourceRef: "source-own" } }] }));
      if (path === "/goals/source/read") return new Response(JSON.stringify(source));
      if (path === "/runs/read" && RUNS.status === "RUNS") return new Response(JSON.stringify({ outcome: "RUNS", totals: RUNS.totals,
        goals: RUNS.goals.map((goal) => ({ ...goal, deployments: [], nodes: goal.nodes.map((node) => ({ ...node,
          status: retired ? "REPLANNED" : node.status, review: { ...node.review, escalated: retired, version: retired ? 5 : 4 } })) })) }));
      throw new Error("unrelated read unavailable");
    });
    vi.stubGlobal("fetch", fetcher);
    const gate = admitByWireProtocol("moe-runtime-command/1+moe-runtime-query/1+moe-runtime-error-registry/1");
    if (!gate.ok) throw new Error("fixture");
    const sendCommand = vi.fn(async (envelope: RuntimeCommandEnvelope) => {
      sent.push(envelope);
      if (envelope.commandKind === "escalation.decide") { retired = true; throw new Error("reply lost after commit"); }
      return { delivered: true as const, status: 200, response: { ok: true, decision: { commandId: envelope.commandId,
        disposition: "DECIDED", resultCode: "EFFECTS_COMMITTED", effectId: "effect" } } };
    });
    const setup = { ...SETUP, client: gate.client, transport: { sendCommand } } as unknown as LiveSetup;
    const view = render(<LiveNeedsYou setup={setup} onOpenBoard={vi.fn()} />);
    await waitFor(() => expect((screen.getByTestId("cr.needsyou.replan.node-own") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("cr.needsyou.replan.node-own"));
    await waitFor(() => expect(screen.getByText("Replan outcome needs checking")).toBeTruthy());
    await waitFor(() => expect((screen.getByTestId("cr.needsyou.replan.node-own") as HTMLButtonElement).disabled).toBe(false));
    expect(sent).toHaveLength(1); view.unmount();
    render(<LiveNeedsYou setup={{ ...setup, sessionCredential: "rotated-session" }} onOpenBoard={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("cr.needsyou.replan.node-own").textContent).toBe("Resume replacement creation"));
    expect(sent).toHaveLength(1);
    fireEvent.click(screen.getByTestId("cr.needsyou.replan.node-own"));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({ commandId: "captured-create", commandKind: "goal.create_with_source", sessionCredential: "rotated-session" });
    await waitFor(() => expect(sessionStorage.length).toBe(0));
    expect(fetcher.mock.calls.some(([path]) => path === "/runs/read")).toBe(true);
  });

  it("retains an uncertain retirement after the daemon removes its old offer", async () => {
    const f = fixture();
    f.submit.mockImplementation(async () => { throw new Error("response lost after commit"); });
    render(<LiveNeedsYou {...f.props} />); await settle();
    await act(async () => { fireEvent.click(screen.getByTestId("cr.needsyou.replan.node-own")); });
    expect(screen.getByText("Replan outcome needs checking")).toBeTruthy();
    expect(screen.getByTestId("cr.needsyou.replan.node-own").textContent).toBe("Resume replacement creation");
    expect((screen.getByTestId("cr.needsyou.escalate.node-own") as HTMLButtonElement).disabled).toBe(true);
    expect(f.createPrepared).not.toHaveBeenCalled();
  });

  it("prepares before committing the retirement decision", async () => {
    const f = fixture(); render(<LiveNeedsYou {...f.props} />); await settle();
    await act(async () => { fireEvent.click(screen.getByTestId("cr.needsyou.replan.node-own")); });
    expect(f.order).toEqual(["prepare", "REPLAN", "create"]);
    expect(f.createPrepared).toHaveBeenCalledWith(PREPARED);
  });

  it("keeps the original actions when preflight refuses without spending REPLAN", async () => {
    const f = fixture(); f.prepare.mockImplementation(async () => ({ ok: false, code: "EXACT_SOURCE_UNAVAILABLE", layer: "CONTROL_ROOM_REPLAN" }));
    render(<LiveNeedsYou {...f.props} />); await settle();
    await act(async () => { fireEvent.click(screen.getByTestId("cr.needsyou.replan.node-own")); });
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.createPrepared).not.toHaveBeenCalled();
    expect(screen.getByTestId("cr.needsyou.result.node-own").textContent).toContain("EXACT_SOURCE_UNAVAILABLE");
    expect((screen.getByTestId("cr.needsyou.escalate.node-own") as HTMLButtonElement).disabled).toBe(false);
  });

  it("retains a failed successor after the old offer disappears and retries creation only", async () => {
    const f = fixture(); f.createPrepared.mockResolvedValueOnce({ ok: false, code: "<script>late-refusal</script>", layer: "DAEMON" });
    const counted = vi.fn(); render(<LiveNeedsYou {...f.props} onCount={counted} />); await settle();
    await act(async () => { fireEvent.click(screen.getByTestId("cr.needsyou.replan.node-own")); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    const retry = screen.getByTestId("cr.needsyou.replan.node-own") as HTMLButtonElement;
    expect(retry.textContent).toBe("Retry creating successor");
    expect(screen.getByTestId("cr.needsyou.result.node-own").textContent).toContain("<script>late-refusal</script>");
    expect(document.querySelector("script")).toBeNull();
    expect((screen.getByTestId("cr.needsyou.escalate.node-own") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId("cr.needsyou.empty")).toBeNull();
    expect(counted).toHaveBeenLastCalledWith(1);
    await act(async () => { fireEvent.click(retry); });
    expect(f.submit).toHaveBeenCalledTimes(1);
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.createPrepared).toHaveBeenCalledTimes(2);
    expect(f.createPrepared.mock.calls[0]).toEqual(f.createPrepared.mock.calls[1]);
  });

  it("coalesces repeated clicks while preparation and successor retry are in flight", async () => {
    const f = fixture();
    let finishPrepare!: (value: ReplanPreparation) => void;
    f.prepare.mockImplementation(() => new Promise((resolve) => { finishPrepare = resolve; }));
    f.createPrepared.mockResolvedValueOnce(REFUSAL);
    render(<LiveNeedsYou {...f.props} />); await settle();
    const replan = screen.getByTestId("cr.needsyou.replan.node-own");
    await act(async () => { fireEvent.click(replan); fireEvent.click(replan); });
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.submit).not.toHaveBeenCalled();
    await act(async () => { finishPrepare({ ok: true, prepared: PREPARED }); });
    let finishCreate!: (value: OfferOutcome) => void;
    f.createPrepared.mockImplementationOnce(() => new Promise((resolve) => { finishCreate = resolve; }));
    await act(async () => { fireEvent.click(replan); fireEvent.click(replan); });
    expect(f.submit).toHaveBeenCalledTimes(1);
    expect(f.createPrepared).toHaveBeenCalledTimes(2);
    await act(async () => { finishCreate({ ok: true, commandId: "successor" }); });
  });

  it("does not retire the node when the UI unmounts during preflight", async () => {
    const f = fixture(); let finish!: (value: ReplanPreparation) => void;
    f.prepare.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(<LiveNeedsYou {...f.props} />); await settle();
    await act(async () => { fireEvent.click(screen.getByTestId("cr.needsyou.replan.node-own")); });
    view.unmount();
    await act(async () => { finish({ ok: true, prepared: PREPARED }); });
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.createPrepared).not.toHaveBeenCalled();
  });
});
