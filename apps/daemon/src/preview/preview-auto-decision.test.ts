/**
 * GATE 2 CLOSING WITHOUT A HUMAN: `preview.decide` auto-approved under a recorded standing opt-in.
 *
 * WHY THE NEGATIVES ARE DRIVEN THROUGH THE EVALUATION INPUT RATHER THAN A GOAL FORM.
 * `admitGoalBrief` is exact-arity over `["title","instructions"]`, so a goal's advisory risk class
 * reaches the daemon only as PROSE — there is no wire on which an R2 goal exists. The owner's
 * 2026-09-09 ruling kept it that way and made the tier HOST-classified, so a tier-bearing fact is
 * the only thing that can drive a tier arm, and that is what each negative below supplies.
 *
 * WHY NO ARM ASSERTS MERELY "IT REFUSED". Five conditions can decline an automatic decision and
 * two different LAYERS answer them, so "no approval happened" is one added layer away from
 * vacuous: a receipt-shape regression would decline every case and every arm would stay green
 * while nothing about policy was being tested. Every arm below asserts the CODE together with the
 * LAYER production pairs it with — read through the exported `previewAutoDecline`, because the
 * code->layer map itself is module-private — and the engine's own reason code where core
 * answered — and each is paired with a POSITIVE CONTROL over the same input that DOES approve, so
 * a gate that started declining for the wrong reason reddens the control instead of hiding inside
 * the refusal.
 *
 * WHY THE POSITIVE ARMS ASSERT PROVENANCE VALUES, NOT THE VERDICT. A `decision: "APPROVE"`
 * assertion passes identically against a human approval, so it would not test this row's subject
 * at all. What makes an automatic approval distinguishable is that the persisted record NAMES what
 * it acted under, so every positive arm asserts `provenance.action` and `provenance.tier`.
 */
import { readFileSync } from "node:fs";

import { POLICY_AUTO_APPROVAL_TIERS, derivePolicySliceDigest } from "@moe/core";
import type { PolicyRiskTier } from "@moe/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  GOAL_ID, PROJECT_ID, closeStores, driveThrough, envelope, hex64, openStore, send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { readDurableLedger, stateOf, versionOf } from "../bootstrap/bootstrap-ledger.js";
import { installedSlices } from "../bootstrap/bootstrap-policy-services.js";
import { policyAggregateId } from "../bootstrap/bootstrap-sequence.js";
import { sliceKindOf } from "../http/policy-read.js";
import { POLICY_EVALUATOR_VERSION } from "../bootstrap/bootstrap-policy-authority.js";
import {
  POLICY_RISK_EVENT_TYPE, buildPolicyRiskRecord, policyRiskAggregateIdFor,
} from "../bootstrap/policy-risk-record.js";
import { createDaemonCommandPorts } from "../daemon-command-registry.js";
import { OPERATOR_PRINCIPAL_KINDS } from "../daemon-command-vocabulary.js";
import { seedLandingReceipt, seedReviewAcceptance } from "../goals/goal-closure-test-fixtures.js";
import { MCP_EXCLUDED_COMMAND_KINDS, wiredMcpToolKinds } from "../mcp-tool-allowlist.js";
import type { CommandHandlerInput } from "../http/http-contract.js";
import { compiledExecutionRef } from "../orchestrator/compiled-execution-ref.js";
import { activeCompiledGraphs } from "../orchestrator/compiled-node-source.js";
import {
  graphRevisionAggregateId, readCurrentActiveGraph,
} from "../planning/active-graph-projection.js";
import { putGraphBody } from "../planning/graph-body-record.js";
import { PRIMARY, activePathFor } from "../planning/graph-query-test-fixtures.js";
import {
  previewAutoCommandId, resolvePreviewAutoDecision,
} from "./preview-auto-composition.js";
import {
  PREVIEW_AUTO_CODES, previewAutoDecisionFor, previewAutoDecline,
} from "./preview-auto-decision.js";
import type { PreviewAutoDecision } from "./preview-auto-decision.js";
import {
  PREVIEW_APPROVE_PAYLOAD_KEYS, PREVIEW_CODES, PREVIEW_DECIDE_COMMAND_KIND, PREVIEW_LAYERS,
  PREVIEW_REJECT_PAYLOAD_KEYS, decodePreviewDecidePayload,
} from "./preview-contracts.js";
import { runPreviewDecideEdge } from "./preview-daemon-edge.js";
import {
  decodePreviewDecisionRecord, readPreviewDecision,
} from "./preview-decision-record.js";
import { readGoalLandingStatus } from "./preview-goal-landing.js";
import { recordPreviewReceipt } from "./preview-ledger.js";
import { previewAggregateId } from "./preview-receipt-contracts.js";
import { createPreviewStartHandler } from "./preview-start-command.js";
import type { PreviewSupervisor } from "./preview-supervisor.js";
import type { PreviewReceiptV1 } from "./preview-receipt-contracts.js";

type Store = ReturnType<typeof openStore>;

const SHA = "0123456789abcdef0123456789abcdef01234567";
const DECIDED_AT = "2026-09-10T08:00:00.000Z";
const OPERATOR = "operator-auto-preview";
const NODE_KEY = "node-a";
const FACT_ID = "preview-auto-fact";
const ENCODER = new TextEncoder();

afterEach(() => { closeStores(); });

// ---------------------------------------------------------------------------------------------
// PURE INPUTS. These name the engine's own operands, so an arm below states exactly which one it
// varies; nothing here re-derives a tier, ranks one, or matches an opt-in.
// ---------------------------------------------------------------------------------------------

/** One evaluation input. `tier` classifies the single strong-truth fact; `optIns` is the slice's
 *  standing declaration. Both are the ENGINE's operands, spelled rather than computed. */
function input(options: {
  readonly action?: string;
  readonly optIns?: readonly { readonly action: string; readonly tier: "R0" | "R1" }[];
  readonly tier: PolicyRiskTier | null;
}): Readonly<Record<string, unknown>> {
  const action = options.action ?? PREVIEW_DECIDE_COMMAND_KIND;
  return {
    action,
    actor: OPERATOR,
    callerRiskHint: null,
    decisionDigest: hex64("d1"),
    evaluatedAtEpochMs: Date.parse(DECIDED_AT),
    evaluatorVersion: POLICY_EVALUATOR_VERSION,
    facts: [{ factId: FACT_ID, tier: options.tier, truthClass: "HUMAN_APPROVED" }],
    graphNodeRevisionRefs: [],
    policyRevisionRef: hex64("ab"),
    requiredFactIds: [],
    scope: [],
    sliceChain: [{
      autoApprovalOptIns: options.optIns
        ?? [{ action: PREVIEW_DECIDE_COMMAND_KIND, tier: "R1" }],
      rules: [],
      sliceRef: hex64("ab"),
    }],
    waivers: [],
  };
}

function declined(result: PreviewAutoDecision): {
  readonly code: string; readonly layer: string; readonly reasonCodes: readonly string[];
} {
  if (result.ok) throw new Error("expected a declined automatic decision, got an approval");
  return { code: result.code, layer: result.layer, reasonCodes: result.reasonCodes };
}

// ---------------------------------------------------------------------------------------------
// A REAL WORLD. The store, the landing, the receipt and the policy install all go through
// production writers; only the supervisor is a stub, and it writes its receipt with the
// production writer too.
// ---------------------------------------------------------------------------------------------

function scopedRef(store: Store, nodeKey: string): string {
  const graph = activeCompiledGraphs(store, PROJECT_ID).find((plan) =>
    plan.goalRef === GOAL_ID && plan.content.snapshot.nodes.some((n) => n.nodeKey === nodeKey));
  return graph === undefined ? nodeKey : compiledExecutionRef(PROJECT_ID, graph, nodeKey);
}

/**
 * An ACTIVE graph revision for the bootstrap project, which the seed sequence never creates.
 *
 * IT IS NOT DECORATION. `readPolicyRisk` joins its fifth gate on the CURRENT ACTIVE graph's
 * content hash and epoch, so without one every risk record answers POLICY_RISK_SUBJECT_STALE, the
 * fact stays null-tier UNKNOWN, and `assessRisk` folds the whole evaluation to HOLD_UNKNOWN. That
 * is the correct production behaviour and it is asserted in its own arm below — but it would make
 * every APPROVAL arm vacuous, so the positive arms build the world where a tier is reachable.
 */
function seedActiveGraph(store: Store): void {
  const revisionId = "graph-revision-auto-preview";
  const aggregateId = graphRevisionAggregateId(PROJECT_ID, revisionId);
  const commandId = `seed-${revisionId}`;
  store.commit({
    aggregateId,
    commandBytes: ENCODER.encode(commandId),
    commandId,
    committedAt: DECIDED_AT,
    events: activePathFor(revisionId, PRIMARY).map((event, index) => ({
      eventId: `${commandId}-${String(index)}`,
      eventType: event.kind,
      payload: ENCODER.encode(JSON.stringify(event)),
    })),
    expectedVersion: store.getAggregateVersion(aggregateId),
  });
  const body = putGraphBody(store, PROJECT_ID, PRIMARY);
  if (!body.ok) throw new Error(`graph body fixture refused: ${body.code}`);
  const active = readCurrentActiveGraph(store, PROJECT_ID);
  if (!active.ok) throw new Error(`active graph fixture refused: ${active.code}`);
}

/** The seed world with its one execution-bearing node landed as a real commit. */
function landedWorld(): Store {
  const store = openStore();
  driveThrough(store, "goal.close");
  const nodeRef = scopedRef(store, NODE_KEY);
  seedReviewAcceptance(store, nodeRef);
  seedLandingReceipt(store, nodeRef, "COMMITTED");
  // Asserted, not assumed: every arm depends on the landing gate being PASSABLE, so a fixture
  // that silently stopped landing would make the approval arms vacuous.
  expect(readGoalLandingStatus(store, PROJECT_ID, GOAL_ID).allLanded).toBe(true);
  return store;
}

/** Installs an EVALUATION slice carrying the operator's standing opt-in, through the PRODUCTION
 *  `policy.install` command. The digest is derived, never spelled, so the ref is the slice. */
function installOptInPolicy(
  store: Store, optIns: readonly { readonly action: string; readonly tier: "R0" | "R1" }[],
): string {
  const body = {
    autoApprovalOptIns: optIns,
    riskClassifications: [{ factId: FACT_ID, tier: "R0" }],
    rules: [], sliceRef: "pending-auto-opt-in-slice",
  };
  const digest = derivePolicySliceDigest(body);
  if (!digest.ok) throw new Error(`opt-in slice fixture is invalid: ${digest.code}`);
  const slice = { ...body, sliceRef: digest.digest };
  const version = versionOf(readDurableLedger(store, PROJECT_ID), `${PROJECT_ID}-policy`);
  const outcome = send(store, envelope(
    "policy.install", version, { slice }, "cmd-install-auto-opt-in",
  ));
  if (!outcome.ok) throw new Error(`opt-in policy install refused: ${outcome.code}`);
  return digest.digest;
}

/** The operator's durable risk classification for the preview gate: the only thing that can
 *  ground a tier, and it is HUMAN_APPROVED by the reader's own contract. */
function seedPolicyRisk(store: Store, tier: PolicyRiskTier, action = PREVIEW_DECIDE_COMMAND_KIND):
void {
  const active = readCurrentActiveGraph(store, PROJECT_ID);
  if (!active.ok) throw new Error(`active graph fixture refused: ${active.code}`);
  const record = {
    actionKind: action, approvedBy: OPERATOR, assessedAt: DECIDED_AT,
    decisionRef: `decision-auto-${action}-${tier}`, projectId: PROJECT_ID,
    subjectRef: active.graphContentHash, subjectRevision: active.graphEpoch, tier,
  };
  const built = buildPolicyRiskRecord(record);
  if (!built.ok) throw new Error(`policy risk fixture refused: ${built.code}`);
  const aggregateId = policyRiskAggregateIdFor(record);
  store.commit({
    aggregateId,
    commandBytes: ENCODER.encode(`seed-${record.decisionRef}`),
    commandId: `seed-${record.decisionRef}`,
    committedAt: DECIDED_AT,
    events: [{
      eventId: `event-${record.decisionRef}`, eventType: POLICY_RISK_EVENT_TYPE,
      payload: built.bytes,
    }],
    expectedVersion: store.getAggregateVersion(aggregateId),
  });
}

/** A receipt written by the PRODUCTION writer. `code` null records STARTED, a code REFUSED. */
function receipt(store: Store, code: "PREVIEW_START_TIMEOUT" | null = null): PreviewReceiptV1 {
  const recorded = recordPreviewReceipt(store, {
    code, decidedAt: DECIDED_AT, goalId: GOAL_ID, pid: code === null ? 4242 : null,
    projectId: PROJECT_ID, screenshots: [], sha: SHA,
    url: code === null ? "http://127.0.0.1:5199/" : null,
  });
  if (!recorded.ok) throw new Error(`receipt fixture refused: ${recorded.code}`);
  return recorded.receipt;
}

/** A supervisor whose `start` writes the receipt the runner would have written, and whose
 *  `decide` records the release rather than stopping a process there is none of. */
function stubSupervisor(store: Store): {
  readonly released: string[]; readonly supervisor: PreviewSupervisor;
} {
  const released: string[] = [];
  return {
    released,
    supervisor: Object.freeze({
      active: () => [],
      close: async (): Promise<void> => undefined,
      decide: async (receiptId: string): Promise<boolean> => {
        released.push(receiptId); return true;
      },
      start: async (): Promise<{ readonly ok: true; readonly receipt: PreviewReceiptV1 }> => ({
        ok: true as const, receipt: receipt(store),
      }),
    }) as unknown as PreviewSupervisor,
  };
}

/** Drives the PRODUCTION `preview.start` handler, which is where this row's wiring lives. */
async function startPreview(store: Store, supervisor: PreviewSupervisor): Promise<void> {
  const handler = createPreviewStartHandler({
    clock: () => DECIDED_AT, operatorPrincipalId: OPERATOR, projectId: PROJECT_ID, store,
    supervisor, workspace: "/tmp/preview-auto-fixture",
  });
  await handler({
    envelope: { commandId: "cmd-auto-start", payload: { goalId: GOAL_ID, sha: SHA } },
    principal: { capabilities: ["review.write"], principalId: OPERATOR, projectId: PROJECT_ID },
  } as unknown as CommandHandlerInput);
}

/** The decision the automatic path committed, read through the PRODUCTION read surface. */
function autoDecisionRecord(store: Store, receiptId: string): ReturnType<
  typeof readPreviewDecision
> {
  return readPreviewDecision(
    store, PROJECT_ID, OPERATOR, previewAutoCommandId(PROJECT_ID, receiptId),
  );
}

describe("previewAutoDecisionFor names the opt-in it acted under", () => {
  it("approves an R0 subject under an R1 opt-in and NAMES the action and tier", () => {
    const result = previewAutoDecisionFor(input({ tier: "R0" }));
    if (!result.ok) throw new Error(`expected an approval, got ${result.code}`);
    expect(result.provenance.action).toBe(PREVIEW_DECIDE_COMMAND_KIND);
    expect(result.provenance.tier).toBe("R0");
  });

  it("approves an R1 subject under an R1 opt-in and names R1 as the tier it acted at", () => {
    const result = previewAutoDecisionFor(input({ tier: "R1" }));
    if (!result.ok) throw new Error(`expected an approval, got ${result.code}`);
    expect(result.provenance).toEqual({ action: PREVIEW_DECIDE_COMMAND_KIND, tier: "R1" });
  });
});

describe("R2 and R3 are never auto-approved", () => {
  // The POSITIVE CONTROL for this whole block: the same input at R0 approves, so an arm below
  // that declined for a reason other than the tier would redden here first.
  it("positive control: the same shape at R0 approves", () => {
    expect(previewAutoDecisionFor(input({ tier: "R0" })).ok).toBe(true);
  });

  for (const tier of ["R2", "R3"] as const) {
    it(`declines ${tier} with HUMAN_ONLY_TIER from the engine, at the CORE layer`, () => {
      const result = declined(previewAutoDecisionFor(input({ tier })));
      expect(result.code).toBe("PREVIEW_AUTO_NOT_ALLOWED");
      expect(result.layer).toBe("CORE_REDUCER");
      // The ENGINE's own reason code, not a restamped one — this is the fact the DoD names.
      expect(result.reasonCodes).toContain("HUMAN_ONLY_TIER");
    });
  }

  it("declines an R0 subject with no opt-in covering the action, with the engine's own code", () => {
    const result = declined(previewAutoDecisionFor(input({ optIns: [], tier: "R0" })));
    expect(result.code).toBe("PREVIEW_AUTO_NOT_ALLOWED");
    expect(result.layer).toBe("CORE_REDUCER");
    expect(result.reasonCodes).toContain("AUTO_APPROVAL_NOT_OPTED_IN");
  });

  it("declines when the only opt-in names a DIFFERENT action", () => {
    const result = declined(previewAutoDecisionFor(
      input({ optIns: [{ action: "release.decide", tier: "R1" }], tier: "R0" }),
    ));
    expect(result.reasonCodes).toContain("AUTO_APPROVAL_NOT_OPTED_IN");
  });

  it("declines when NO tier-bearing fact is in scope, because unknown risk dominates ALLOW", () => {
    const result = declined(previewAutoDecisionFor(input({ tier: null })));
    expect(result.code).toBe("PREVIEW_AUTO_NOT_ALLOWED");
    expect(result.layer).toBe("CORE_REDUCER");
    expect(result.reasonCodes).toContain("RISK_TIER_UNCLASSIFIABLE");
  });

  it("declines a structurally invalid input at the CORE layer, committing nothing", () => {
    const result = declined(previewAutoDecisionFor({ action: PREVIEW_DECIDE_COMMAND_KIND }));
    expect(result.code).toBe("PREVIEW_AUTO_POLICY_INPUT_INVALID");
    expect(result.layer).toBe("CORE_REDUCER");
  });
});

describe("the auto-approval ceiling is core's, and this row did not move it", () => {
  it("POLICY_AUTO_APPROVAL_TIERS still deep-equals ['R0','R1']", () => {
    expect([...POLICY_AUTO_APPROVAL_TIERS]).toEqual(["R0", "R1"]);
  });

  /**
   * A SOURCE-TEXT PIN ON CODE THIS ROW DOES NOT OWN, and that is the point: the gate leans on
   * `assessTier` refusing R2/R3 and on its opt-in match being an action equality with a tier
   * ceiling. A `git status` check would be flaky on a shared checkout carrying peer edits; these
   * three lines are the authority itself, so an edit to them reddens here rather than silently
   * widening what this row auto-approves.
   */
  it("assessTier's human-only tiers and opt-in match are unchanged in @moe/core", () => {
    const source = readFileSync(
      new URL("../../../../packages/core/src/policy/policy-evaluation.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain('if (tier === "R2" || tier === "R3") {');
    expect(source).toContain('codes.add("HUMAN_ONLY_TIER");');
    expect(source).toContain(
      "fold.optIns.some((entry) => entry.action === action && tierRank(entry.tier) >= tierRank(tier))",
    );
  });

  /**
   * READ THROUGH THE PUBLIC REFUSAL SURFACE, AND STRICTER THAN THE ARM IT REPLACES. The code->layer
   * map is module-private (the security roster's private population is where a layer that reaches
   * no wire belongs), so this drives every code through the exported `previewAutoDecline` — the
   * one place production pairs a code with a layer — and pins the WHOLE TABLE as literals.
   *
   * WHY THE WHOLE TABLE AND NOT THE VALUE SET. The previous form asserted
   * `new Set(Object.values(MAP))` equals the two layers, which CANNOT FAIL on a real remapping:
   * move ALREADY_DECIDED from PREVIEW_AUTO_DECISION to CORE_REDUCER and the value set is still
   * exactly those two. It also put an imported constant on both sides, which this repo names as
   * the weak form. Every entry below is a literal, so any single remap reds this arm, and the
   * roster-completeness half survives as the `PREVIEW_AUTO_CODES` set-equality.
   */
  it("pairs every declination code with its own layer, asserted as literals through production", () => {
    expect([...PREVIEW_AUTO_CODES]).toEqual([
      "PREVIEW_AUTO_ALREADY_DECIDED", "PREVIEW_AUTO_NOT_ALLOWED", "PREVIEW_AUTO_POLICY_INPUT_INVALID",
      "PREVIEW_AUTO_POLICY_UNRESOLVED", "PREVIEW_AUTO_RECEIPT_NOT_STARTED",
      "PREVIEW_AUTO_TIER_UNCOVERED",
    ]);
    const table = Object.fromEntries(
      PREVIEW_AUTO_CODES.map((code) => [code, previewAutoDecline(code).layer]),
    );
    expect(table).toEqual({
      PREVIEW_AUTO_ALREADY_DECIDED: "PREVIEW_AUTO_DECISION",
      PREVIEW_AUTO_NOT_ALLOWED: "CORE_REDUCER",
      PREVIEW_AUTO_POLICY_INPUT_INVALID: "CORE_REDUCER",
      PREVIEW_AUTO_POLICY_UNRESOLVED: "PREVIEW_AUTO_DECISION",
      PREVIEW_AUTO_RECEIPT_NOT_STARTED: "PREVIEW_AUTO_DECISION",
      PREVIEW_AUTO_TIER_UNCOVERED: "PREVIEW_AUTO_DECISION",
    });
    // BOTH layers stay reachable — the property the replaced arm owned, kept alongside the table.
    expect([...new Set(Object.values(table))].sort()).toEqual(["CORE_REDUCER", "PREVIEW_AUTO_DECISION"]);
  });
});

describe("preview.start auto-approves over a real store, with no human decision", () => {
  it("commits an APPROVE whose persisted record NAMES the opt-in it acted under", async () => {
    const store = landedWorld();
    seedActiveGraph(store);
    installOptInPolicy(store, [{ action: PREVIEW_DECIDE_COMMAND_KIND, tier: "R1" }]);
    seedPolicyRisk(store, "R0");
    const { released, supervisor } = stubSupervisor(store);
    await startPreview(store, supervisor);

    const receiptId = receipt(store).receiptId;
    const record = autoDecisionRecord(store, receiptId);
    if (record === null) throw new Error("no automatic decision was committed");
    expect(record.decision).toBe("APPROVE");
    // THE SUBJECT OF THIS ROW. A verdict-only assertion would pass against a human approval.
    expect(record.provenance).toEqual({ action: PREVIEW_DECIDE_COMMAND_KIND, tier: "R0" });
    expect(record.version).toBe("moe-preview-decision/2");
    // The decision reached the runner through the existing release seam, not a second path.
    expect(released).toEqual([receiptId]);
  });

  it("leaves the gate pending when the operator has recorded NO risk classification", async () => {
    const store = landedWorld();
    installOptInPolicy(store, [{ action: PREVIEW_DECIDE_COMMAND_KIND, tier: "R1" }]);
    const { released, supervisor } = stubSupervisor(store);
    await startPreview(store, supervisor);
    expect(autoDecisionRecord(store, receipt(store).receiptId)).toBeNull();
    expect(released).toEqual([]);
  });

  it("leaves the gate pending when no installed slice DECLARES the preview gate's opt-in", async () => {
    const store = landedWorld();
    seedActiveGraph(store);
    installOptInPolicy(store, [{ action: "release.decide", tier: "R1" }]);
    seedPolicyRisk(store, "R0");
    const { released, supervisor } = stubSupervisor(store);
    await startPreview(store, supervisor);
    expect(autoDecisionRecord(store, receipt(store).receiptId)).toBeNull();
    expect(released).toEqual([]);
    // The CODE, not merely the absence: a slice declaring only the release gate is not a chain
    // this subject may be evaluated against, so selection refuses before core is asked.
    const result = declined(resolvePreviewAutoDecision({
      decidedAt: DECIDED_AT, principalId: OPERATOR, projectId: PROJECT_ID,
      receipt: receipt(store), store,
    }));
    expect(result.code).toBe("PREVIEW_AUTO_POLICY_UNRESOLVED");
    expect(result.layer).toBe("PREVIEW_AUTO_DECISION");
  });

  it("never fires on a REFUSED receipt, which names a code and served no url", () => {
    const store = landedWorld();
    seedActiveGraph(store);
    installOptInPolicy(store, [{ action: PREVIEW_DECIDE_COMMAND_KIND, tier: "R1" }]);
    seedPolicyRisk(store, "R0");
    const refused = receipt(store, "PREVIEW_START_TIMEOUT");
    expect(refused.outcome).toBe("REFUSED");
    const result = declined(resolvePreviewAutoDecision({
      decidedAt: DECIDED_AT, principalId: OPERATOR, projectId: PROJECT_ID, receipt: refused, store,
    }));
    expect(result.code).toBe("PREVIEW_AUTO_RECEIPT_NOT_STARTED");
    expect(result.layer).toBe("PREVIEW_AUTO_DECISION");
  });

  /**
   * MEASURED ON THE SHIPPED SEED WORLD, and it changed this row's production selector. The
   * bootstrap sequence installs TWO EVALUATION slices, so a rule of "exactly one EVALUATION
   * slice" would have made the automatic path unreachable on every real project while every arm
   * over a hand-built world stayed green. The selector filters on the DECLARATION instead, and
   * the arm below pins the remaining ambiguity: two slices BOTH declaring this gate.
   */
  it("declines when TWO installed slices both declare the preview gate's opt-in", () => {
    const store = landedWorld();
    seedActiveGraph(store);
    seedPolicyRisk(store, "R0");
    installOptInPolicy(store, [{ action: PREVIEW_DECIDE_COMMAND_KIND, tier: "R1" }]);
    const body = {
      autoApprovalOptIns: [{ action: PREVIEW_DECIDE_COMMAND_KIND, tier: "R1" }],
      riskClassifications: [{ factId: FACT_ID, tier: "R1" }],
      rules: [], sliceRef: "pending-second-slice",
    };
    const digest = derivePolicySliceDigest(body);
    if (!digest.ok) throw new Error("second slice fixture is invalid");
    const version = versionOf(readDurableLedger(store, PROJECT_ID), `${PROJECT_ID}-policy`);
    const outcome = send(store, envelope("policy.install", version, {
      slice: { ...body, sliceRef: digest.digest },
    }, "cmd-install-second-slice"));
    if (!outcome.ok) throw new Error(`second install refused: ${outcome.code}`);
    const result = declined(resolvePreviewAutoDecision({
      decidedAt: DECIDED_AT, principalId: OPERATOR, projectId: PROJECT_ID,
      receipt: receipt(store), store,
    }));
    expect(result.code).toBe("PREVIEW_AUTO_POLICY_UNRESOLVED");
    expect(result.layer).toBe("PREVIEW_AUTO_DECISION");
  });

  it("the shipped seed world installs TWO evaluation slices, which is why selection filters on the declaration", () => {
    const store = landedWorld();
    const declaring = installOptInPolicy(
      store, [{ action: PREVIEW_DECIDE_COMMAND_KIND, tier: "R1" }],
    );
    const installed = installedSlices(
      stateOf(readDurableLedger(store, PROJECT_ID), policyAggregateId(PROJECT_ID)),
    );
    const evaluation = Object.keys(installed)
      .filter((ref) => sliceKindOf(ref, installed[ref] as never) === "EVALUATION");
    expect(evaluation).toContain(declaring);
    expect(evaluation.length).toBeGreaterThan(1);
  });
});

describe("a recorded human decision WINS, and the automatic path never overturns it", () => {
  /**
   * Commits a HUMAN verdict through the production wire edge, exactly as an operator's own
   * `preview.decide` would. Its `provenance` is null by construction — no call site here supplies
   * one — which is what makes the distinction the positive arms assert meaningful.
   */
  function humanDecide(store: Store, decision: "APPROVE" | "REJECT", receiptId: string): string {
    const commandId = `cmd-human-${decision.toLowerCase()}`;
    const nodeRef = readGoalLandingStatus(store, PROJECT_ID, GOAL_ID).nodes[0];
    if (nodeRef === undefined) throw new Error("landing fixture names no node to rework");
    runPreviewDecideEdge({
      envelope: {
        commandId, correlationId: `corr-${commandId}`,
        expectedVersion: versionOf(
          readDurableLedger(store, PROJECT_ID), previewAggregateId(GOAL_ID),
        ),
        payload: decision === "REJECT"
          ? { decision, findings: [{ detail: "not ready", nodeRef }], previewRef: receiptId }
          : { decision, previewRef: receiptId },
      },
      now: () => DECIDED_AT,
      port: Object.freeze({
        close: async (): Promise<void> => undefined, release: (): void => undefined,
      }),
      principalId: OPERATOR, projectId: PROJECT_ID, store,
    });
    return commandId;
  }

  /** The world every arm in this block shares: auto-approvable in every respect BUT the
   *  precedence gate, so an arm that declined for another reason reddens the control below. */
  function contestedWorld(): { readonly receiptId: string; readonly store: Store } {
    const store = landedWorld();
    seedActiveGraph(store);
    installOptInPolicy(store, [{ action: PREVIEW_DECIDE_COMMAND_KIND, tier: "R1" }]);
    seedPolicyRisk(store, "R0");
    return { receiptId: receipt(store).receiptId, store };
  }

  it("positive control: with NO prior decision the same world auto-approves", () => {
    const { store } = contestedWorld();
    const result = resolvePreviewAutoDecision({
      decidedAt: DECIDED_AT, principalId: OPERATOR, projectId: PROJECT_ID,
      receipt: receipt(store), store,
    });
    if (!result.ok) throw new Error(`control expected an approval, got ${result.code}`);
    expect(result.provenance).toEqual({ action: PREVIEW_DECIDE_COMMAND_KIND, tier: "R0" });
  });

  it("declines with PREVIEW_AUTO_ALREADY_DECIDED at its own layer when a REJECT is recorded", () => {
    const { receiptId, store } = contestedWorld();
    const humanCommandId = humanDecide(store, "REJECT", receiptId);
    const result = declined(resolvePreviewAutoDecision({
      decidedAt: DECIDED_AT, principalId: OPERATOR, projectId: PROJECT_ID,
      receipt: receipt(store), store,
    }));
    expect(result.code).toBe("PREVIEW_AUTO_ALREADY_DECIDED");
    expect(result.layer).toBe("PREVIEW_AUTO_DECISION");
    // The human's verdict is UNTOUCHED, and it reads back as a HUMAN one: provenance null.
    const human = readPreviewDecision(store, PROJECT_ID, OPERATOR, humanCommandId);
    expect(human?.decision).toBe("REJECT");
    expect(human?.provenance).toBeNull();
  });

  it("commits nothing through the real start handler once a human REJECT is recorded", async () => {
    const { receiptId, store } = contestedWorld();
    const humanCommandId = humanDecide(store, "REJECT", receiptId);
    const { released, supervisor } = stubSupervisor(store);
    await startPreview(store, supervisor);
    expect(autoDecisionRecord(store, receiptId)).toBeNull();
    expect(released).toEqual([]);
    expect(readPreviewDecision(store, PROJECT_ID, OPERATOR, humanCommandId)?.decision)
      .toBe("REJECT");
  });

  it("is IDEMPOTENT: a second start commits no second automatic decision", async () => {
    const { receiptId, store } = contestedWorld();
    const first = stubSupervisor(store);
    await startPreview(store, first.supervisor);
    const committed = autoDecisionRecord(store, receiptId);
    expect(committed?.provenance).toEqual({ action: PREVIEW_DECIDE_COMMAND_KIND, tier: "R0" });
    expect(first.released).toEqual([receiptId]);
    // TAKEN, NEVER SPELLED. A frozen literal here would be a number this row guessed about a
    // shared aggregate; what the arm actually needs is that the SECOND start moves nothing.
    const settled = versionOf(readDurableLedger(store, PROJECT_ID), previewAggregateId(GOAL_ID));

    const second = stubSupervisor(store);
    await startPreview(store, second.supervisor);
    // The SAME record, and the aggregate has NOT advanced: a second commit would move both.
    expect(autoDecisionRecord(store, receiptId)).toEqual(committed);
    expect(second.released).toEqual([]);
    expect(versionOf(readDurableLedger(store, PROJECT_ID), previewAggregateId(GOAL_ID)))
      .toBe(settled);
  });

  it("re-offers the gate on a REPLAYED start, so an opt-in installed later still closes it", async () => {
    const store = landedWorld();
    seedActiveGraph(store);
    const receiptId = receipt(store).receiptId;
    // FIRST start: the receipt exists but no policy does, so the gate correctly stays pending.
    const before = stubSupervisor(store);
    await startPreview(store, before.supervisor);
    expect(autoDecisionRecord(store, receiptId)).toBeNull();

    installOptInPolicy(store, [{ action: PREVIEW_DECIDE_COMMAND_KIND, tier: "R1" }]);
    seedPolicyRisk(store, "R0");
    const after = stubSupervisor(store);
    await startPreview(store, after.supervisor);
    // Without the replay-path call this stays null forever and only a human can close the gate.
    expect(autoDecisionRecord(store, receiptId)?.provenance)
      .toEqual({ action: PREVIEW_DECIDE_COMMAND_KIND, tier: "R0" });
    expect(after.released).toEqual([receiptId]);
  });

  /**
   * MEASURED, and it corrects this row's own brief. The brief says the preview refusal map is
   * "CLOSED AT FOUR"; at HEAD it holds FIVE — `PREVIEW_START_PAYLOAD_INVALID` was added by the
   * start row for its own decoder. This row added NONE, in either direction: the automatic path's
   * declinations are a module-local vocabulary on a surface no wire reaches.
   */
  it("mints no new preview WIRE code: the closed roster and its layers are unchanged", () => {
    expect([...PREVIEW_CODES].sort()).toEqual([
      "PREVIEW_COMMAND_MISSING", "PREVIEW_DECISION_INVALID", "PREVIEW_GOAL_NOT_LANDED",
      "PREVIEW_START_PAYLOAD_INVALID", "PREVIEW_START_TIMEOUT",
    ]);
    expect([...PREVIEW_LAYERS].sort()).toEqual(["GOAL_AUTHORITY", "REQUEST", "RUNNER"]);
  });
});

describe("a decision written at the PREVIOUS record version still decodes", () => {
  const LEGACY = Object.freeze({
    decidedAt: DECIDED_AT, decision: "APPROVE", findings: [], goalId: GOAL_ID,
    previewRef: "receipt-legacy", projectId: PROJECT_ID, sha: SHA,
    version: "moe-preview-decision/1",
  });

  it("reads a /1 record back with its FIELD VALUES and provenance null", () => {
    const record = decodePreviewDecisionRecord(LEGACY, PROJECT_ID);
    if (record === null) throw new Error("a /1 record no longer decodes: every one is orphaned");
    expect(record.decision).toBe("APPROVE");
    expect(record.goalId).toBe(GOAL_ID);
    expect(record.previewRef).toBe("receipt-legacy");
    expect(record.sha).toBe(SHA);
    expect(record.version).toBe("moe-preview-decision/1");
    // NULL is the TRUTH about a /1 record: no opt-in could have been named when it was written.
    expect(record.provenance).toBeNull();
  });

  it("reads a /2 record back with its provenance FIELD VALUES", () => {
    const record = decodePreviewDecisionRecord({
      ...LEGACY, provenance: { action: PREVIEW_DECIDE_COMMAND_KIND, tier: "R1" },
      version: "moe-preview-decision/2",
    }, PROJECT_ID);
    if (record === null) throw new Error("a /2 record does not decode");
    expect(record.decision).toBe("APPROVE");
    expect(record.provenance).toEqual({ action: PREVIEW_DECIDE_COMMAND_KIND, tier: "R1" });
    expect(record.version).toBe("moe-preview-decision/2");
  });

  it("refuses /1 BYTES carrying the /2 key roster, rather than admitting the shape they resemble", () => {
    expect(decodePreviewDecisionRecord({ ...LEGACY, provenance: null }, PROJECT_ID)).toBeNull();
  });

  it("refuses a /2 record whose provenance is present but malformed", () => {
    for (const provenance of [
      { action: PREVIEW_DECIDE_COMMAND_KIND, tier: "R9" },
      { action: PREVIEW_DECIDE_COMMAND_KIND },
      { action: "", tier: "R0" },
      "R0",
    ]) {
      expect(decodePreviewDecisionRecord(
        { ...LEGACY, provenance, version: "moe-preview-decision/2" }, PROJECT_ID,
      )).toBeNull();
    }
  });
});

describe("the SHARED WIRE CONTRACT is untouched by this row", () => {
  it("PREVIEW_APPROVE_PAYLOAD_KEYS still deep-equals ['decision','previewRef']", () => {
    expect([...PREVIEW_APPROVE_PAYLOAD_KEYS]).toEqual(["decision", "previewRef"]);
  });

  it("PREVIEW_REJECT_PAYLOAD_KEYS still deep-equals ['decision','findings','previewRef']", () => {
    expect([...PREVIEW_REJECT_PAYLOAD_KEYS]).toEqual(["decision", "findings", "previewRef"]);
  });

  /**
   * THE ARM THAT WOULD HAVE CAUGHT THE WRONG DESIGN. Carrying provenance on the WIRE would have
   * meant widening this exact-arity decoder, which rotates all four GENERATED_CONTRACT_DIGEST
   * mirrors. `provenance` is the key this row added — to the DAEMON-LOCAL record — so it is the
   * key the arm names, alongside a neutral one so the refusal is about arity, not about the word.
   */
  for (const extra of ["provenance", "findings", "somethingElse"]) {
    it(`refuses an APPROVE payload carrying an extra '${extra}' key with PREVIEW_DECISION_INVALID`, () => {
      const decoded = decodePreviewDecidePayload({
        decision: "APPROVE", previewRef: "receipt-1", [extra]: null,
      });
      expect(decoded.ok).toBe(false);
      if (decoded.ok) throw new Error("the wire decoder admitted an extra key");
      expect(decoded.code).toBe("PREVIEW_DECISION_INVALID");
      expect(decoded.layer).toBe("REQUEST");
    });
  }

  it("positive control: the exact APPROVE arity still decodes", () => {
    const decoded = decodePreviewDecidePayload({ decision: "APPROVE", previewRef: "receipt-1" });
    if (!decoded.ok) throw new Error(`the exact arity no longer decodes: ${decoded.code}`);
    expect(decoded.payload).toEqual({ decision: "APPROVE", previewRef: "receipt-1" });
  });
});

describe("the human-only fence on preview.decide is unchanged, in BOTH directions", () => {
  /**
   * THE SERVED SET IS ENUMERATED FROM THE DISPATCH SEAM, never only from the roster constant.
   * A test that iterates the roster shrinks its own iteration when an entry is deleted and stays
   * green while a served capability silently loses its fence (global rail 9).
   */
  function servedKinds(): Set<string> {
    const store = openStore();
    const ports = createDaemonCommandPorts({
      clock: (): string => DECIDED_AT, operatorPrincipalId: OPERATOR, projectId: PROJECT_ID, store,
    });
    return new Set<string>([...ports.registry.keys()]);
  }

  it("serves preview.decide, fences it to the operator, and keeps it off every MCP tool", () => {
    const served = servedKinds();
    const servedOperatorKinds = [...served]
      .filter((kind) => OPERATOR_PRINCIPAL_KINDS.has(kind as never)).sort();

    // Direction 1: nothing is fenced off MCP that the seam does not actually serve.
    expect([...MCP_EXCLUDED_COMMAND_KINDS].filter((kind) => !served.has(kind))).toStrictEqual([]);
    // Direction 2: every SERVED operator kind is off the advertised MCP roster. SET EQUALITY
    // against the exclusion list plus its one documented exception, not a subset check.
    expect(servedOperatorKinds)
      .toStrictEqual([...MCP_EXCLUDED_COMMAND_KINDS, "session.open"].sort());

    // THE SUBJECT, named on every half. The set arms above shrink with a wholesale removal;
    // these do not, so deleting the kind from either side reddens here.
    expect(served.has(PREVIEW_DECIDE_COMMAND_KIND)).toBe(true);
    expect(OPERATOR_PRINCIPAL_KINDS.has(PREVIEW_DECIDE_COMMAND_KIND)).toBe(true);
    expect(MCP_EXCLUDED_COMMAND_KINDS).toContain(PREVIEW_DECIDE_COMMAND_KIND);
    expect(wiredMcpToolKinds()).not.toContain(PREVIEW_DECIDE_COMMAND_KIND);
  });

  /**
   * THE AUTOMATIC PATH ADDS NO WIRE AND NO SEAT. It is reachable only by calling into the daemon's
   * own start handler, so the roster this row could have grown did not grow: the served set is
   * exactly what it was, and no `preview.auto*` kind exists on any surface.
   */
  it("adds no new served command kind for the automatic decision", () => {
    expect([...servedKinds()].filter((kind) => kind.startsWith("preview."))).toStrictEqual(
      [PREVIEW_DECIDE_COMMAND_KIND, "preview.start"].sort(),
    );
  });
});
