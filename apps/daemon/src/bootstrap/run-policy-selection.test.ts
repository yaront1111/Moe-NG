/**
 * Run-scoped selection of the ONE `PolicyEvaluated` the finalize leg wrote for a given run.
 *
 * Three disciplines this suite holds itself to:
 *
 * 1. EVERY SEEDED ROW IS A PRODUCTION PAYLOAD. Rows are built by running the production
 *    `evaluateRunPolicy` and committing exactly the bytes the production leg would commit
 *    (`run-policy-leg.ts:88-91`). Nothing here hand-assembles an evaluation, so an arm cannot
 *    pass against a shape production never writes.
 * 2. EVERY REFUSAL ARM ASSERTS CODE AND LAYER. "It refused" is one added fence away from
 *    vacuous; the pair names WHICH mechanism answered. The UNVERIFIED arm additionally asserts
 *    the strict reader's own code+layer arrives VERBATIM as `upstream` rather than restamped.
 * 3. THE RUN-LINKAGE ARM IS A DIVERGENCE FIXTURE, not a reachability one. Selecting by aggregate
 *    id makes "ask for A, get A" nearly tautological, so the arm that carries the weight files
 *    run B's OWN, fully replay-verifiable row on run A's aggregate: the strict reader accepts it
 *    (it is internally honest), and the selector's linkage check is then the ONLY mechanism that
 *    can refuse it. Loosen that check and this arm is the one that reds.
 */
import { derivePolicySliceDigest } from "@moe/core";
import { decodeGraphContent, deriveNodePropertyFactIds } from "@moe/scheduler";
import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { readDurableLedger, versionOf } from "./bootstrap-ledger.js";
import {
  PROJECT_ID,
  RUN_ID,
  SEALED_GRAPH_CONTENT_BYTES,
  SEALED_GRAPH_CONTENT_HASH,
  closeStores,
  driveThrough,
  envelope,
  openStore,
  send,
} from "./bootstrap-test-fixtures.js";
import { RUN_POLICY_SELECTION_CODES, readRunPolicyEvaluation } from "./run-policy-selection.js";
import { putGraphBody } from "../planning/graph-body-record.js";
import { evaluateRunPolicy } from "../planning/run-policy-evaluation.js";
import { RUN_POLICY_EVENT_TYPE, runPolicyAggregateId } from "../planning/run-policy-record.js";

const DECIDED_AT = "2026-08-08T00:00:00.000Z";
const PRINCIPAL_ID = "principal-1";
const OTHER_RUN_ID = `${RUN_ID}-other`;
const SELECTION_LAYER = "DAEMON_RUN_POLICY_SELECTION";
const AUTHORITY_LAYER = "DAEMON_POLICY_AUTHORITY";

const encoder = new TextEncoder();

/** A store carrying the full bootstrap policy state plus the journey graph's durable body. */
function seededStore(): SqliteEventStore {
  const store = openStore();
  driveThrough(store, "project.activate");
  const decoded = decodeGraphContent(
    Uint8Array.from(Buffer.from(SEALED_GRAPH_CONTENT_BYTES, "base64")),
  );
  if (!decoded.ok) throw new Error("the journey graph must decode");
  const put = putGraphBody(store, PROJECT_ID, decoded.value);
  if (!put.ok) throw new Error(`the journey body must store: ${put.code}`);
  return store;
}

/** Runs the PRODUCTION evaluator for `runId` and hands back its row and the tier it derived. */
function evaluate(
  store: SqliteEventStore, runId: string,
): { readonly computedTier: string; readonly payload: unknown } {
  const result = evaluateRunPolicy(store, readDurableLedger(store, PROJECT_ID), {
    decidedAt: DECIDED_AT,
    graphContentHash: SEALED_GRAPH_CONTENT_HASH,
    principalId: PRINCIPAL_ID,
    projectId: PROJECT_ID,
    runId,
  });
  if (!result.ok) throw new Error(`the fixture evaluation refused ${result.code}@${result.layer}`);
  return { computedTier: result.computedTier, payload: result.payload };
}

/**
 * Commits `bytes` on `aggregateId` exactly as the production leg does — same event type, same
 * expected-version read. `eventId` varies so a second row on one aggregate is committable.
 */
function commitRow(
  store: SqliteEventStore, aggregateId: string, eventId: string, bytes: Uint8Array,
): void {
  const response = store.commitExpectedVersionDecisionLegs({
    commandKind: "plan.finalize",
    committedResultBytes: encoder.encode("{}"),
    correlationId: `correlation-${eventId}`,
    decidedAt: DECIDED_AT,
    key: { commandId: `command-${eventId}`, principalId: PRINCIPAL_ID, projectId: PROJECT_ID },
    legs: [{
      aggregateId,
      events: [{ eventId, eventType: RUN_POLICY_EVENT_TYPE, payload: bytes }],
      expectedVersion: store.getAggregateVersion(aggregateId),
    }],
    requestBytes: encoder.encode("plan.finalize/v1"),
  });
  // The decision's own result code, not a truthiness check: a fence conflict returns a
  // NO_BUSINESS_EFFECT decision, and a fixture that silently wrote nothing would make every
  // arm below assert against an empty aggregate.
  if (response.decision.resultCode !== "EFFECTS_COMMITTED") {
    throw new Error(`the fixture commit refused: ${response.decision.resultCode}`);
  }
}

/** Seeds `runId`'s honest row on ITS OWN aggregate and returns the tier production derived. */
function seedRun(store: SqliteEventStore, runId: string): string {
  const { computedTier, payload } = evaluate(store, runId);
  commitRow(
    store, runPolicyAggregateId(runId), `${runId}-row`,
    encoder.encode(JSON.stringify(payload)),
  );
  return computedTier;
}

/** The journey graph's node-property fact ids, taken from the PRODUCTION derivation. */
function journeyFactIds(): readonly string[] {
  const decoded = decodeGraphContent(
    Uint8Array.from(Buffer.from(SEALED_GRAPH_CONTENT_BYTES, "base64")),
  );
  if (!decoded.ok) throw new Error("the journey graph must decode");
  const ids = new Set<string>();
  for (const definition of decoded.value.content.nodeAuthority.definitions) {
    const derived = deriveNodePropertyFactIds(definition);
    if (!derived.ok) throw new Error("the journey node must admit");
    for (const factId of derived.factIds) ids.add(factId);
  }
  // NON-VACUITY: a sweep yielding zero fact ids would install a slice classifying nothing, and
  // the reclassification arm below would then be measuring an unchanged fixture.
  expect(ids.size).toBeGreaterThan(0);
  return [...ids].sort();
}

/**
 * Installs a slice classifying the journey's OWN fact ids at `tier`, so a later evaluation of
 * the same graph derives a different tier. The expected version is READ rather than spelled, so
 * an added bootstrap command cannot silently turn this into a stale-version arm.
 */
function installSlice(store: SqliteEventStore, tier: string, commandId: string): void {
  const expectedVersion = versionOf(readDurableLedger(store, PROJECT_ID), `${PROJECT_ID}-policy`);
  const body = {
    autoApprovalOptIns: [],
    riskClassifications: journeyFactIds().map((factId) => ({ factId, tier })),
    rules: [],
  };
  const digest = derivePolicySliceDigest({ ...body, sliceRef: "pending" });
  if (!digest.ok) throw new Error("the arm's slice must digest");
  const outcome = send(store, envelope(
    "policy.install", expectedVersion, { slice: { ...body, sliceRef: digest.digest } }, commandId,
  ));
  if (!outcome.ok) throw new Error(`the arm's install refused: ${outcome.code}`);
}

describe("readRunPolicyEvaluation — the run's own evaluation, never the newest", () => {
  afterEach(() => {
    closeStores();
  });

  it("answers the run's row with its replay-verified tier and linkage", () => {
    const store = seededStore();
    const expectedTier = seedRun(store, RUN_ID);

    const selected = readRunPolicyEvaluation(store, { projectId: PROJECT_ID, runId: RUN_ID });

    if (!selected.ok) throw new Error(`refused ${selected.code}@${selected.layer}`);
    // PRODUCTION-vs-PRODUCTION: the expected tier is what the production evaluator derived in
    // this file, never a spelled "R2" that both sides could drift away from together.
    expect(selected.evaluation.riskTier).toBe(expectedTier);
    expect(selected.evaluation.runId).toBe(RUN_ID);
    expect(selected.evaluation.projectId).toBe(PROJECT_ID);
  });

  it("refuses when no evaluation exists for the run", () => {
    const store = seededStore();
    seedRun(store, OTHER_RUN_ID);

    const selected = readRunPolicyEvaluation(store, { projectId: PROJECT_ID, runId: RUN_ID });

    expect(selected.ok).toBe(false);
    if (selected.ok) throw new Error("an unevaluated run must not select");
    expect([selected.code, selected.layer])
      .toStrictEqual(["RUN_POLICY_SELECTION_ABSENT", SELECTION_LAYER]);
  });

  it("refuses ambiguity rather than picking either claimant", () => {
    const store = seededStore();
    const { payload } = evaluate(store, RUN_ID);
    const bytes = encoder.encode(JSON.stringify(payload));
    const aggregateId = runPolicyAggregateId(RUN_ID);
    commitRow(store, aggregateId, "first-row", bytes);
    commitRow(store, aggregateId, "second-row", bytes);

    const selected = readRunPolicyEvaluation(store, { projectId: PROJECT_ID, runId: RUN_ID });

    expect(selected.ok).toBe(false);
    if (selected.ok) throw new Error("two claimants must not resolve to one");
    expect([selected.code, selected.layer])
      .toStrictEqual(["RUN_POLICY_SELECTION_AMBIGUOUS", SELECTION_LAYER]);
  });

  it("carries the strict reader's refusal verbatim rather than restamping it", () => {
    const store = seededStore();
    const { payload } = evaluate(store, RUN_ID);
    // A well-formed assessment that is simply NOT the one the row's own evidence replays to.
    const tampered = {
      ...payload as Record<string, unknown>,
      riskAssessment: { callerRiskHint: null, computedTier: "R0", effectiveTier: "R0", usedFactIds: [] },
    };
    commitRow(
      store, runPolicyAggregateId(RUN_ID), "tampered-row",
      encoder.encode(JSON.stringify(tampered)),
    );

    const selected = readRunPolicyEvaluation(store, { projectId: PROJECT_ID, runId: RUN_ID });

    expect(selected.ok).toBe(false);
    if (selected.ok) throw new Error("an unverified row must not select");
    expect([selected.code, selected.layer])
      .toStrictEqual(["RUN_POLICY_SELECTION_UNVERIFIED", SELECTION_LAYER]);
    // VERBATIM, not restamped: the answering authority's own diagnosis survives the hop.
    expect(selected.upstream)
      .toStrictEqual({ code: "POLICY_AUTHORITY_RUN_LINKAGE_MISMATCH", layer: AUTHORITY_LAYER });
  });

  it("refuses a foreign run's row filed on this run's aggregate", () => {
    const store = seededStore();
    // Run B's OWN honest row — internally consistent, so the strict reader ACCEPTS it. Filed on
    // run A's aggregate, it can only be refused by the selector's linkage check.
    const { payload } = evaluate(store, OTHER_RUN_ID);
    commitRow(
      store, runPolicyAggregateId(RUN_ID), "misfiled-row",
      encoder.encode(JSON.stringify(payload)),
    );

    const selected = readRunPolicyEvaluation(store, { projectId: PROJECT_ID, runId: RUN_ID });

    expect(selected.ok).toBe(false);
    if (selected.ok) throw new Error("a foreign run's evaluation must never be selected");
    expect([selected.code, selected.layer])
      .toStrictEqual(["RUN_POLICY_SELECTION_RUN_MISMATCH", SELECTION_LAYER]);
  });

  it("refuses an undecodable row rather than reading it as absent", () => {
    const store = seededStore();
    commitRow(
      store, runPolicyAggregateId(RUN_ID), "unreadable-row", encoder.encode("not json at all"),
    );

    const selected = readRunPolicyEvaluation(store, { projectId: PROJECT_ID, runId: RUN_ID });

    expect(selected.ok).toBe(false);
    if (selected.ok) throw new Error("an undecodable row must not select");
    // A DISTINCT code from ABSENT on purpose: a row that exists and cannot be read is a
    // different operator problem from a run that was never evaluated, and collapsing them would
    // let a corrupt row read as "not evaluated yet".
    expect([selected.code, selected.layer])
      .toStrictEqual(["RUN_POLICY_SELECTION_ROW_UNREADABLE", SELECTION_LAYER]);
  });

  /**
   * BIDIRECTIONAL ROSTER CHECK. Every advertised code is PRODUCED by a real refusal, and every
   * refusal this module can produce is advertised. Enumerating only the constant would pass for
   * a code nothing emits; enumerating only the outcomes would pass for a code the roster forgot.
   * The served set is collected from PRODUCTION outcomes, never from the constant it is compared
   * against, so no single edit moves both sides.
   */
  it("advertises exactly the codes its refusals actually produce", () => {
    const served = new Set<string>();
    const drive = (seed: (store: SqliteEventStore) => void, runId = RUN_ID): void => {
      const store = seededStore();
      seed(store);
      const selected = readRunPolicyEvaluation(store, { projectId: PROJECT_ID, runId });
      if (!selected.ok) served.add(selected.code);
    };
    const bytesFor = (store: SqliteEventStore, runId: string): Uint8Array =>
      encoder.encode(JSON.stringify(evaluate(store, runId).payload));

    drive(() => undefined);
    drive((store) => {
      const aggregateId = runPolicyAggregateId(RUN_ID);
      commitRow(store, aggregateId, "roster-a", bytesFor(store, RUN_ID));
      commitRow(store, aggregateId, "roster-b", bytesFor(store, RUN_ID));
    });
    drive((store) => commitRow(
      store, runPolicyAggregateId(RUN_ID), "roster-unreadable", encoder.encode("nope"),
    ));
    drive((store) => commitRow(
      store, runPolicyAggregateId(RUN_ID), "roster-misfiled", bytesFor(store, OTHER_RUN_ID),
    ));
    drive((store) => {
      const { payload } = evaluate(store, RUN_ID);
      const tampered = {
        ...payload as Record<string, unknown>,
        riskAssessment: {
          callerRiskHint: null, computedTier: "R0", effectiveTier: "R0", usedFactIds: [],
        },
      };
      commitRow(
        store, runPolicyAggregateId(RUN_ID), "roster-tampered",
        encoder.encode(JSON.stringify(tampered)),
      );
    });

    expect([...served].sort()).toStrictEqual([...RUN_POLICY_SELECTION_CODES].sort());
  });

  it("never returns a newer evaluation belonging to a different run", () => {
    const store = seededStore();
    const expectedTier = seedRun(store, RUN_ID);
    // A LATER install gives run B a different tier, so a recency-keyed selector cannot alias
    // its way to a passing assertion.
    installSlice(store, "R3", "cmd-reclassify");
    const otherTier = seedRun(store, OTHER_RUN_ID);
    // NON-VACUITY: if the two tiers ever coincide this arm proves nothing, so it says so.
    expect(otherTier).not.toBe(expectedTier);

    const selected = readRunPolicyEvaluation(store, { projectId: PROJECT_ID, runId: RUN_ID });

    if (!selected.ok) throw new Error(`refused ${selected.code}@${selected.layer}`);
    expect(selected.evaluation.riskTier).toBe(expectedTier);
    expect(selected.evaluation.runId).toBe(RUN_ID);
  });
});
