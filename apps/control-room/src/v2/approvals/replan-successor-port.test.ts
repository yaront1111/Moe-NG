import { createHash } from "node:crypto";
import { GOAL_BRIEF_LIMITS } from "@moe/contracts";
import { describe, expect, it, vi } from "vitest";
import type { LiveSetup } from "../../live/live-config.js";
import type { SurfaceFrame } from "../../live/live-board-feed.js";
import { briefOfDraft } from "../goals/live-goal-create.js";
import type { GoalDraft } from "../goals/goal-model.js";
import type { RunNodeView, RunsOutcome } from "../../live/live-runs.js";
import type { NeedsYouItem } from "./needs-you-model.js";
import { createReplanSuccessorPort, replanInstructions } from "./replan-successor-port.js";

const SOURCE = { status: "GOAL_SOURCE" as const, text: "# PRD", byteLength: 5,
  contentSha256: createHash("sha256").update("# PRD").digest("hex"), displayPath: "PRD.md", mediaType: "text/markdown", sourceRef: "source-own" };
const CREATE_OFFER = { commandEnvelopeVersion: "moe-runtime-command/1", commandId: "create-successor",
  commandKind: "goal.create_with_source", expectedVersion: 0, inputSchemaVersion: "moe-goal-create-with-source/1", targetAggregateId: "successor" };
const FRAME: SurfaceFrame = { connection: "CONNECTED", detail: "", offers: [CREATE_OFFER], outcome: "SURFACE", steps: [] };
const SETUP = { sessionCredential: "test-session", headers: {}, transport: { sendCommand: vi.fn() } } as unknown as LiveSetup;

function portFixture() {
  const dispatch = vi.fn(async (_draft: GoalDraft) => ({ ok: true, commandId: "created", report: "Created" }));
  const readSource = vi.fn(async () => SOURCE);
  return { dispatch, readSource, port: createReplanSuccessorPort(SETUP, () => FRAME, { dispatch, readSource }) };
}

const node = (nodeRef: string, detail: string): RunNodeView => ({
  accepted: null, claim: null, criterionIds: [], declaredMigrations: null, dependsOn: [], landing: null, lastActivityAt: null,
  nodeKey: "api", nodeRef, objective: "Implement API", receipt: null,
  review: { escalated: true, findings: [{ detail, round: 3, ruleId: "check", severity: "MAJOR", subject: "API" }],
    latestRoute: "REJECT_PLAN", rounds: 3, unreadable: false, unsuccessfulRounds: 3, version: 4 },
  sharedKey: false, status: "REPLANNED",
});

function ownContext(findings: RunNodeView["review"]["findings"]): { item: NeedsYouItem; runs: RunsOutcome } {
  const own = node("execution-own", "");
  return {
    item: {
      actionLabel: "Open", detail: "", escalation: { affordance: { targetAggregateId: "execution-own", expectedVersion: 4 },
        findings, findingsState: "CURRENT", latestRoute: "REJECT_PLAN", nodeKey: "api", unsuccessfulRounds: 3 },
      goalId: "goal-own", headline: "Replan", kind: "ESCALATION", planningRunRef: "run-own", title: "Own",
    },
    runs: { status: "RUNS", goals: [{ goalId: "goal-own", lifecycle: "EXECUTION_ENABLED",
      nodes: [{ ...own, review: { ...own.review, findings } }], publish: null,
      run: { approval: "BOUND", lifecycle: "ACTIVATED", reviewable: false, runId: "run-own" }, title: "Own" }],
    totals: { ACCEPTED: 0, BLOCKED: 0, DELIVERED: 0, ESCALATED: 0, ESCALATION_REQUIRED: 0,
      IN_PROGRESS: 0, READY: 0, REPLANNED: 1, UNATTRIBUTABLE: 0, goals: 1, nodes: 1 } },
  };
}

describe("replan scoped source", () => {
  it("prepares the exact pointer, literal diagnostics and source before any creation", async () => {
    const { item, runs } = ownContext([{ detail: "Do not omit registry-release", round: 3,
      ruleId: "dependency", severity: "MAJOR", subject: "NODE api" }]);
    const { port, dispatch, readSource } = portFixture();
    const result = await port.prepare(item, runs);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    expect(result.prepared.draft.outcome).toContain('Replan context: {"predecessorGoalId":"goal-own","nodeRef":"execution-own","reviewVersion":4}');
    expect(result.prepared.draft.outcome).toContain("may be incomplete");
    expect(result.prepared.draft.outcome).toContain("[MAJOR dependency; NODE api] Do not omit registry-release");
    expect(result.prepared.draft.prd?.text).toBe(SOURCE.text);
    expect(Object.isFrozen(result.prepared.draft)).toBe(true);
    expect(Object.isFrozen(result.prepared.draft.prd)).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
    Object.assign(item, { title: "Later unrelated title" });
    expect(await port.createPrepared(result.prepared)).toEqual({ ok: true, commandId: "created" });
    expect(dispatch).toHaveBeenCalledWith(result.prepared.draft);
    expect(dispatch.mock.calls[0]?.[0]?.title).toBe("Own · replan");
    expect(readSource).toHaveBeenCalledTimes(1);
    await port.createPrepared(result.prepared);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("admits the exact UTF-8 brief boundary including the appended PRD line", async () => {
    const empty = ownContext([{ detail: "", round: 3, ruleId: "bound", severity: "MAJOR", subject: "NODE api" }]);
    const f = portFixture();
    const first = await f.port.prepare(empty.item, empty.runs);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.code);
    const overhead = new TextEncoder().encode(briefOfDraft(first.prepared.draft).instructions).byteLength;
    const room = GOAL_BRIEF_LIMITS.maxInstructionsUtf8Bytes - overhead;
    const detail = "界".repeat(Math.floor(room / 3)) + "x".repeat(room % 3);
    const valid = ownContext([{ detail, round: 3, ruleId: "bound", severity: "MAJOR", subject: "NODE api" }]);
    const atLimit = await f.port.prepare(valid.item, valid.runs);
    expect(atLimit.ok).toBe(true);
    if (!atLimit.ok) throw new Error(atLimit.code);
    expect(new TextEncoder().encode(briefOfDraft(atLimit.prepared.draft).instructions).byteLength)
      .toBe(GOAL_BRIEF_LIMITS.maxInstructionsUtf8Bytes);
    const over = ownContext([{ detail: detail + "x", round: 3, ruleId: "bound", severity: "MAJOR", subject: "NODE api" }]);
    expect(await f.port.prepare(over.item, over.runs)).toEqual({ ok: false, code: "GOAL_BRIEF_INPUT_INVALID", layer: "GOAL_BRIEF_CONTRACT" });
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it("requires a buildable creation offer before the caller can retire the old node", async () => {
    const { item, runs } = ownContext([]);
    const dispatch = vi.fn();
    const absent = createReplanSuccessorPort(SETUP, () => ({ ...FRAME, offers: [] }), { dispatch, readSource: async () => SOURCE });
    expect(await absent.prepare(item, runs)).toMatchObject({ ok: false, layer: "CONTROL_ROOM_REPLAN" });
    const malformed = createReplanSuccessorPort(SETUP, () => ({ ...FRAME, offers: [{ ...CREATE_OFFER, expectedVersion: -1 }] }),
      { dispatch, readSource: async () => SOURCE });
    expect(await malformed.prepare(item, runs)).toMatchObject({ ok: false });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("reuses the exact goal command after an uncertain delivery even when the offered goal changes", async () => {
    let offer = CREATE_OFFER;
    const sent: { commandId: string; payload: unknown }[] = [];
    const sendCommand = vi.fn(async (envelope: { commandId: string; payload: unknown }) => {
      sent.push(envelope);
      return sent.length === 1 ? { delivered: false, code: "NETWORK_UNCERTAIN" } : { delivered: true,
        response: { ok: true, decision: { commandId: envelope.commandId, disposition: "REPLAYED", resultCode: "EFFECTS_COMMITTED", effectId: "effect" } } };
    });
    const setup = { ...SETUP, transport: { sendCommand } } as unknown as LiveSetup;
    const port = createReplanSuccessorPort(setup, () => ({ ...FRAME, offers: [offer] }), { readSource: async () => SOURCE });
    const { item, runs } = ownContext([]);
    const prepared = await port.prepare(item, runs);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(prepared.code);
    expect(await port.createPrepared(prepared.prepared)).toMatchObject({ ok: false });
    offer = { ...CREATE_OFFER, commandId: "different-create", targetAggregateId: "different-successor" };
    expect(await port.createPrepared(prepared.prepared)).toEqual({ ok: true, commandId: "create-successor" });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
  });

  it.each([null, { status: "ERROR" as const, code: "UNREADABLE", layer: "RUNS" }])("refuses absent or unreadable run data without a source read", async (runs) => {
    const { item } = ownContext([]), f = portFixture();
    expect(await f.port.prepare(item, runs)).toMatchObject({ ok: false, code: "REPLAN_CONTEXT_UNAVAILABLE" });
    expect(f.readSource).not.toHaveBeenCalled();
  });

  it.each(["source refused", "source throw", "wrong hash", "wrong byte count", "invalid source"])("stops before REPLAN on %s", async (fault) => {
    const { item, runs } = ownContext([]);
    const readSource = async () => {
      if (fault === "source refused") return { status: "REFUSED" as const, code: "SOURCE_NOT_AVAILABLE", layer: "GOAL_SOURCE" };
      if (fault === "source throw") throw new Error("private source error");
      return { ...SOURCE, ...(fault === "wrong hash" ? { contentSha256: "0".repeat(64) } : {}),
        ...(fault === "wrong byte count" ? { byteLength: 999 } : {}), ...(fault === "invalid source" ? { mediaType: "application/unknown" } : {}) };
    };
    const dispatch = vi.fn(), port = createReplanSuccessorPort(SETUP, () => FRAME, { dispatch, readSource });
    const outcome = await port.prepare(item, runs);
    expect(outcome.ok).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain("private source error");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects an oversized successor title instead of silently shortening it", async () => {
    const { item, runs } = ownContext([]), f = portFixture();
    expect(await f.port.prepare({ ...item, title: "x".repeat(GOAL_BRIEF_LIMITS.maxTitleUtf8Bytes) }, runs))
      .toEqual({ ok: false, code: "GOAL_BRIEF_INPUT_INVALID", layer: "GOAL_BRIEF_CONTRACT" });
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it("rejects an unprepared draft even if another port created it", async () => {
    const first = portFixture(), other = portFixture(), { item, runs } = ownContext([]);
    const result = await first.port.prepare(item, runs);
    if (!result.ok) throw new Error(result.code);
    expect(await other.port.createPrepared(result.prepared)).toEqual({ ok: false, code: "REPLAN_PREPARATION_INVALID", layer: "CONTROL_ROOM_REPLAN" });
    expect(other.dispatch).not.toHaveBeenCalled();
  });

  it.each(["unreadable", "missing", "stale", "missing run"])("refuses %s context before creating a successor", async (fault) => {
    const { item, runs } = ownContext([]);
    if (runs.status !== "RUNS") throw new Error("fixture");
    const goal = runs.goals[0]!;
    const own = goal.nodes[0]!;
    const changed: RunsOutcome = { ...runs, goals: [{ ...goal,
      run: fault === "missing run" ? null : goal.run,
      nodes: fault === "missing" ? [] : [{ ...own, review: { ...own.review,
        unreadable: fault === "unreadable", version: fault === "stale" ? 7 : own.review.version } }],
    }] };
    const { port, dispatch } = portFixture();
    expect(await port.prepare(item, changed)).toMatchObject({ ok: false, code: "REPLAN_CONTEXT_UNAVAILABLE" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each(["界".repeat(12_000), "x".repeat(33_000), "bad\ud800text"])("refuses unrepresentable complete context before creating a successor", async (detail) => {
    const { item, runs } = ownContext([{ detail, round: 3, ruleId: "complete-context", severity: "MAJOR", subject: "NODE api" }]);
    const { port, dispatch } = portFixture();
    expect(await port.prepare(item, runs)).toMatchObject({ ok: false });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("preserves a dependency correction after the former 600-character cutoff", () => {
    const detail = `${"界".repeat(599)}😀 Dependency correction: registry-release must precede runtime-validation.`;
    const { item, runs } = ownContext([{ detail, round: 3, ruleId: "dependency-order", severity: "MAJOR", subject: "NODE api" }]);
    const instructions = replanInstructions(item, runs);
    expect(instructions).toContain(detail);
    expect(instructions.isWellFormed()).toBe(true);
  });

  it("preserves the ninth finding rather than silently changing the requested replan", () => {
    const findings = Array.from({ length: 9 }, (_, index) => ({ detail: `Required correction ${index + 1}`,
      round: 3, ruleId: `rule-${index + 1}`, severity: "MAJOR", subject: `NODE subject-${index + 1}` }));
    const { item, runs } = ownContext(findings);
    const instructions = replanInstructions(item, runs);
    for (const finding of findings) expect(instructions).toContain(finding.detail);
  });

  it("carries only the exhausted execution's findings when goals reuse local node names", () => {
    const item: NeedsYouItem = {
      actionLabel: "Open", detail: "", escalation: { affordance: { targetAggregateId: "execution-own", expectedVersion: 4 },
        findings: [], findingsState: "CURRENT", latestRoute: "REJECT_PLAN", nodeKey: "api", unsuccessfulRounds: 3 },
      goalId: "goal-own", headline: "Replan", kind: "ESCALATION", planningRunRef: "run-own", title: "Own",
    };
    const runs: RunsOutcome = {
      status: "RUNS", goals: [
        { goalId: "goal-other", lifecycle: "EXECUTION_ENABLED", nodes: [node("execution-other", "FOREIGN FINDING")], publish: null, run: null, title: "Other" },
        { goalId: "goal-own", lifecycle: "EXECUTION_ENABLED", nodes: [node("execution-own", "OWN FINDING")], publish: null, run: null, title: "Own" },
      ], totals: { ACCEPTED: 0, BLOCKED: 0, DELIVERED: 0, ESCALATED: 0, ESCALATION_REQUIRED: 0,
        IN_PROGRESS: 0, READY: 0, REPLANNED: 2, UNATTRIBUTABLE: 0, goals: 2, nodes: 2 },
    };
    const instructions = replanInstructions(item, runs);
    expect(instructions).toContain("OWN FINDING");
    expect(instructions).not.toContain("FOREIGN FINDING");
  });
});
