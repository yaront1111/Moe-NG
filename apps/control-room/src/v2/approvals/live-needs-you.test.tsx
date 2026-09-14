import { admitByWireProtocol, createControlRoomTransport } from "@moe/control-room-client";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { LiveSetup } from "../../live/live-config.js";
import type { DocumentCoverageOutcome } from "../../live/live-document-coverage.js";
import type { PreviewReadOutcome } from "../../live/live-preview.js";
import type { RunsOutcome } from "../../live/live-runs.js";
import { LiveNeedsYou } from "./live-needs-you.js";

/**
 * The live queue over a stubbed wire: the affordance surface and the goal catalog answer
 * over fetch, coverage through the injected reader. The arm proves each source lands as a
 * card and that the count handed to the shell equals the cards on screen.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const SETUP = {
  client: { commands: {} }, headers: { authorization: "Bearer live" }, ok: true,
  projectId: "project-live-1", projection: "moe.board", sessionCredential: "cred-live-1",
  subscriberId: "control-room-1", transport: { sendCommand: vi.fn() },
} as unknown as LiveSetup;

const CATALOG = {
  goals: [
    { brief: { instructions: "i", title: "Plan me" }, goalId: "goal-plan", planningRunRef: "run-plan", truthClass: "DAEMON_VERIFIED" },
    { brief: { instructions: "i", title: "Gate me" }, goalId: "goal-gate", planningRunRef: "run-gate", truthClass: "DAEMON_VERIFIED" },
  ],
  nextCursor: null, outcome: "GOALS",
};
const SURFACE = {
  nextAllowedCommands: [{
    commandEnvelopeVersion: "moe-runtime-command/1", commandId: "cmd-approve-plan",
    commandKind: "approval.decide_intent", expectedVersion: 3,
    inputSchemaVersion: "moe-bootstrap-command/1", targetAggregateId: "run-plan",
  }],
  outcome: "SURFACE", planningGoalRefs: { "run-plan": "goal-plan" }, steps: [],
};

function stubWire(): void {
  vi.stubGlobal("fetch", vi.fn(async (path: string): Promise<Response> => {
    if (path === "/affordances/read") return { json: async () => SURFACE, status: 200 } as unknown as Response;
    if (path === "/goals/read") return { json: async () => CATALOG, status: 200 } as unknown as Response;
    throw new Error(`unexpected fetch path ${path}`);
  }));
}

/** What `/preview/read` answers in `receiptId`: a 64-hex digest, never `preview:<goalId>`. */
const RECEIPT_ID = "7c3e91a5d0b84f27ae60d5182b3c94f7a15e8d602c7b93481fa0e65d3c827b19";

const gatePending: DocumentCoverageOutcome = {
  contracts: [{ contractId: "contract-gate", gate1: "PENDING", plane: "V1", requirements: [], revisionDigest: "d".repeat(64), revisionId: "rev-1" }],
  document: { byteLength: 1, contentSha256: "b".repeat(64), displayPath: "PRD.md" },
  goals: [{ goalId: "goal-gate", lastActivityAt: null, lifecycle: "DRAFT", planningRunRef: "run-gate", title: "Gate me" }],
  sections: null, status: "COVERAGE",
  totals: { contracts: 1, criteria: 0, goals: 1, planned: 0, requirements: 0, unattributable: 0, verified: 0 },
};

describe("LiveNeedsYou", () => {
  it("keeps a late approval response attached to the earlier review version", async () => {
    vi.useFakeTimers();
    let version: number | null = 5;
    const offer = (current: number) => ({ commandEnvelopeVersion: "moe-runtime-command/1", commandId: `cmd-${current}`,
      commandKind: "escalation.decide", expectedVersion: current, inputSchemaVersion: "moe-review-escalation-guidance/1", targetAggregateId: "node-x" });
    vi.stubGlobal("fetch", vi.fn(async (path: string): Promise<Response> => {
      if (path === "/affordances/read") return { json: async () => ({ ...SURFACE, nextAllowedCommands: version === null ? [] : [offer(version)] }), status: 200 } as Response;
      if (path === "/goals/read") return { json: async () => CATALOG, status: 200 } as Response;
      throw new Error(`unexpected fetch path ${path}`);
    }));
    const readRuns = async (): Promise<RunsOutcome> => ({ status: "RUNS", goals: [{ goalId: "goal-plan", lifecycle: "EXECUTION_ENABLED", nodes: [{
      accepted: null, claim: null, criterionIds: [], declaredMigrations: null, dependsOn: [], lastActivityAt: null,
      nodeKey: "node-x", nodeRef: "node-x", objective: "o", landing: null, receipt: null,
      review: { escalated: false, findings: [{ detail: `Question for version ${version}`, ruleId: "question", severity: "MAJOR", subject: "NODE node-x", round: 4 }],
        latestRoute: "ESCALATE", rounds: 4, unreadable: false, unsuccessfulRounds: 4, version: version ?? 5 },
      sharedKey: false, status: "ESCALATION_REQUIRED" }], publish: null,
      run: { approval: "BOUND", lifecycle: "ACTIVATED", reviewable: false, runId: "run-plan" }, title: "Plan me" }],
      totals: { ACCEPTED: 0, BLOCKED: 0, DELIVERED: 0, ESCALATED: 0, ESCALATION_REQUIRED: 1, IN_PROGRESS: 0,
        READY: 0, REPLANNED: 0, UNATTRIBUTABLE: 0, goals: 1, nodes: 1 } });
    let resolveOld!: (value: { ok: true; commandId: string }) => void;
    const oldResponse = new Promise<{ ok: true; commandId: string }>((resolve) => { resolveOld = resolve; });
    const submit = vi.fn().mockImplementationOnce(() => oldResponse).mockResolvedValue({ ok: true, commandId: "cmd-7" });
    render(<LiveNeedsYou escalationPort={{ submit }} onOpenBoard={vi.fn()} readRuns={readRuns} setup={SETUP} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Guidance for review 5" } });
    await act(async () => { screen.getByTestId("cr.needsyou.escalate.node-x").click(); });
    expect(submit).toHaveBeenLastCalledWith(offer(5), "node-x", "ALLOW_MORE_ATTEMPTS", "Guidance for review 5");
    version = null;
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(screen.queryByTestId("cr.needsyou.escalate.node-x")).toBeNull();
    version = 7;
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "New answer for review 7" } });
    await act(async () => { resolveOld({ ok: true, commandId: "cmd-5" }); });
    const button = screen.getByTestId("cr.needsyou.escalate.node-x") as HTMLButtonElement;
    expect(button.disabled).toBe(false); expect(button.textContent).toBe("Retry with guidance");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("New answer for review 7");
    expect(screen.getByText("Question for version 7")).toBeTruthy();
    expect(screen.queryByText("Question for version 5")).toBeNull();
    await act(async () => { button.click(); });
    expect(submit).toHaveBeenLastCalledWith(offer(7), "node-x", "ALLOW_MORE_ATTEMPTS", "New answer for review 7");
  });

  it("carries entered guidance through the live callback, real port, generated builder and transport", async () => {
    const offered = { commandEnvelopeVersion: "moe-runtime-command/1", commandId: "cmd-guided-4", commandKind: "escalation.decide",
      expectedVersion: 4, inputSchemaVersion: "moe-review-escalation-guidance/1", targetAggregateId: "execution-exact" };
    vi.stubGlobal("fetch", vi.fn(async (path: string): Promise<Response> => {
      if (path === "/affordances/read") return new Response(JSON.stringify({ ...SURFACE, nextAllowedCommands: [offered] }));
      if (path === "/goals/read") return new Response(JSON.stringify(CATALOG));
      throw new Error(`unexpected fetch path ${path}`);
    }));
    const gate = admitByWireProtocol("moe-runtime-command/1+moe-runtime-query/1+moe-runtime-error-registry/1");
    if (!gate.ok) throw new Error("TEST_COMPAT_GATE_REFUSED");
    const requests: { path: string; body: Record<string, unknown> }[] = [];
    const setup: LiveSetup = { ...SETUP, client: gate.client, transport: createControlRoomTransport({
      csrfToken: "private-test-csrf", origin: "", sessionCredential: SETUP.sessionCredential,
      wireProtocolVersion: gate.client.wireProtocolVersion, fetch: async (path, init) => {
        requests.push({ path, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return requests.length === 1
          ? new Response(JSON.stringify({ ok: false, refusal: { code: "VERSION_STALE", layer: "DAEMON" } }), { status: 409 })
          : new Response(JSON.stringify({ ok: true }));
      },
    }) };
    const readRuns = async (): Promise<RunsOutcome> => ({ status: "RUNS", goals: [{ goalId: "goal-plan", lifecycle: "EXECUTION_ENABLED", nodes: [{
      accepted: null, claim: null, criterionIds: [], declaredMigrations: null, dependsOn: [], lastActivityAt: null,
      nodeKey: "node-x", nodeRef: "execution-exact", objective: "o", landing: null, receipt: null,
      review: { escalated: false, findings: [], latestRoute: "ESCALATE", rounds: 3, unreadable: false, unsuccessfulRounds: 3, version: 4 },
      sharedKey: false, status: "ESCALATION_REQUIRED" }], publish: null,
      run: { approval: "BOUND", lifecycle: "ACTIVATED", reviewable: false, runId: "run-plan" }, title: "Plan me" }],
      totals: { ACCEPTED: 0, BLOCKED: 0, DELIVERED: 0, ESCALATED: 0, ESCALATION_REQUIRED: 1, IN_PROGRESS: 0,
        READY: 0, REPLANNED: 0, UNATTRIBUTABLE: 0, goals: 1, nodes: 1 } });
    render(<LiveNeedsYou onOpenBoard={vi.fn()} readRuns={readRuns} setup={setup} />);
    const field = await screen.findByRole("textbox", { name: "Answers or instructions for the next attempt (optional)" }) as HTMLTextAreaElement;
    const guidance = "  Session cookies; retain every check.\n<img src=x onerror='fail()'>  ";
    fireEvent.change(field, { target: { value: guidance } });
    fireEvent.click(screen.getByRole("button", { name: "Retry with guidance on node-x" }));
    await waitFor(() => { expect(screen.getByTestId("cr.needsyou.result.execution-exact").textContent).toContain("VERSION_STALE"); });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe("/command");
    expect(requests[0]?.body).toMatchObject({ commandId: offered.commandId, commandKind: "escalation.decide",
      expectedVersion: 4, targetAggregateId: "execution-exact", payload: { decision: "ALLOW_MORE_ATTEMPTS",
        escalationRef: "ui-escalation-execution-exact-v4", subjectRef: "execution-exact", implementationGuidance: guidance } });
    expect(field.value).toBe(guidance); expect(document.querySelector("img")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry with guidance on node-x" }));
    await screen.findByText("Guidance recorded. One more attempt is approved for this node.");
    expect(requests).toHaveLength(2);
    expect(requests[1]?.body["payload"]).toEqual(requests[0]?.body["payload"]);
  });
  it("lists the offered plan approval and the pending contract, and reports the count", async () => {
    stubWire();
    const onCount = vi.fn();
    const readCoverage = vi.fn(async (goalId: string): Promise<DocumentCoverageOutcome> =>
      goalId === "goal-gate" ? gatePending
        : { code: "DOCUMENT_COVERAGE_READ_GOAL_UNBOUND", layer: "DOCUMENT_COVERAGE_READ", status: "REFUSED" });
    render(<LiveNeedsYou onCount={onCount} onOpenBoard={vi.fn()} readCoverage={readCoverage} setup={SETUP} />);
    await waitFor(() => {
      expect(screen.getByTestId("cr.needsyou.item.plan-approval.goal-plan")).toBeTruthy();
      expect(screen.getByTestId("cr.needsyou.item.gate-1.goal-gate")).toBeTruthy();
    });
    expect(screen.getByTestId("cr.needsyou.count").textContent).toBe("2 decisions need you");
    // The badge count is a passive effect of the 2-item render: it lands after the DOM does.
    await waitFor(() => { expect(onCount).toHaveBeenLastCalledWith(2); });
    expect(readCoverage).toHaveBeenCalledWith("goal-plan");
    expect(readCoverage).toHaveBeenCalledWith("goal-gate");
  });

  it("spends the daemon's escalation offer through the port and shows the answer", async () => {
    stubWire();
    const offer = {
      commandEnvelopeVersion: "moe-runtime-command/1", commandId: "cmd-esc", commandKind: "escalation.decide",
      expectedVersion: 4, inputSchemaVersion: "moe-review-command/1", targetAggregateId: "node-x",
    };
    vi.stubGlobal("fetch", vi.fn(async (path: string): Promise<Response> => {
      if (path === "/affordances/read") return { json: async () => ({ ...SURFACE, nextAllowedCommands: [offer] }), status: 200 } as unknown as Response;
      if (path === "/goals/read") return { json: async () => CATALOG, status: 200 } as unknown as Response;
      throw new Error(`unexpected fetch path ${path}`);
    }));
    const runs: RunsOutcome = {
      goals: [{ goalId: "goal-plan", lifecycle: "EXECUTION_ENABLED", nodes: [{
        accepted: null, claim: null, criterionIds: [], declaredMigrations: null, dependsOn: [], lastActivityAt: null, nodeKey: "node-x", nodeRef: "node-x", objective: "o",
        landing: null, receipt: null, review: { escalated: false, findings: [], latestRoute: "REJECT_PLAN", rounds: 3, unreadable: false, unsuccessfulRounds: 3, version: 4 }, sharedKey: false,
        status: "ESCALATION_REQUIRED" }], publish: null, run: { approval: "BOUND", lifecycle: "ACTIVATED", reviewable: false, runId: "run-plan" }, title: "Plan me" }],
      status: "RUNS",
      totals: { ACCEPTED: 0, BLOCKED: 0, DELIVERED: 0, ESCALATED: 0, ESCALATION_REQUIRED: 1, IN_PROGRESS: 0, READY: 0, REPLANNED: 0, UNATTRIBUTABLE: 0, goals: 1, nodes: 1 },
    };
    const submit = vi.fn(async () => ({ commandId: "cmd-esc", ok: true as const }));
    render(<LiveNeedsYou escalationPort={{ submit }} onOpenBoard={vi.fn()} readRuns={async () => runs} setup={SETUP} />);
    const button = await screen.findByTestId("cr.needsyou.escalate.node-x");
    expect(screen.getByTestId("cr.needsyou.item.escalation.node-x").textContent).toContain("Plan me");
    button.click();
    await waitFor(() => { expect(screen.getByTestId("cr.needsyou.result.node-x").textContent).toContain("Allowed."); });
    expect(submit).toHaveBeenCalledWith(offer, "node-x", "ALLOW_MORE_ATTEMPTS");
  });

  it("replans through the escalation port, then mints the successor goal, and says so", async () => {
    stubWire();
    const offer = {
      commandEnvelopeVersion: "moe-runtime-command/1", commandId: "cmd-esc", commandKind: "escalation.decide",
      expectedVersion: 4, inputSchemaVersion: "moe-review-command/1", targetAggregateId: "node-x",
    };
    vi.stubGlobal("fetch", vi.fn(async (path: string): Promise<Response> => {
      if (path === "/affordances/read") return { json: async () => ({ ...SURFACE, nextAllowedCommands: [offer] }), status: 200 } as unknown as Response;
      if (path === "/goals/read") return { json: async () => CATALOG, status: 200 } as unknown as Response;
      throw new Error(`unexpected fetch path ${path}`);
    }));
    const runs: RunsOutcome = {
      goals: [{ goalId: "goal-plan", lifecycle: "EXECUTION_ENABLED", nodes: [{
        accepted: null, claim: null, criterionIds: [], declaredMigrations: null, dependsOn: [], lastActivityAt: null, nodeKey: "node-x", nodeRef: "node-x", objective: "o",
        landing: null, receipt: null, review: { escalated: false, findings: [], latestRoute: "REJECT_PLAN", rounds: 3, unreadable: false, unsuccessfulRounds: 3, version: 4 }, sharedKey: false,
        status: "ESCALATION_REQUIRED" }], publish: null, run: { approval: "BOUND", lifecycle: "ACTIVATED", reviewable: false, runId: "run-plan" }, title: "Plan me" }],
      status: "RUNS",
      totals: { ACCEPTED: 0, BLOCKED: 0, DELIVERED: 0, ESCALATED: 0, ESCALATION_REQUIRED: 1, IN_PROGRESS: 0, READY: 0, REPLANNED: 0, UNATTRIBUTABLE: 0, goals: 1, nodes: 1 },
    };
    const submit = vi.fn(async () => ({ commandId: "cmd-esc", ok: true as const }));
    const prepared = { draft: { acceptanceCriteria: [], budgetEnvelope: "", outcome: "Exact context", title: "Successor" } };
    const prepare = vi.fn(async () => ({ ok: true as const, prepared }));
    const createPrepared = vi.fn(async () => ({ commandId: "cmd-successor", ok: true as const }));
    render(<LiveNeedsYou escalationPort={{ submit }} onOpenBoard={vi.fn()} readRuns={async () => runs} setup={SETUP} successorPort={{ prepare, createPrepared }} />);
    const button = await screen.findByTestId("cr.needsyou.replan.node-x");
    button.click();
    await waitFor(() => { expect(screen.getByTestId("cr.needsyou.result.node-x").textContent).toContain("Replanned."); });
    expect(submit).toHaveBeenCalledWith(offer, "node-x", "REPLAN");
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ goalId: "goal-plan", kind: "ESCALATION" }), runs);
    expect(createPrepared).toHaveBeenCalledTimes(1);
    expect(createPrepared).toHaveBeenCalledWith(prepared);
  });

  it("closes a goal through the close port when the daemon offers goal.close", async () => {
    const offer = {
      commandEnvelopeVersion: "moe-runtime-command/1", commandId: "cmd-close", commandKind: "goal.close",
      expectedVersion: 7, inputSchemaVersion: "moe-bootstrap-command/1", targetAggregateId: "goal-gate",
    };
    vi.stubGlobal("fetch", vi.fn(async (path: string): Promise<Response> => {
      if (path === "/affordances/read") return { json: async () => ({ ...SURFACE, nextAllowedCommands: [offer] }), status: 200 } as unknown as Response;
      if (path === "/goals/read") return { json: async () => CATALOG, status: 200 } as unknown as Response;
      throw new Error(`unexpected fetch path ${path}`);
    }));
    const verified: DocumentCoverageOutcome = {
      ...gatePending,
      contracts: [{ ...gatePending.contracts[0]!, gate1: "APPROVED", plane: "V1", requirements: [{ criteria: [{ criterionId: "c", nodeKey: "n", nodeTestStatus: null, statement: "s", status: "VERIFIED" }], requirementId: "r", statement: "r" }] }],
      goals: [{ goalId: "goal-gate", lastActivityAt: null, lifecycle: "EXECUTION_ENABLED", planningRunRef: "run-gate", title: "Gate me" }],
      totals: { contracts: 1, criteria: 1, goals: 1, planned: 0, requirements: 1, unattributable: 0, verified: 1 },
    };
    const submit = vi.fn(async () => ({ commandId: "cmd-close", ok: true as const }));
    render(<LiveNeedsYou closePort={{ submit }} onOpenBoard={vi.fn()} readCoverage={async () => verified} readRuns={async () => ({ code: "x", layer: "y", status: "ERROR" })} setup={SETUP} />);
    const button = await screen.findByTestId("cr.needsyou.close.goal-gate");
    button.click();
    await waitFor(() => { expect(screen.getByTestId("cr.needsyou.close.goal-gate").textContent).toBe("Confirm: close the goal"); });
    screen.getByTestId("cr.needsyou.close.goal-gate").click();
    await waitFor(() => { expect(screen.getByTestId("cr.needsyou.result.goal-gate").textContent).toContain("Closed."); });
    expect(submit).toHaveBeenCalledWith(offer, "goal-gate");
  });

  it("sends the RECEIPT id /preview/read answered, never the offer's aggregate id", async () => {
    // DoD 2. The defect was a composition omission: `facts.receiptId` sat beside the call and
    // was not passed, so the port derived `previewRef` from the affordance's targetAggregateId
    // — the preview AGGREGATE — and the daemon answered 422 PREVIEW_GOAL_NOT_LANDED @
    // GOAL_AUTHORITY. This arm asserts the VALUE that reached the port. A spy that only counted
    // the call could not tell a receipt id from an aggregate id, which is the same blindness
    // the port's own fixture had while both its strings were one string.
    const offer = {
      commandEnvelopeVersion: "moe-runtime-command/1", commandId: "cmd-preview", commandKind: "preview.decide",
      expectedVersion: 2, inputSchemaVersion: "moe-preview-command/1", targetAggregateId: "preview:goal-plan",
    };
    vi.stubGlobal("fetch", vi.fn(async (path: string): Promise<Response> => {
      if (path === "/affordances/read") return { json: async () => ({ ...SURFACE, nextAllowedCommands: [offer] }), status: 200 } as unknown as Response;
      if (path === "/goals/read") return { json: async () => CATALOG, status: 200 } as unknown as Response;
      throw new Error(`unexpected fetch path ${path}`);
    }));
    const readPreview = vi.fn(async (): Promise<PreviewReadOutcome> => ({
      preview: {
        code: null, decidedAt: "2026-09-09T12:00:00.000Z", goalId: "goal-plan", outcome: "STARTED",
        receiptId: RECEIPT_ID, screenshots: [], sha: "c".repeat(64), url: "http://127.0.0.1:4173",
      },
      status: "PREVIEW",
    }));
    const submit = vi.fn(async () => ({ commandId: "cmd-preview", ok: true as const }));

    render(<LiveNeedsYou onOpenBoard={vi.fn()} previewPort={{ submit }} readPreview={readPreview} setup={SETUP} />);
    (await screen.findByTestId("cr.needsyou.preview.approve")).click();

    await waitFor(() => { expect(submit).toHaveBeenCalledTimes(1); });
    // The id is asserted against RECEIPT_ID and the aggregate id is asserted absent, so this
    // cannot pass again if a later edit reintroduces the derivation.
    expect(submit).toHaveBeenCalledWith(offer, RECEIPT_ID, "APPROVE", []);
    expect(submit).not.toHaveBeenCalledWith(offer, "preview:goal-plan", "APPROVE", []);
  });

  it("shows an honest empty queue without a coverage reader", async () => {
    stubWire();
    render(<LiveNeedsYou onOpenBoard={vi.fn()} setup={SETUP} />);
    await screen.findByTestId("cr.needsyou.item.plan-approval.goal-plan");
    expect(screen.queryByTestId("cr.needsyou.item.gate-1.goal-gate")).toBeNull();
    expect(screen.getByTestId("cr.needsyou.count").textContent).toBe("1 decision needs you");
  });
});
