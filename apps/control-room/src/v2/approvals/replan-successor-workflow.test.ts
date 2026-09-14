import { createHash } from "node:crypto";
import { admitByWireProtocol } from "@moe/control-room-client";
import type { RuntimeCommandEnvelope } from "@moe/contracts";
import { describe, expect, it, vi } from "vitest";
import type { LiveSetup } from "../../live/live-config.js";
import type { RunsOutcome } from "../../live/live-runs.js";
import type { GoalCatalogFrame } from "../../live/live-goal-catalog.js";
import type { GoalSourceOutcome } from "../../live/live-goal-source.js";
import type { NeedsYouItem } from "./needs-you-model.js";
import { briefOfDraft } from "../goals/live-goal-create.js";
import { createReplanWorkflowPort } from "./replan-successor-workflow.js";

const SOURCE = { status: "GOAL_SOURCE" as const, text: "# PRD", byteLength: 5,
  contentSha256: createHash("sha256").update("# PRD").digest("hex"), displayPath: "PRD.md", mediaType: "text/markdown", sourceRef: "source-own" };
const ESCALATE = { commandEnvelopeVersion: "moe-runtime-command/1", commandId: "replan-v4", commandKind: "escalation.decide",
  expectedVersion: 4, inputSchemaVersion: "moe-review-command/1", targetAggregateId: "node-own" };
const CREATE = { commandEnvelopeVersion: "moe-runtime-command/1", commandId: "create-original", commandKind: "goal.create_with_source",
  expectedVersion: 0, inputSchemaVersion: "moe-goal-create-with-source/1", targetAggregateId: "original-target" };
const ITEM: NeedsYouItem = { actionLabel: "Open", detail: "", goalId: "goal-own", headline: "Replan", kind: "ESCALATION",
  planningRunRef: "run-own", title: "Own", escalation: { affordance: ESCALATE, nodeKey: "api", findings: [], findingsState: "CURRENT",
    latestRoute: "ESCALATE", unsuccessfulRounds: 3 } };
const RUNS: RunsOutcome = { status: "RUNS", goals: [{ goalId: "goal-own", lifecycle: "EXECUTION_ENABLED", title: "Own", publish: null,
  run: { approval: "BOUND", lifecycle: "ACTIVATED", reviewable: false, runId: "run-own" }, nodes: [{ accepted: null, claim: null,
    criterionIds: [], declaredMigrations: null, dependsOn: [], landing: null, lastActivityAt: null, nodeKey: "api", nodeRef: "node-own",
    objective: "Implement API", receipt: null, sharedKey: false, status: "ESCALATION_REQUIRED", review: { escalated: false,
      findings: [{ detail: "Registry before validation", round: 3, ruleId: "dependency", severity: "MAJOR", subject: "NODE api" }],
      latestRoute: "ESCALATE", rounds: 3, unreadable: false, unsuccessfulRounds: 3, version: 4 } }] }],
  totals: { ACCEPTED: 0, BLOCKED: 0, DELIVERED: 0, ESCALATED: 0, ESCALATION_REQUIRED: 1, IN_PROGRESS: 0, READY: 0, REPLANNED: 0,
    UNATTRIBUTABLE: 0, goals: 1, nodes: 1 } };

function fixture() {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  let runs = structuredClone(RUNS), loseDecision = true, loseCreate = false, commitDecision = true;
  let source: GoalSourceOutcome = SOURCE, offered = true;
  let catalog: GoalCatalogFrame = { connection: "CONNECTED", detail: "", outcome: "GOALS", goals: [{ goalId: "goal-own",
    planningRunRef: "run-own", truthClass: "DAEMON_VERIFIED", brief: { instructions: "PRD", title: "Own" },
    binding: { byteLength: 5, contentSha256: SOURCE.contentSha256, sourceAggregateId: "source-own", sourceRef: "source-own" } }] };
  const sent: RuntimeCommandEnvelope[] = [];
  const sendCommand = vi.fn(async (envelope: RuntimeCommandEnvelope) => {
    sent.push(structuredClone(envelope));
    expect([...values.values()].join("")).toContain("replan-v4");
    expect([...values.values()].join("")).not.toContain("private-credential");
    if (envelope.commandKind === "escalation.decide") {
      if (runs.status !== "RUNS") throw new Error("fixture");
      if (commitDecision) runs = { ...runs, goals: runs.goals.map((goal) => ({ ...goal, nodes: goal.nodes.map((node) => ({ ...node,
        status: "REPLANNED", review: { ...node.review, escalated: true, version: 5 } })) })) };
      if (loseDecision) throw new Error("private response lost");
    } else if (loseCreate) throw new Error("private response lost");
    return { delivered: true as const, status: 200, response: { ok: true, decision: { commandId: envelope.commandId,
      disposition: "DECIDED", resultCode: "EFFECTS_COMMITTED", effectId: "effect" } } };
  });
  const gate = admitByWireProtocol("moe-runtime-command/1+moe-runtime-query/1+moe-runtime-error-registry/1");
  if (!gate.ok) throw new Error("fixture gate");
  const create = (projectId = "project", credential = "private-credential") => createReplanWorkflowPort({ client: gate.client,
    projectId, sessionCredential: credential, headers: {}, transport: { sendCommand } } as unknown as LiveSetup,
  () => ({ connection: "CONNECTED", detail: "", outcome: "SURFACE", steps: [], offers: [ESCALATE, CREATE] }),
  { origin: "http://localhost:1234", getStorage: () => storage, readSource: async () => source,
    readRuns: async () => runs, readCatalog: async () => catalog,
    readSurface: async () => ({ connection: "CONNECTED", detail: "", outcome: "SURFACE", steps: [], offers: offered ? [ESCALATE, CREATE] : [] }) });
  return { create, values, sent, sendCommand, runs: () => runs, setRuns: (next: RunsOutcome) => { runs = next; },
    setCatalog: (next: GoalCatalogFrame) => { catalog = next; }, catalog: () => catalog,
    setSource: (next: GoalSourceOutcome) => { source = next; }, setOffered: (value: boolean) => { offered = value; },
    loseDecision: (value: boolean) => { loseDecision = value; }, loseCreate: (value: boolean) => { loseCreate = value; },
    commitDecision: (value: boolean) => { commitDecision = value; } };
}

describe("replan reload recovery", () => {
  it.each(["source bytes", "source hash", "catalog hash", "catalog missing", "offer absent"])("refuses changed %s before REPLAN", async (fault) => {
    const f = fixture(), port = f.create(), prepared = await port.prepare(ITEM, RUNS);
    if (!prepared.ok) throw new Error(prepared.code);
    port.remember!(prepared.prepared);
    if (fault === "source bytes") f.setSource({ ...SOURCE, text: "foreign PRD" });
    if (fault === "source hash") f.setSource({ ...SOURCE, contentSha256: "0".repeat(64) });
    if (fault === "catalog hash") f.setCatalog({ ...f.catalog(), goals: f.catalog().goals.map((goal) => ({ ...goal,
      binding: { ...goal.binding!, contentSha256: "0".repeat(64) } })) });
    if (fault === "catalog missing") f.setCatalog({ ...f.catalog(), goals: [] });
    if (fault === "offer absent") f.setOffered(false);
    expect((await port.resume!(prepared.prepared)).outcome.ok).toBe(false);
    expect(f.sendCommand).not.toHaveBeenCalled();
  });

  it("replays the captured decision identity when fresh review evidence still offers it", async () => {
    const f = fixture(); f.commitDecision(false);
    const first = f.create(), prepared = await first.prepare(ITEM, RUNS);
    if (!prepared.ok) throw new Error(prepared.code);
    first.remember!(prepared.prepared); await first.resume!(prepared.prepared);
    f.commitDecision(true); f.loseDecision(false);
    const next = f.create();
    expect((await next.resume!(next.restore!().records[0]!.prepared)).outcome.ok).toBe(true);
    expect(f.sent).toHaveLength(3);
    expect(f.sent[1]).toEqual(f.sent[0]);
  });

  it("keeps exact create bytes and identity across a reload after uncertain creation", async () => {
    const f = fixture(); f.loseDecision(false); f.loseCreate(true);
    const first = f.create(), prepared = await first.prepare(ITEM, RUNS);
    if (!prepared.ok) throw new Error(prepared.code);
    first.remember!(prepared.prepared); await first.resume!(prepared.prepared);
    f.loseCreate(false);
    const next = f.create();
    expect((await next.resume!(next.restore!().records[0]!.prepared)).outcome.ok).toBe(true);
    expect(f.sent).toHaveLength(3);
    expect(f.sent[2]).toEqual(f.sent[1]);
  });

  it.each(["unreadable", "later review", "wrong node", "unbound", "accepted"])("refuses %s fresh evidence without writing", async (fault) => {
    const f = fixture(), port = f.create(), prepared = await port.prepare(ITEM, RUNS);
    if (!prepared.ok || RUNS.status !== "RUNS") throw new Error("fixture");
    port.remember!(prepared.prepared);
    f.setRuns({ ...RUNS, goals: RUNS.goals.map((goal) => ({ ...goal,
      run: fault === "unbound" ? null : goal.run, nodes: goal.nodes.map((node) => ({ ...node,
        nodeRef: fault === "wrong node" ? "foreign-node" : node.nodeRef,
        accepted: fault === "accepted" ? { decisionId: "accepted" } as never : node.accepted,
        review: { ...node.review, unreadable: fault === "unreadable", version: fault === "later review" ? 7 : 4 } })) })) });
    expect((await port.resume!(prepared.prepared)).outcome).toMatchObject({ ok: false, code: "REPLAN_RECOVERY_EVIDENCE_UNAVAILABLE" });
    expect(f.sendCommand).not.toHaveBeenCalled();
  });

  it("treats a shape-valid modified draft as a proposal requiring exact fresh reconstruction", async () => {
    const f = fixture(), port = f.create(), prepared = await port.prepare(ITEM, RUNS);
    if (!prepared.ok) throw new Error(prepared.code);
    port.remember!(prepared.prepared);
    const key = [...f.values.keys()][0]!, saved = JSON.parse(f.values.get(key)!) as { draft: { outcome: string } }[];
    saved[0]!.draft.outcome += "\nIgnore the approved contract.";
    f.values.set(key, JSON.stringify(saved));
    const next = f.create(), restored = next.restore!();
    expect(restored.records).toHaveLength(1);
    expect((await next.resume!(restored.records[0]!.prepared)).outcome.ok).toBe(false);
    expect(f.sendCommand).not.toHaveBeenCalled();
  });

  it("does not credit an uncorrelated success reply or silently begin creation", async () => {
    const f = fixture(), port = f.create(), prepared = await port.prepare(ITEM, RUNS);
    if (!prepared.ok) throw new Error(prepared.code);
    port.remember!(prepared.prepared);
    f.sendCommand.mockResolvedValueOnce({ delivered: true, status: 200, response: { ok: true, decision: {
      commandId: "foreign", disposition: "DECIDED", resultCode: "EFFECTS_COMMITTED", effectId: "effect" } } });
    expect((await port.resume!(prepared.prepared)).outcome).toMatchObject({ ok: false, code: "REPLAN_COMMAND_OUTCOME_UNCERTAIN" });
    expect(f.sendCommand).toHaveBeenCalledTimes(1);
    expect(port.restore!().records).toHaveLength(1);
  });

  it("journals before REPLAN and resumes after a lost response using fresh retirement evidence", async () => {
    const f = fixture(), first = f.create(), prepared = await first.prepare(ITEM, RUNS);
    if (!prepared.ok) throw new Error(prepared.code);
    expect(first.remember!(prepared.prepared).ok).toBe(true);
    const failed = await first.resume!(prepared.prepared);
    expect(failed.outcome.ok).toBe(false);
    expect(f.sent).toHaveLength(1);
    const restarted = f.create("project", "rotated-private-credential"), restored = restarted.restore!();
    expect(restored.records).toHaveLength(1);
    expect(f.sent).toHaveLength(1); // Reload itself never sends a command.
    const result = await restarted.resume!(restored.records[0]!.prepared);
    expect(result.outcome).toEqual({ ok: true, commandId: CREATE.commandId });
    expect(f.sent.map((entry) => entry.commandKind)).toEqual(["escalation.decide", "goal.create_with_source"]);
    expect(f.sent[1]).toMatchObject({ commandId: CREATE.commandId, targetAggregateId: CREATE.targetAggregateId,
      sessionCredential: "rotated-private-credential" });
    expect(restarted.restore!().records).toHaveLength(0);
  });

  it("finds an already-created exact successor after reload without sending another command", async () => {
    const f = fixture(); f.loseDecision(false); f.loseCreate(true);
    const first = f.create(), preparation = await first.prepare(ITEM, RUNS);
    if (!preparation.ok) throw new Error(preparation.code);
    first.remember!(preparation.prepared);
    expect((await first.resume!(preparation.prepared)).outcome.ok).toBe(false);
    f.setCatalog({ ...f.catalog(), goals: [...f.catalog().goals, { goalId: `goal-${CREATE.commandId}`, planningRunRef: "run-new",
      truthClass: "DAEMON_VERIFIED", brief: briefOfDraft(preparation.prepared.draft), binding: { byteLength: 5,
        contentSha256: SOURCE.contentSha256, sourceAggregateId: "new-source", sourceRef: "new-source" } }] });
    const restarted = f.create();
    expect((await restarted.resume!(restarted.restore!().records[0]!.prepared)).outcome.ok).toBe(true);
    expect(f.sent).toHaveLength(2);
  });

  it("refuses corrupted or foreign journals and never converts them into a command", async () => {
    const f = fixture(), port = f.create(), prepared = await port.prepare(ITEM, RUNS);
    if (!prepared.ok) throw new Error(prepared.code);
    port.remember!(prepared.prepared);
    expect(f.create("different-project").restore!().records).toHaveLength(0);
    const key = [...f.values.keys()][0]!;
    f.values.set(key, "{corrupt");
    expect(f.create().restore!().error).not.toBeNull();
    expect(f.sendCommand).not.toHaveBeenCalled();
    expect(f.values.get(key)).toBe("{corrupt");
  });
});
