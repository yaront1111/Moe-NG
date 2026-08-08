/**
 * Package-ROOT reachability contract for the committed supervisor effect surface.
 *
 * Every specifier in this file is the bare package root `@moe/runner`. The
 * package `exports` map is exclusive (`{".": "./src/index.ts"}`), so a deep
 * subpath such as `@moe/runner/supervisor/effect-lifecycle.js` does not resolve
 * for a real consumer at all — testing one would prove nothing about the seam
 * this task publishes, and a relative import would prove even less.
 *
 * The expected namespace below is hand-transcribed from the module sources, never
 * derived from the namespace under test, so a removed export AND an unreviewed
 * addition both go red.
 */
import { expect, it } from "vitest";

import * as runner from "@moe/runner";
import type {
  ActivationCommit, ActivationGrant, ActivationOutcome, AdmittedTransition, AttemptSlice,
  AttemptSliceState, CommitCheck, DependencyWitness, EffectClaim, EffectCommand,
  EffectCommandInput, EffectIntent, EffectResult, EffectState, EffectTombstone, GrantOutcome,
  GrantState, LifecycleOutcome, MirrorVerdict, MirroredLeaseKind, MirroredLeaseProof,
  MirroredLeaseRecord, MirroredLeaseState, SettleCommand, SettlementEvidence, SimpleCommand,
  SupervisorErrorCode, SupervisorFailure, SupervisorFailureDetail, SupervisorLayer,
  TerminalEffectState, UncertaintyEvidence,
} from "@moe/runner";

it("resolves the self-referencing package root specifier @moe/runner", () => {
  expect(typeof runner.observeScope).toBe("function");
});

type ExportKind = "array" | "function" | "number" | "regexp" | "string";
/** Hand-transcribed: 26 pre-existing runner values + 40 published supervisor values. */
const EXPECTED_EXPORTS: readonly (readonly [string, ExportKind])[] = [
  ["ADMITTED_EFFECT_TRANSITIONS", "array"], ["ARTIFACT_ADDRESS_PATTERN", "regexp"],
  ["ATTEMPT_SLICE_STATES", "array"], ["EFFECT_CALLER_CONTRACT", "array"],
  ["EFFECT_COMMANDS", "array"], ["EFFECT_STATES", "array"],
  ["GRANT_STATES", "array"], ["MAX_SCOPE_OBSERVATION_BYTES", "number"],
  ["MAX_SCOPE_PATHS", "number"], ["MAX_SUPERVISOR_COUNT", "number"],
  ["MAX_SUPERVISOR_TEXT_CHARS", "number"], ["MAX_WORKSPACE_ENTRIES", "number"],
  ["MIRRORED_LEASE_KINDS", "array"], ["MIRRORED_LEASE_STATES", "array"],
  ["RUNNER_ARTIFACT_ERROR_CODES", "array"], ["RUNNER_SCOPE_ERROR_CODES", "array"],
  ["RUNNER_WORKSPACE_ERROR_CODES", "array"], ["SCOPE_ATTRIBUTION_CLASSES", "array"],
  ["SCOPE_OBSERVATION_VERSION", "string"], ["SUPERVISOR_ACTIVATION_VERSION", "string"],
  ["SUPERVISOR_EFFECT_PROTOCOL_VERSION", "string"], ["SUPERVISOR_ERROR_CODES", "array"],
  ["SUPERVISOR_LAYERS", "array"], ["SUPERVISOR_RESULT_VERSION", "string"],
  ["ScopeObserverError", "function"], ["TERMINAL_EFFECT_STATES", "array"],
  ["WORKSPACE_INPUT_MANIFEST_VERSION", "string"], ["WORKSPACE_RESULT_MANIFEST_VERSION", "string"],
  ["activateEffect", "function"], ["activationDigestInput", "function"],
  ["applyEffectCommand", "function"], ["applyEffectTombstone", "function"],
  ["buildInputManifest", "function"], ["buildResultManifest", "function"],
  ["canonicalPathRejection", "function"], ["consumeActivationGrant", "function"],
  ["createArtifactStore", "function"], ["createNodeArtifactFs", "function"],
  ["createNodeGitObserver", "function"], ["createNodeScopePaths", "function"],
  ["deriveGrantId", "function"], ["fenceMirroredLease", "function"],
  ["grantRefusal", "function"], ["hermeticGitEnvironment", "function"],
  ["initialGrantBinding", "function"], ["inputManifestDigestInput", "function"],
  ["isTerminalEffectState", "function"], ["observeScope", "function"],
  ["parseActivationGrant", "function"], ["parseAttemptSlice", "function"],
  ["parseCommandInput", "function"], ["parseDependencyWitness", "function"],
  ["parseEffectClaim", "function"], ["parseEffectIntent", "function"],
  ["parseEffectTombstone", "function"], ["parseMirroredLease", "function"],
  ["parseMirroredProof", "function"], ["parseSettlementEvidence", "function"],
  ["parseUncertaintyEvidence", "function"], ["refMatches", "function"],
  ["refRejection", "function"], ["resultManifestDigestInput", "function"],
  ["scopeObservationDigestInput", "function"], ["supervisorFailure", "function"],
  ["validateActivationCommit", "function"], ["withLeg", "function"],
];
const surface: Readonly<Record<string, unknown>> = runner;

it("generates one expectation per published root export", () => {
  expect(EXPECTED_EXPORTS.length).toBe(66);
});

it("publishes exactly the reviewed root namespace, with no loss and no addition", () => {
  expect(Object.keys(runner).sort()).toEqual(EXPECTED_EXPORTS.map(([name]) => name));
});

it.each(EXPECTED_EXPORTS)("publishes %s on the package root as a %s", (name, kind) => {
  const value = surface[name];
  if (kind === "array") expect(Array.isArray(value)).toBe(true);
  else if (kind === "regexp") expect(value instanceof RegExp).toBe(true);
  else expect(typeof value).toBe(kind);
});

/** Hand-transcribed from supervisor/effect-test-fixtures.ts, which must never reach the seam. */
const FIXTURE_NAMES: readonly string[] = [
  "AT", "LATER", "DIGEST", "makeLease", "makeProof", "makeIntent", "makeAttempt", "makeClaim",
  "makeTombstone", "makeGrant", "makeSettlement", "makeUncertainty", "makeWitness",
  "makeActivationRequest", "withGetter", "withExtraKey",
];

it("keeps the test-only fixture module off the published surface", () => {
  expect(FIXTURE_NAMES.filter((name) => name in surface)).toEqual([]);
});

/**
 * Every record below is hand-written from the module sources rather than read off
 * an export under test, so a vocabulary that silently changed value would fail
 * these assertions instead of quietly redefining them.
 */
const DIGEST = "b".repeat(64);
const AT = "2026-08-08T00:00:00.000Z";
const WRAPPER = "wrapper:1";
const LOCK = "lock:1";
const LEASE: MirroredLeaseRecord = {
  leaseId: "lease:1", kind: "ASSIGNMENT" satisfies MirroredLeaseKind, ownerSessionRef: "session:1",
  leaseToken: "token:1", epoch: 3, state: "ACTIVE" satisfies MirroredLeaseState,
  serverWallDeadline: 90, bootId: "boot:1", monotonicObservation: 12, authorityHashRef: DIGEST,
  version: 7,
};
const PROOF: MirroredLeaseProof = {
  leaseToken: "token:1", epoch: 3, authorityHashRef: DIGEST, ownerSessionRef: "session:1",
  expectedVersion: 7,
};
const ATTEMPT: AttemptSlice = {
  attemptId: "attempt:1", aggregateId: "aggregate:1", intentId: "intent:1",
  state: "LAUNCH_REQUESTED" satisfies AttemptSliceState, version: 2,
};
const CLAIM_RECORD: EffectClaim = {
  claimId: "claim:1", intentId: "intent:1", wrapperIdentity: WRAPPER, lockIdentity: LOCK,
  claimedAt: AT,
};
const WITNESS: DependencyWitness =
  { witnessId: "witness:1", expectedDigest: DIGEST, observedDigest: DIGEST };
const SETTLEMENT: SettlementEvidence =
  { reconciliationVersion: "recon/1", reconciliationDigest: DIGEST, outcomeClass: "COMPLETED" };
const UNCERTAINTY: UncertaintyEvidence =
  { uncertaintyReason: "unreadable", uncertaintyDigest: DIGEST };

function intentIn(state: EffectState): EffectIntent {
  return {
    protocolVersion: "moe-effect-intent/1", intentId: "intent:1", aggregateId: "aggregate:1",
    expectedGraphEpoch: 3, leaseBinding: LEASE, inputBinding: DIGEST,
    predecessorCursor: "cursor:1", desiredState: "RUNNING", idempotencyKey: "idem:1",
    runtimeObservationDigest: DIGEST, state, version: 7,
  };
}
function activationRequest(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    intent: intentIn("ARMED"), attempt: ATTEMPT, claim: CLAIM_RECORD, tombstone: null,
    leaseProof: PROOF, wrapperIdentity: WRAPPER, lockIdentity: LOCK, observedGraphEpoch: 3,
    desiredState: "RUNNING", dependencyWitnesses: [WITNESS], observedRuntimeDigest: DIGEST,
    ...overrides,
  };
}

/** Names each arm without any deep import, and pins REFUSED's exact key set. */
function refusalOf(outcome: LifecycleOutcome | GrantOutcome | ActivationOutcome | CommitCheck |
  MirrorVerdict): SupervisorFailure {
  if (outcome.kind !== "REFUSED") throw new Error(`expected REFUSED, got ${outcome.kind}`);
  expect(Object.keys(outcome).sort()).toEqual(["failure", "kind"]);
  const failure: SupervisorFailure = outcome.failure;
  const layer: SupervisorLayer = failure.layer;
  const detail: SupervisorFailureDetail = failure.detail;
  expect(runner.SUPERVISOR_LAYERS).toContain(layer);
  expect(detail).not.toHaveProperty("leaseToken");
  return failure;
}
function codeOf(failure: SupervisorFailure): SupervisorErrorCode {
  expect(runner.SUPERVISOR_ERROR_CODES).toContain(failure.code);
  return failure.code;
}

it("pins the published protocol vocabularies by value", () => {
  expect(runner.SUPERVISOR_EFFECT_PROTOCOL_VERSION).toBe("moe-effect-intent/1");
  expect(runner.SUPERVISOR_ACTIVATION_VERSION).toBe("moe-effect-activation/1");
  expect(runner.SUPERVISOR_RESULT_VERSION).toBe("moe-effect-result/1");
  expect([...runner.EFFECT_COMMANDS]).toContain("requestCancel");
  expect([...runner.EFFECT_STATES]).toContain("CANCEL_REQUESTED");
  expect([...runner.MIRRORED_LEASE_STATES]).toContain("REVOKED");
  expect([...runner.TERMINAL_EFFECT_STATES]).toEqual(["SUCCEEDED", "FAILED", "UNKNOWN", "CANCELLED"]);
  expect(runner.isTerminalEffectState("ACTIVE")).toBe(false);
  expect([...runner.MIRRORED_LEASE_KINDS, ...runner.GRANT_STATES, ...runner.ATTEMPT_SLICE_STATES])
    .toEqual(["ASSIGNMENT", "WORKSPACE", "RESOURCE", "UNUSED", "CONSUMED", "LAUNCH_REQUESTED",
      "RUNNING"]);
  expect([...runner.EFFECT_CALLER_CONTRACT]).toHaveLength(4);
  expect([runner.MAX_SUPERVISOR_COUNT, runner.MAX_SUPERVISOR_TEXT_CHARS])
    .toEqual([Number.MAX_SAFE_INTEGER - 1_000_000, 400]);
  const arcs: readonly AdmittedTransition[] = runner.ADMITTED_EFFECT_TRANSITIONS;
  const claimArc = arcs.find((arc) => arc.from === "PENDING" && arc.command === "claim");
  expect(claimArc?.to).toEqual(["CLAIMED"]);
});

it("parses each supervisor record from the root and refuses hostile input with null", () => {
  const intent: EffectIntent | null = runner.parseEffectIntent(intentIn("PENDING"));
  const tombstone: EffectTombstone | null =
    runner.parseEffectTombstone({ intentId: "intent:1", reason: "cancelled", terminalizedAt: AT });
  expect([intent?.state, tombstone?.reason, runner.parseMirroredLease(LEASE)?.epoch]).toEqual(
    ["PENDING", "cancelled", 3],
  );
  // Stronger than republishing the raw key lists: the exact-own-key contract itself.
  expect([runner.parseMirroredLease({ ...LEASE, extra: 1 }), runner.parseMirroredProof(PROOF)?.epoch])
    .toEqual([null, 3]);
  expect([
    runner.parseAttemptSlice(null), runner.parseEffectClaim(null), runner.parseActivationGrant(null),
    runner.parseSettlementEvidence(null), runner.parseUncertaintyEvidence(null),
    runner.parseDependencyWitness(null), runner.parseCommandInput(null),
    runner.parseMirroredProof(null),
  ]).toEqual([null, null, null, null, null, null, null, null]);
});

it("discriminates TRANSITIONED through the published applyEffectCommand", () => {
  const command: SimpleCommand = { kind: "claim" satisfies EffectCommand };
  const outcome: LifecycleOutcome = runner.applyEffectCommand(intentIn("PENDING"), command);
  if (outcome.kind !== "TRANSITIONED") throw new Error(codeOf(refusalOf(outcome)));
  expect(Object.keys(outcome).sort()).toEqual(["intent", "kind", "ok", "result", "versionDelta"]);
  expect([outcome.ok, outcome.intent.state, outcome.intent.version, outcome.versionDelta]).toEqual(
    [true, "CLAIMED", 8, 1],
  );
  expect(outcome.result).toBeNull();
});

it("keeps MUST_DRAIN an instruction to drain, carrying no ok field at all", () => {
  const command: SimpleCommand = { kind: "requestCancel" };
  const outcome: LifecycleOutcome = runner.applyEffectCommand(intentIn("ACTIVE"), command);
  if (outcome.kind !== "MUST_DRAIN") throw new Error(`expected MUST_DRAIN, got ${outcome.kind}`);
  expect(Object.keys(outcome).sort()).toEqual(["drainRequired", "intent", "kind", "versionDelta"]);
  expect("ok" in outcome).toBe(false);
  expect([outcome.drainRequired, outcome.versionDelta, outcome.intent.version]).toEqual([true, 0, 7]);
});

it("discriminates REFUSED by its own reason code, with exactly the keys kind and failure", () => {
  const outcome: LifecycleOutcome = runner.applyEffectCommand(intentIn("PENDING"), { kind: "arm" });
  const failure = refusalOf(outcome);
  expect(codeOf(failure)).toBe("EFFECT_TRANSITION_NOT_ADMITTED");
  expect([failure.layer, failure.ok, failure.detail.state]).toEqual(["LIFECYCLE", false, "PENDING"]);
});

it("adopts a settlement result and cancels a pre-activation intent by tombstone", () => {
  const settle: SettleCommand = {
    kind: "settle", target: "SUCCEEDED", settlement: SETTLEMENT, uncertainty: null, adoptedAt: AT,
  };
  const settled: LifecycleOutcome = runner.applyEffectCommand(intentIn("ACTIVE"), settle);
  if (settled.kind !== "TRANSITIONED") throw new Error(codeOf(refusalOf(settled)));
  const result: EffectResult | null = settled.result;
  const terminal: TerminalEffectState | undefined = result?.terminalState;
  expect([terminal, result?.outcomeClass, result?.resultVersion]).toEqual(
    ["SUCCEEDED", "COMPLETED", "moe-effect-result/1"],
  );
  const unproven: EffectCommandInput = { ...settle, target: "UNKNOWN", uncertainty: null };
  expect(codeOf(refusalOf(runner.applyEffectCommand(intentIn("ACTIVE"), unproven))))
    .toBe("EFFECT_UNCERTAINTY_EVIDENCE_REQUIRED");
  const proven: EffectCommandInput = { ...settle, target: "UNKNOWN", uncertainty: UNCERTAINTY };
  expect(runner.applyEffectCommand(intentIn("ACTIVE"), proven).kind).toBe("TRANSITIONED");
  const tombstone: EffectTombstone =
    { intentId: "intent:1", reason: "cancelled", terminalizedAt: AT };
  const dominated: LifecycleOutcome =
    runner.applyEffectTombstone(intentIn("ARMED"), tombstone);
  expect(dominated.kind === "TRANSITIONED" && dominated.intent.state).toBe("CANCELLED");
  expect(codeOf(refusalOf(runner.applyEffectTombstone(intentIn("ACTIVE"), tombstone))))
    .toBe("EFFECT_TOMBSTONE_DOES_NOT_DOMINATE");
});

it("activates, consumes the one-use grant, and re-validates the commit from the root", () => {
  const activated: ActivationOutcome = runner.activateEffect(activationRequest());
  if (activated.kind !== "ACTIVATED") throw new Error(codeOf(refusalOf(activated)));
  const commit: ActivationCommit = activated.commit;
  const grant: ActivationGrant = commit.grant;
  expect([commit.intent.state, commit.attempt.state, grant.state]).toEqual(
    ["ACTIVE", "RUNNING", "UNUSED" satisfies GrantState],
  );
  expect(grant.grantId).toBe(runner.deriveGrantId("intent:1", commit.activationDigest));
  expect(runner.activationDigestInput(commit.intent, commit.attempt,
    runner.initialGrantBinding("intent:1", WRAPPER))).toHaveProperty("grant.state", "UNUSED");

  const consumed: GrantOutcome = runner.consumeActivationGrant(grant, WRAPPER);
  if (consumed.kind !== "CONSUMED") throw new Error(codeOf(refusalOf(consumed)));
  expect([consumed.grant.state, consumed.grant.version, consumed.versionDelta]).toEqual(
    ["CONSUMED", 1, 1],
  );
  expect(codeOf(refusalOf(runner.consumeActivationGrant(consumed.grant, WRAPPER))))
    .toBe("GRANT_ALREADY_CONSUMED");
  expect(codeOf(refusalOf(runner.consumeActivationGrant(grant, "wrapper:2"))))
    .toBe("GRANT_WRAPPER_MISMATCH");

  const check: CommitCheck = runner.validateActivationCommit(commit.intent, commit.attempt, grant);
  if (check.kind !== "COHERENT") throw new Error(codeOf(refusalOf(check)));
  expect([check.ok, check.activationDigest]).toEqual([true, commit.activationDigest]);
  expect(codeOf(refusalOf(runner.validateActivationCommit(intentIn("ARMED"), ATTEMPT, grant))))
    .toBe("ACTIVATION_COMMIT_INCOHERENT");
});

it("refuses an unarmed activation and a stale lease by their own reason codes", () => {
  const unarmed = refusalOf(runner.activateEffect(activationRequest({ intent: intentIn("ACTIVE") })));
  expect([codeOf(unarmed), unarmed.layer, unarmed.detail.leg]).toEqual(
    ["ACTIVATION_INTENT_NOT_ARMED", "ACTIVATION", "intentState"],
  );
  const legal: readonly MirroredLeaseState[] = ["ACTIVE"];
  const fenced: MirrorVerdict = runner.fenceMirroredLease(LEASE, PROOF, "effect.activate", legal);
  if (fenced.kind !== "FENCED") throw new Error(codeOf(refusalOf(fenced)));
  expect([fenced.ok, fenced.lease.leaseId, fenced.proof.expectedVersion]).toEqual([true, "lease:1", 7]);
  const stale = refusalOf(
    runner.fenceMirroredLease(LEASE, { ...PROOF, epoch: 2 }, "effect.activate", legal),
  );
  expect([codeOf(stale), stale.layer]).toEqual(["LEASE_MIRROR_STALE_EPOCH", "LEASE_MIRROR"]);
  expect(codeOf(refusalOf(runner.fenceMirroredLease(null, PROOF, "effect.activate", legal))))
    .toBe("LEASE_MIRROR_MALFORMED");
  const bounded = runner.supervisorFailure("EFFECT_COUNTER_EXHAUSTED", "KERNEL", "bound", {});
  expect([codeOf(bounded), runner.withLeg(bounded, "counters").detail.leg]).toEqual(
    ["EFFECT_COUNTER_EXHAUSTED", "counters"],
  );
});
