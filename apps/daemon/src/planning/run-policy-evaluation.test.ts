/**
 * The run-scoped policy evaluation, driven over a REAL store seeded by the shipped bootstrap
 * sequence and the production graph-body writer.
 *
 * Two disciplines this suite holds itself to:
 *
 * 1. THE EXPECTED TIER IS NOT A LITERAL. It is re-derived by running the production
 *    `evaluatePolicy` a SECOND time, in this file, over facts this file assembles from the
 *    production `deriveNodePropertyFactIds`. Both sides are the production evaluator; only the
 *    COMPOSITION differs, so a module that hard-coded `R2` would still have to explain why the
 *    independently-composed run agrees.
 * 2. EVERY REFUSAL ARM ASSERTS CODE AND LAYER. "It refused" is one added fence away from
 *    vacuous; the pair names WHICH mechanism answered.
 */
import { derivePolicySliceDigest, evaluatePolicy } from "@moe/core";
import { decodeGraphContent, deriveNodePropertyFactIds } from "@moe/scheduler";
import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import type { JsonValue } from "@moe/contracts";

import { readPolicyEvaluationAuthority } from "../bootstrap/bootstrap-policy-authority-reader.js";
import { readDurableLedger, versionOf } from "../bootstrap/bootstrap-ledger.js";
import {
  CLASSIFYING_POLICY_REF,
  PROJECT_ID,
  RUN_ID,
  SEALED_GRAPH_CONTENT_BYTES,
  SEALED_GRAPH_CONTENT_HASH,
  closeStores,
  driveThrough,
  envelope,
  openStore,
  send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { putGraphBody } from "./graph-body-record.js";
import {
  RUN_POLICY_ACTION,
  captureStableRunPolicySelection,
  evaluateRunPolicy,
  evaluateRunPolicyContent,
  runPolicyAggregateId,
} from "./run-policy-evaluation.js";

const DECIDED_AT = "2026-08-08T00:00:00.000Z";
const PRINCIPAL_ID = "principal-1";

const runInput = () => ({
  decidedAt: DECIDED_AT,
  graphContentHash: SEALED_GRAPH_CONTENT_HASH,
  principalId: PRINCIPAL_ID,
  projectId: PROJECT_ID,
  runId: RUN_ID,
});

/** The journey graph's four node-property fact ids, taken from the PRODUCTION derivation. */
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
  // NON-VACUITY: a sweep that yields zero fact ids would make every arm below assert nothing.
  expect(ids.size).toBeGreaterThan(0);
  return [...ids].sort();
}

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

const evaluate = (store: SqliteEventStore) => evaluateRunPolicy(
  store, readDurableLedger(store, PROJECT_ID), runInput(),
);

/**
 * Installs a slice whose classification table is exactly `entries`, at its own digest, so it
 * becomes the newest installed evaluation slice. The expected version is READ rather than
 * spelled, so an added bootstrap command cannot silently turn this into a stale-version arm.
 */
function installSlice(
  store: SqliteEventStore,
  entries: readonly { readonly factId: string; readonly tier: string }[],
  commandId: string,
): void {
  const expectedVersion = versionOf(readDurableLedger(store, PROJECT_ID), `${PROJECT_ID}-policy`);
  const body = { autoApprovalOptIns: [], riskClassifications: entries, rules: [] };
  const digest = derivePolicySliceDigest({ ...body, sliceRef: "pending" });
  if (!digest.ok) throw new Error("the arm's slice must digest");
  const outcome = send(store, envelope(
    "policy.install", expectedVersion,
    { slice: { ...body, sliceRef: digest.digest } }, commandId,
  ));
  if (!outcome.ok) throw new Error(`the arm's install refused: ${outcome.code}`);
}

function installNonEvaluationArtifact(store: SqliteEventStore, commandId: string): void {
  const expectedVersion = versionOf(readDurableLedger(store, PROJECT_ID), `${PROJECT_ID}-policy`);
  const outcome = send(store, envelope(
    "policy.install", expectedVersion,
    { slice: { calibration: "unchanged-selection", sliceRef: "reviewer-calibration" } },
    commandId,
  ));
  if (!outcome.ok) throw new Error(`the artifact install refused: ${outcome.code}`);
}

describe("evaluateRunPolicy — the daemon's own run tier", () => {
  afterEach(() => {
    closeStores();
  });

  it("computes the tier the production evaluator derives for the sealed nodes", () => {
    const store = seededStore();
    const result = evaluate(store);
    if (!result.ok) throw new Error(`refused ${result.code}@${result.layer}`);

    // INDEPENDENT re-derivation: this arm assembles the facts and the chain itself and runs the
    // production evaluator over them, so the module's answer is graded against the evaluator
    // rather than against a literal this file also chose.
    const factIds = journeyFactIds();
    const installed = readDurableLedger(store, PROJECT_ID)
      .aggregates.get(`${PROJECT_ID}-policy`)?.result as { slices: Record<string, unknown> };
    const slice = installed.slices[CLASSIFYING_POLICY_REF];
    const independent = evaluatePolicy({
      action: RUN_POLICY_ACTION,
      actor: PRINCIPAL_ID,
      callerRiskHint: null,
      decisionDigest: "0".repeat(64),
      evaluatedAtEpochMs: Date.parse(DECIDED_AT),
      evaluatorVersion: "moe-policy-evaluator/1",
      facts: factIds.map((factId) => ({ factId, tier: null, truthClass: "DAEMON_VERIFIED" })),
      graphNodeRevisionRefs: [SEALED_GRAPH_CONTENT_HASH],
      policyRevisionRef: CLASSIFYING_POLICY_REF,
      requiredFactIds: [],
      scope: ["node-a"],
      sliceChain: [slice],
      waivers: [],
    });
    if (!independent.ok) throw new Error("the independent evaluation must accept");
    expect(independent.record.riskAssessment.computedTier).not.toBeNull();
    expect(result.computedTier).toBe(independent.record.riskAssessment.computedTier);
    expect(result.aggregateId).toBe(runPolicyAggregateId(RUN_ID));
  });

  it("captures the selected slice with the exact durable policy fence", () => {
    const store = seededStore();
    const ledger = readDurableLedger(store, PROJECT_ID);

    const captured = captureStableRunPolicySelection(store, ledger, PROJECT_ID);

    if (!captured.ok) throw new Error(`selection refused ${captured.reason}`);
    expect(captured.selection.sliceRef).toBe(CLASSIFYING_POLICY_REF);
    expect(captured.selection.fence).toStrictEqual({
      aggregateId: `${PROJECT_ID}-policy`,
      expectedVersion: versionOf(ledger, `${PROJECT_ID}-policy`),
    });
  });

  it("refuses a stale ledger even when the selected slice bytes stay identical", () => {
    const store = seededStore();
    const priorLedger = readDurableLedger(store, PROJECT_ID);
    const prior = captureStableRunPolicySelection(store, priorLedger, PROJECT_ID);
    if (!prior.ok) throw new Error(`prior selection refused ${prior.reason}`);
    installNonEvaluationArtifact(store, "cmd-policy-artifact");

    const stale = captureStableRunPolicySelection(store, priorLedger, PROJECT_ID);
    const current = captureStableRunPolicySelection(
      store, readDurableLedger(store, PROJECT_ID), PROJECT_ID,
    );

    expect(stale).toStrictEqual({ ok: false, reason: "VERSION_DRIFT" });
    if (!current.ok) throw new Error(`current selection refused ${current.reason}`);
    expect(current.selection.sliceRef).toBe(prior.selection.sliceRef);
    expect(JSON.stringify(current.selection.slice)).toBe(JSON.stringify(prior.selection.slice));
  });

  it("refuses when the policy aggregate moves between its two version reads", () => {
    const store = seededStore();
    const ledger = readDurableLedger(store, PROJECT_ID);
    const version = versionOf(ledger, `${PROJECT_ID}-policy`);
    let reads = 0;
    const drifting = {
      getAggregateVersion: () => reads++ === 0 ? version : version + 1,
    };

    const captured = captureStableRunPolicySelection(drifting, ledger, PROJECT_ID);

    expect(reads).toBe(2);
    expect(captured).toStrictEqual({ ok: false, reason: "VERSION_DRIFT" });
  });

  it("keeps exact payload parity between persisted-body and direct-content evaluation", () => {
    const store = seededStore();
    const ledger = readDurableLedger(store, PROJECT_ID);
    const persisted = evaluateRunPolicy(store, ledger, runInput());
    const decoded = decodeGraphContent(
      Uint8Array.from(Buffer.from(SEALED_GRAPH_CONTENT_BYTES, "base64")),
    );
    if (!decoded.ok) throw new Error("the journey graph must decode");
    const selection = captureStableRunPolicySelection(store, ledger, PROJECT_ID);

    const direct = evaluateRunPolicyContent(decoded.value.content, selection, runInput());

    if (!persisted.ok || !direct.ok) throw new Error("both paths must evaluate");
    expect(JSON.stringify(direct.payload)).toBe(JSON.stringify(persisted.payload));
    expect(direct.computedTier).toBe(persisted.computedTier);
  });

  it("refuses direct content whose durable graph identity names different bytes", () => {
    const store = seededStore();
    const ledger = readDurableLedger(store, PROJECT_ID);
    const decoded = decodeGraphContent(
      Uint8Array.from(Buffer.from(SEALED_GRAPH_CONTENT_BYTES, "base64")),
    );
    if (!decoded.ok) throw new Error("the journey graph must decode");
    const foreignHash = "f".repeat(64) === SEALED_GRAPH_CONTENT_HASH
      ? "e".repeat(64) : "f".repeat(64);

    const direct = evaluateRunPolicyContent(
      decoded.value.content,
      captureStableRunPolicySelection(store, ledger, PROJECT_ID),
      { ...runInput(), graphContentHash: foreignHash },
    );

    expect(direct.ok).toBe(false);
    if (direct.ok) throw new Error("foreign graph identity must not evaluate");
    expect([direct.code, direct.layer, direct.factIds]).toStrictEqual([
      "RUN_POLICY_INPUT_INVALID", "DAEMON_RUN_POLICY", [],
    ]);
  });

  it("refuses a selected policy captured from another project aggregate", () => {
    const store = seededStore();
    const ledger = readDurableLedger(store, PROJECT_ID);
    const decoded = decodeGraphContent(
      Uint8Array.from(Buffer.from(SEALED_GRAPH_CONTENT_BYTES, "base64")),
    );
    if (!decoded.ok) throw new Error("the journey graph must decode");

    const direct = evaluateRunPolicyContent(
      decoded.value.content,
      captureStableRunPolicySelection(store, ledger, PROJECT_ID),
      { ...runInput(), projectId: "foreign-project" },
    );

    expect(direct.ok).toBe(false);
    if (direct.ok) throw new Error("foreign project policy must not evaluate");
    expect([direct.code, direct.layer]).toStrictEqual([
      "RUN_POLICY_INPUT_INVALID", "DAEMON_RUN_POLICY",
    ]);
  });

  it("refuses selected policy bytes that no longer match their durable slice ref", () => {
    const store = seededStore();
    const ledger = readDurableLedger(store, PROJECT_ID);
    const decoded = decodeGraphContent(
      Uint8Array.from(Buffer.from(SEALED_GRAPH_CONTENT_BYTES, "base64")),
    );
    if (!decoded.ok) throw new Error("the journey graph must decode");
    const captured = captureStableRunPolicySelection(store, ledger, PROJECT_ID);
    if (!captured.ok) throw new Error(`selection refused ${captured.reason}`);
    const slice = captured.selection.slice as Readonly<Record<string, JsonValue>>;
    const drifted = {
      ok: true as const,
      selection: {
        ...captured.selection,
        slice: {
          ...slice,
          riskClassifications: journeyFactIds().map((factId) => ({ factId, tier: "R0" })),
        },
      },
    };

    const direct = evaluateRunPolicyContent(decoded.value.content, drifted, runInput());

    expect(direct.ok).toBe(false);
    if (direct.ok) throw new Error("drifted policy bytes must not evaluate");
    expect([direct.code, direct.layer]).toStrictEqual([
      "RUN_POLICY_INPUT_INVALID", "DAEMON_RUN_POLICY",
    ]);
  });

  it("maps an unstable policy selection to the exact fail-closed evaluation refusal", () => {
    const decoded = decodeGraphContent(
      Uint8Array.from(Buffer.from(SEALED_GRAPH_CONTENT_BYTES, "base64")),
    );
    if (!decoded.ok) throw new Error("the journey graph must decode");

    const direct = evaluateRunPolicyContent(
      decoded.value.content, { ok: false, reason: "VERSION_DRIFT" }, runInput(),
    );

    expect(direct.ok).toBe(false);
    if (direct.ok) throw new Error("an unstable selection must not evaluate");
    expect([direct.code, direct.layer]).toStrictEqual([
      "RUN_POLICY_INPUT_INVALID", "DAEMON_RUN_POLICY",
    ]);
    expect(direct.factIds).toStrictEqual(journeyFactIds());
  });

  it("refuses a proxied direct-content definition roster without invoking it as authority", () => {
    const store = seededStore();
    const ledger = readDurableLedger(store, PROJECT_ID);
    const decoded = decodeGraphContent(
      Uint8Array.from(Buffer.from(SEALED_GRAPH_CONTENT_BYTES, "base64")),
    );
    if (!decoded.ok) throw new Error("the journey graph must decode");
    const definitions = new Proxy(
      [...decoded.value.content.nodeAuthority.definitions], {},
    );
    const hostile = {
      ...decoded.value.content,
      nodeAuthority: { ...decoded.value.content.nodeAuthority, definitions },
    } as typeof decoded.value.content;

    const direct = evaluateRunPolicyContent(
      hostile, captureStableRunPolicySelection(store, ledger, PROJECT_ID), runInput(),
    );

    expect(direct.ok).toBe(false);
    if (direct.ok) throw new Error("a proxied roster must not evaluate");
    expect([direct.code, direct.layer, direct.factIds]).toStrictEqual([
      "RUN_POLICY_NODE_UNADMITTED", "DAEMON_RUN_POLICY", [],
    ]);
  });

  it("derives the refs and the scope from the sealed body, never from a caller", () => {
    const store = seededStore();
    const result = evaluate(store);
    if (!result.ok) throw new Error(`refused ${result.code}@${result.layer}`);
    const material = result.payload["decisionMaterial"] as Record<string, unknown>;
    const input = material["verifiedInput"] as Record<string, unknown>;

    expect(result.payload["graphNodeRevisionRefs"]).toStrictEqual([SEALED_GRAPH_CONTENT_HASH]);
    expect(input["graphNodeRevisionRefs"]).toStrictEqual([SEALED_GRAPH_CONTENT_HASH]);
    expect(input["scope"]).toStrictEqual(["node-a"]);
    expect(input["callerRiskHint"]).toBeNull();
    expect(input["action"]).toBe(RUN_POLICY_ACTION);
    expect((input["facts"] as { truthClass: string }[]).map((fact) => fact.truthClass))
      .toStrictEqual(journeyFactIds().map(() => "DAEMON_VERIFIED"));
    expect((input["facts"] as { factId: string }[]).map((fact) => fact.factId))
      .toStrictEqual(journeyFactIds());
    // Every fact enters tier-less: the tier is the POLICY's, never this module's.
    expect((input["facts"] as { tier: unknown }[]).every((fact) => fact.tier === null)).toBe(true);
    expect(result.payload["runId"]).toBe(RUN_ID);
  });

  it("refuses UNCLASSIFIABLE with its own code and layer when the newest slice classifies none",
    () => {
      const store = seededStore();
      // A policy that classifies SOMETHING — just nothing this run states. That keeps the arm
      // about coverage rather than about an empty table, and an empty table would in any case
      // digest to the already-installed slice's address and be refused one layer earlier.
      installSlice(store, [{ factId: "node.capability:unrelated", tier: "R3" }], "cmd-unrelated");
      const result = evaluate(store);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("an unclassified run must not evaluate");
      expect(result.code).toBe("RUN_POLICY_UNCLASSIFIABLE");
      expect(result.layer).toBe("DAEMON_RUN_POLICY");
      expect(result.factIds).toStrictEqual(journeyFactIds());
      const decoded = decodeGraphContent(
        Uint8Array.from(Buffer.from(SEALED_GRAPH_CONTENT_BYTES, "base64")),
      );
      if (!decoded.ok) throw new Error("the journey graph must decode");
      const ledger = readDurableLedger(store, PROJECT_ID);
      const direct = evaluateRunPolicyContent(
        decoded.value.content,
        captureStableRunPolicySelection(store, ledger, PROJECT_ID),
        runInput(),
      );
      expect(direct).toStrictEqual(result);
    });

  it("DIVERGES on the classification alone: the same run, one table apart", () => {
    const factIds = journeyFactIds();

    // One degree of freedom. Both stores are byte-identical in every respect the evaluation
    // reads — same sealed graph, same bootstrap state, same newest-install position — and differ
    // only in whether the newest table names THIS run's fact ids.
    const covered = seededStore();
    installSlice(covered, factIds.map((factId) => ({ factId, tier: "R1" })), "cmd-covered");
    const withTier = evaluate(covered);
    if (!withTier.ok) throw new Error(`the covered run must evaluate: ${withTier.code}`);
    expect(withTier.computedTier).toBe("R1");

    const uncovered = seededStore();
    installSlice(
      uncovered, factIds.map((factId) => ({ factId: `${factId}-other`, tier: "R1" })),
      "cmd-uncovered",
    );
    const withoutTier = evaluate(uncovered);
    expect(withoutTier.ok).toBe(false);
    if (withoutTier.ok) throw new Error("the uncovered run must refuse");
    expect(withoutTier.code).toBe("RUN_POLICY_UNCLASSIFIABLE");
  });

  it("takes the MAX of the classified tiers rather than the first or the last", () => {
    const factIds = journeyFactIds();
    const store = seededStore();
    // Descending, so a module reading the LAST entry would answer R0 and a module reading the
    // FIRST would answer R3 only by accident of order; only a max over the set answers R3 here.
    installSlice(store, factIds.map((factId, index) => ({
      factId, tier: ["R3", "R2", "R1", "R0"][index % 4] as string,
    })), "cmd-max");
    const result = evaluate(store);
    if (!result.ok) throw new Error(`refused ${result.code}`);
    expect(result.computedTier).toBe("R3");
  });

  it("refuses when the project has installed no evaluation slice at all", () => {
    const store = openStore();
    send(store, envelope("project.register", 0, { owner: "owner-1" }));
    const decoded = decodeGraphContent(
      Uint8Array.from(Buffer.from(SEALED_GRAPH_CONTENT_BYTES, "base64")),
    );
    if (!decoded.ok) throw new Error("the journey graph must decode");
    putGraphBody(store, PROJECT_ID, decoded.value);
    const result = evaluate(store);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("a policy-less project must not evaluate");
    expect(result.code).toBe("RUN_POLICY_POLICY_ABSENT");
    expect(result.layer).toBe("DAEMON_RUN_POLICY");
  });

  it("refuses when the sealed body is not durable, naming the graph and not the policy", () => {
    const store = openStore();
    driveThrough(store, "project.activate");
    const result = evaluate(store);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("a body-less run must not evaluate");
    expect(result.code).toBe("RUN_POLICY_GRAPH_UNAVAILABLE");
    expect(result.layer).toBe("DAEMON_RUN_POLICY");
  });

  it("is deterministic: the same sealed content twice yields the same record bytes", () => {
    const first = evaluate(seededStore());
    const second = evaluate(seededStore());
    if (!first.ok || !second.ok) throw new Error("both evaluations must accept");
    expect(JSON.stringify(second.payload)).toBe(JSON.stringify(first.payload));
    expect(second.payload["decisionDigest"]).toBe(first.payload["decisionDigest"]);
  });
});

/**
 * BOTH ROW SHAPES THROUGH ONE STRICT READER.
 *
 * The run-scoped row widens `PolicyEvaluated` from eight keys to eleven. `exactObject` compares
 * `Reflect.ownKeys().length` against a roster, so admitting the pair means exactly eight OR
 * exactly eleven — these arms pin both directions, plus the three ways an eleven-key row can lie.
 *
 * Deliberately NOT in `bootstrap-services.test.ts`: that suite is the caller-driven
 * `policy.validate` path, and leaving it unedited is itself the evidence that this row did not
 * touch it. The legacy operand below is minted by the PRODUCTION `policy.validate` handler here
 * instead, so the arm still grades a real row rather than a hand-built lookalike.
 */
describe("the strict reader admits exactly two PolicyEvaluated shapes", () => {
  afterEach(() => {
    closeStores();
  });

  /** The caller-driven row the shipped bootstrap sequence's `policy.validate` writes. */
  function legacyRow(store: SqliteEventStore): { payload: JsonValue; committedAt: string } {
    const rows = store.readEvents(`${PROJECT_ID}-policy`)
      .filter((event) => event.eventType === "PolicyEvaluated");
    const only = rows[rows.length - 1];
    if (only === undefined) throw new Error("the sequence wrote no caller-driven row");
    return {
      committedAt: only.committedAt,
      payload: JSON.parse(new TextDecoder().decode(only.payload)) as JsonValue,
    };
  }

  it("reads a caller-driven row exactly as before, with no run linkage", () => {
    const store = openStore();
    driveThrough(store, "project.activate");
    const row = legacyRow(store);
    expect(Object.keys(row.payload as object).sort()).toStrictEqual([
      "decision", "decisionDigest", "decisionDigestVersion", "decisionMaterial", "policyRef",
      "principalId", "projectId", "sliceRef",
    ]);
    const authority = readPolicyEvaluationAuthority(
      row.payload, PROJECT_ID, Date.parse(row.committedAt),
    );
    if (!authority.ok) throw new Error(`the legacy row stopped reading: ${authority.code}`);
    expect(authority.runId).toBeNull();
    expect(authority.riskTier).toBeNull();
  });

  it("reads a run-scoped row with its linkage and its tier", () => {
    const store = seededStore();
    const result = evaluate(store);
    if (!result.ok) throw new Error(`refused ${result.code}`);
    expect(Object.keys(result.payload).sort()).toStrictEqual([
      "decision", "decisionDigest", "decisionDigestVersion", "decisionMaterial",
      "graphNodeRevisionRefs", "policyRef", "principalId", "projectId", "riskAssessment",
      "runId", "sliceRef",
    ]);
    const authority = readPolicyEvaluationAuthority(
      result.payload as JsonValue, PROJECT_ID, Date.parse(DECIDED_AT),
    );
    if (!authority.ok) throw new Error(`the run row did not read: ${authority.code}`);
    expect(authority.runId).toBe(RUN_ID);
    expect(authority.riskTier).toBe(result.computedTier);
  });

  /** One tamper per arm, each asserting the code that names WHICH check answered. */
  it.each([
    ["a dropped runId leaves neither roster", "runId", undefined, "POLICY_AUTHORITY_ROW_UNREADABLE"],
    ["a foreign run's refs", "graphNodeRevisionRefs", ["graph-elsewhere"],
      "POLICY_AUTHORITY_RUN_LINKAGE_MISMATCH"],
    ["a tier the evidence does not derive", "riskAssessment",
      { callerRiskHint: null, computedTier: "R0", effectiveTier: "R0", usedFactIds: [] },
      "POLICY_AUTHORITY_RUN_LINKAGE_MISMATCH"],
    ["an emptied run id", "runId", "", "POLICY_AUTHORITY_RUN_LINKAGE_MISMATCH"],
  ] as const)("refuses %s", (_label, key, value, code) => {
    const store = seededStore();
    const result = evaluate(store);
    if (!result.ok) throw new Error(`refused ${result.code}`);
    const tampered: Record<string, unknown> = { ...result.payload };
    if (value === undefined) delete tampered[key]; else tampered[key] = value;
    const authority = readPolicyEvaluationAuthority(
      tampered as JsonValue, PROJECT_ID, Date.parse(DECIDED_AT),
    );
    expect(authority.ok).toBe(false);
    if (authority.ok) throw new Error("a tampered run row must not read");
    expect([authority.code, authority.layer]).toStrictEqual([code, "DAEMON_POLICY_AUTHORITY"]);
  });
});
