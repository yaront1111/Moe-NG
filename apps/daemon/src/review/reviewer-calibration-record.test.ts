import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { JsonObject, RuntimeCommandEnvelope } from "@moe/contracts";
import { REVIEW_CALIBRATION_STALENESS } from "@moe/review";
import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { createDaemonCommandPorts } from "../daemon-command-registry.js";
import type {
  AuthenticatedPrincipal,
  CommandRegistryEntry,
  DecisionPortResult,
} from "../http/http-contract.js";
import {
  REVIEWER_CALIBRATION_SLICE_REF,
  readReviewerCalibration,
} from "./reviewer-calibration-record.js";

/**
 * The durable reviewer-calibration record, driven through the PRODUCTION registry.
 *
 * Every install below goes through `createDaemonCommandPorts(...).registry.get("policy.install")`
 * and its decision port, so what lands in the store is the byte shape production writes. A
 * hand-committed event would prove nothing: it could carry a shape `installPolicy` never
 * produces, and the reader would then be tested against a fiction.
 *
 * The load-bearing case is `refuses ... when nothing is installed`. An absent record must REFUSE,
 * never synthesise `{corpusRevision: "", sentinelPassed: false, staleness: "UNKNOWN"}` — that
 * value is a perfectly legal `ReviewerCalibration` which `calibrationCodes` maps to
 * `REVIEWER_CALIBRATION_UNPROVEN`, so it LOOKS fail-closed while actually asserting that a
 * calibration exists and is unproven when the truth is that none exists at all. Only an
 * assertion on the refusal code can tell those apart.
 */

const PROJECT_ID = "project-calibration-1";
const PRINCIPAL_ID = "operator-calibration";
const DECIDED_AT = "2026-08-17T00:00:00.000Z";
const DIGEST = "b".repeat(64);
const NOT_INSTALLED = "REVIEWER_CALIBRATION_NOT_INSTALLED";
const UNREADABLE = "REVIEWER_CALIBRATION_UNREADABLE";
const DURABLE_READ_LAYER = "DAEMON_PREREQUISITE";

const openStores: SqliteEventStore[] = [];

afterEach(() => {
  while (openStores.length > 0) openStores.pop()?.close();
});

const PRINCIPAL: AuthenticatedPrincipal = Object.freeze({
  capabilities: Object.freeze(["project.admin"]),
  principalId: PRINCIPAL_ID,
  projectId: PROJECT_ID,
});

function envelopeFor(
  commandKind: PolicyKind,
  commandId: string,
  expectedVersion: number,
  payload: JsonObject,
): RuntimeCommandEnvelope {
  return {
    commandId,
    commandKind,
    correlationId: "corr-calibration",
    expectedVersion,
    payload,
    requestDigest: DIGEST,
    schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    sessionCredential: "credential-calibration",
    targetAggregateId: `${PROJECT_ID}-policy`,
  };
}

type PolicyKind = "policy.install" | "policy.validate";

interface Project {
  readonly dispatch: (
    kind: PolicyKind, payload: JsonObject, commandId: string, expectedVersion: number,
  ) => DecisionPortResult;
  readonly entryFor: (kind: PolicyKind) => CommandRegistryEntry;
  readonly install: (
    slice: JsonObject, commandId: string, expectedVersion: number,
  ) => DecisionPortResult;
  readonly store: SqliteEventStore;
}

/** One ephemeral store plus the production registry and decision port built over it. */
function openProject(): Project {
  const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
  openStores.push(store);
  const ports = createDaemonCommandPorts({
    clock: () => DECIDED_AT,
    operatorPrincipalId: PRINCIPAL_ID,
    projectId: PROJECT_ID,
    store,
  });
  const entryFor = (kind: PolicyKind): CommandRegistryEntry => {
    const entry = ports.registry.get(kind);
    if (entry === undefined) throw new Error(`${kind} is not in the production registry`);
    return entry;
  };
  const dispatch = (
    kind: PolicyKind, payload: JsonObject, commandId: string, expectedVersion: number,
  ): DecisionPortResult => ports.decisions.decide(
    { commandId, principalId: PRINCIPAL_ID, projectId: PROJECT_ID },
    DIGEST,
    () => entryFor(kind).handler({
      envelope: envelopeFor(kind, commandId, expectedVersion, payload),
      principal: PRINCIPAL,
    }),
  );
  return {
    dispatch,
    entryFor,
    install: (slice, commandId, expectedVersion): DecisionPortResult =>
      dispatch("policy.install", { slice }, commandId, expectedVersion),
    store,
  };
}

function calibrationSlice(overrides: JsonObject = {}): JsonObject {
  return {
    corpusRevision: "corpus-2026-08",
    sentinelPassed: true,
    sliceRef: REVIEWER_CALIBRATION_SLICE_REF,
    staleness: "CURRENT",
    ...overrides,
  };
}

/** Fails loudly rather than letting a refused setup leave a later assertion testing nothing. */
function installAccepted(
  project: Project, slice: JsonObject, commandId: string, expectedVersion = 0,
): void {
  const result = project.install(slice, commandId, expectedVersion);
  if (result.outcome !== "DECIDED") {
    throw new Error(`install refused: ${result.refusal.code} at ${result.refusal.layer}`);
  }
}

function rawEventCount(store: SqliteEventStore): number {
  return store.readEventsAfter(0n, 1_000).items.length;
}

describe("durable reviewer calibration record", () => {
  it("reads back byte-identically what policy.install durably recorded", () => {
    const project = openProject();
    installAccepted(project, calibrationSlice({
      corpusRevision: "corpus-abc", sentinelPassed: false, staleness: "STALE",
    }), "cmd-install-1");

    const read = readReviewerCalibration(project.store, PROJECT_ID);

    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error(`expected a calibration, got ${read.code}`);
    expect(read.calibration.corpusRevision).toBe("corpus-abc");
    expect(read.calibration.sentinelPassed).toBe(false);
    expect(read.calibration.staleness).toBe("STALE");
    // The record is exactly the contract's three fields: `sliceRef` is the address, not a fact.
    expect(Object.keys(read.calibration).sort())
      .toEqual(["corpusRevision", "sentinelPassed", "staleness"]);
  });

  it("refuses with NOT_INSTALLED and yields no calibration when nothing is installed", () => {
    const project = openProject();
    const before = rawEventCount(project.store);

    const read = readReviewerCalibration(project.store, PROJECT_ID);

    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("an absent record returned a calibration");
    expect(read.code).toBe(NOT_INSTALLED);
    expect(read.layer).toBe(DURABLE_READ_LAYER);
    // A synthesised `{corpusRevision: "", sentinelPassed: false, staleness: "UNKNOWN"}` is a
    // legal calibration, so its ABSENCE is the only thing that distinguishes a refusal from a
    // fabricated durable fact.
    expect("calibration" in read).toBe(false);
    expect(rawEventCount(project.store)).toBe(before);
  });

  it("refuses a project whose only installed slice sits under another ref", () => {
    const project = openProject();
    installAccepted(project, calibrationSlice({ sliceRef: "some-other-policy-slice" }),
      "cmd-install-other");

    const read = readReviewerCalibration(project.store, PROJECT_ID);

    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("a foreign ref was mistaken for the calibration ref");
    expect(read.code).toBe(NOT_INSTALLED);
    expect(read.layer).toBe(DURABLE_READ_LAYER);
  });

  it("returns the superseding value after a later install under the same ref", () => {
    const project = openProject();
    installAccepted(project, calibrationSlice({
      corpusRevision: "corpus-old", sentinelPassed: false, staleness: "UNKNOWN",
    }), "cmd-install-old", 0);
    installAccepted(project, calibrationSlice({
      corpusRevision: "corpus-new", sentinelPassed: true, staleness: "CURRENT",
    }), "cmd-install-new", 1);

    const read = readReviewerCalibration(project.store, PROJECT_ID);

    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error(`expected a calibration, got ${read.code}`);
    expect(read.calibration.corpusRevision).toBe("corpus-new");
    expect(read.calibration.sentinelPassed).toBe(true);
    expect(read.calibration.staleness).toBe("CURRENT");
  });
});

/**
 * Hostile CONTENTS under a valid `sliceRef`. Every case must be ACCEPTED by `installPolicy` —
 * it requires only a ref — so the refusal under test is this task's reader and not the generic
 * ingress guard that already exists. `installAccepted` throws if that stops being true.
 */
const MALFORMED_SLICES: readonly (readonly [string, JsonObject])[] = Object.freeze([
  ["absent sentinelPassed", { corpusRevision: "c", sliceRef: REVIEWER_CALIBRATION_SLICE_REF,
    staleness: "CURRENT" }],
  ["non-boolean sentinelPassed", calibrationSlice({ sentinelPassed: "true" })],
  ["absent corpusRevision", { sentinelPassed: true, sliceRef: REVIEWER_CALIBRATION_SLICE_REF,
    staleness: "CURRENT" }],
  ["non-string corpusRevision", calibrationSlice({ corpusRevision: 7 })],
  ["empty corpusRevision", calibrationSlice({ corpusRevision: "" })],
  ["absent staleness", { corpusRevision: "c", sentinelPassed: true,
    sliceRef: REVIEWER_CALIBRATION_SLICE_REF }],
  ["staleness outside the frozen set", calibrationSlice({ staleness: "PROBABLY_FINE" })],
  ["lower-case staleness", calibrationSlice({ staleness: "current" })],
  ["an unlisted extra field", calibrationSlice({ trustMe: true })],
]);

describe("malformed durable calibration", () => {
  it("generated a nonzero hostile-case count over the frozen staleness set", () => {
    // A sweep that produced zero cases would satisfy every `it.each` below while testing nothing.
    expect(MALFORMED_SLICES.length).toBeGreaterThan(0);
    expect(MALFORMED_SLICES).toHaveLength(9);
    expect(REVIEW_CALIBRATION_STALENESS).toEqual(["CURRENT", "STALE", "UNKNOWN"]);
    const stalenessValues = MALFORMED_SLICES
      .map(([, slice]) => slice["staleness"])
      .filter((value) => typeof value === "string");
    expect(stalenessValues.some((value) => !REVIEW_CALIBRATION_STALENESS
      .includes(value as (typeof REVIEW_CALIBRATION_STALENESS)[number]))).toBe(true);
  });

  it.each(MALFORMED_SLICES)(
    "refuses %s with UNREADABLE, a code distinct from the absent-record one",
    (_label, slice) => {
      const project = openProject();
      installAccepted(project, slice, "cmd-install-malformed");

      const read = readReviewerCalibration(project.store, PROJECT_ID);

      expect(read.ok).toBe(false);
      if (read.ok) throw new Error("a malformed slice yielded a calibration");
      expect(read.code).toBe(UNREADABLE);
      expect(read.code).not.toBe(NOT_INSTALLED);
      expect(read.layer).toBe(DURABLE_READ_LAYER);
      expect("calibration" in read).toBe(false);
    },
  );
});

/**
 * Which layer answers. Two can, so a case asserting only "refused" would be one guard away from
 * vacuous: if `installPolicy` ever started validating slice CONTENTS, the malformed cases above
 * would still refuse — at a different layer, for a different reason — and stay green while this
 * module's reader had stopped being what refuses them.
 */
describe("the write/read layer division", () => {
  it("registers policy.install under ADMIN with the exact allow-list [slice]", () => {
    const entry = openProject().entryFor("policy.install");

    expect(entry.requiredCapability).toBe("project.admin");
    expect(entry.payloadKeys).toEqual(["slice"]);
  });

  it.each([
    ["a slice carrying no sliceRef", { corpusRevision: "c", sentinelPassed: true,
      staleness: "CURRENT" }],
    ["a slice whose sliceRef is empty", calibrationSlice({ sliceRef: "" })],
    ["a slice that is not an object", "moe-reviewer-calibration/1"],
  ] as const)("refuses %s at DAEMON_INGRESS, which is not this task's guard", (_label, slice) => {
    const project = openProject();

    const result = project.install(slice as JsonObject, "cmd-install-no-ref", 0);

    expect(result.outcome).toBe("REFUSED");
    if (result.outcome !== "REFUSED") throw new Error("an addressless slice was installed");
    expect(result.refusal.code).toBe("BOOTSTRAP_PAYLOAD_INVALID");
    expect(result.refusal.layer).toBe("DAEMON_INGRESS");
    // The generic ingress guard commits nothing, so the reader sees an empty project.
    expect(rawEventCount(project.store)).toBe(0);
  });

  it("accepts malformed CONTENTS at ingress and leaves the refusal to the reader", () => {
    const project = openProject();

    const written = project.install(
      calibrationSlice({ staleness: "PROBABLY_FINE" }), "cmd-install-contents", 0,
    );

    // The positive half of the division: ingress does NOT judge contents, so it accepts and
    // durably commits. Without this assertion the sweep above could be passing because
    // `installPolicy` refused first, and the reader would never have been exercised at all.
    expect(written.outcome).toBe("DECIDED");
    expect(rawEventCount(project.store)).toBe(1);
    const read = readReviewerCalibration(project.store, PROJECT_ID);
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("a committed malformed slice yielded a calibration");
    expect(read.code).toBe(UNREADABLE);
    expect(read.layer).toBe(DURABLE_READ_LAYER);
  });
});

/**
 * The `validatePolicy` visibility question, decided by measurement rather than left as prose.
 *
 * A calibration slice IS visible to `validatePolicy` as an installed ref, so its
 * `BOOTSTRAP_POLICY_UNKNOWN` presence check passes for the calibration ref — the pair below
 * proves that plainly rather than asserting it away. It is acceptable because it cannot lead to
 * an accepted evaluation: `evaluatePolicy` requires `policyRevisionRef` to be 64 hex, and
 * `REVIEWER_CALIBRATION_SLICE_REF` is deliberately human-readable, so the core refuses under its
 * own layer. `evaluatePolicy` judges the caller's input, never the stored slice.
 */
describe("calibration slice visibility to policy.validate", () => {
  const EVALUATION_INPUT: JsonObject = Object.freeze({
    policyRevisionRef: REVIEWER_CALIBRATION_SLICE_REF,
  });

  it("refuses at DAEMON_PREREQUISITE while only a foreign ref is installed", () => {
    const project = openProject();
    installAccepted(project, calibrationSlice({ sliceRef: "some-other-policy-slice" }),
      "cmd-install-foreign");

    const result = project.dispatch("policy.validate", { input: EVALUATION_INPUT },
      "cmd-validate-absent", 1);

    expect(result.outcome).toBe("REFUSED");
    if (result.outcome !== "REFUSED") throw new Error("an unknown policy ref was evaluated");
    expect(result.refusal.code).toBe("BOOTSTRAP_POLICY_UNKNOWN");
    expect(result.refusal.layer).toBe("DAEMON_PREREQUISITE");
  });

  it("clears the presence check once installed yet can never be accepted by the core", () => {
    const project = openProject();
    installAccepted(project, calibrationSlice(), "cmd-install-visible");

    const result = project.dispatch("policy.validate", { input: EVALUATION_INPUT },
      "cmd-validate-present", 1);

    expect(result.outcome).toBe("REFUSED");
    if (result.outcome !== "REFUSED") throw new Error("a calibration ref was accepted as policy");
    // Reaching CORE_REDUCER is the proof it got PAST the daemon's presence gate; `INPUT_INVALID`
    // is `evaluatePolicy` rejecting a `policyRevisionRef` that is not 64 hex, which is what makes
    // the human-readable calibration ref unusable as a policy revision.
    expect(result.refusal.layer).toBe("CORE_REDUCER");
    expect(result.refusal.code).toBe("INPUT_INVALID");
    expect(result.refusal.code).not.toBe("BOOTSTRAP_POLICY_UNKNOWN");
    // The record itself is untouched by the attempt.
    const read = readReviewerCalibration(project.store, PROJECT_ID);
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error(`the record went unreadable: ${read.code}`);
    expect(read.calibration.corpusRevision).toBe("corpus-2026-08");
  });
});

function hex64(seed: string): string {
  return (seed.replace(/[^0-9a-f]/gu, "0") + "0".repeat(64)).slice(0, 64);
}

const POLICY_REF = hex64("a1b2c3");

/** A slice `validateEvaluationInput` accepts, addressed by a hex64 ref as that validator demands. */
const HEX_POLICY_SLICE: JsonObject = Object.freeze({
  autoApprovalOptIns: [], rules: [], sliceRef: POLICY_REF,
});

const ACCEPTED_EVALUATION_INPUT: JsonObject = Object.freeze({
  action: "plan.approve",
  actor: PRINCIPAL_ID,
  callerRiskHint: null,
  decisionDigest: hex64("d1"),
  evaluatedAtEpochMs: 1_760_000_000_000,
  evaluatorVersion: "evaluator-1",
  facts: [],
  graphNodeRevisionRefs: [],
  policyRevisionRef: POLICY_REF,
  requiredFactIds: [],
  scope: [],
  // `sliceChain` and `waivers` are SERVER-SOURCED as of task-eb6a1fa6: `validatePolicy` refuses
  // a caller that supplies either and composes them from the installed slice bytes instead, so
  // an input carrying them is now refused before it reaches core.
});

/**
 * An ACCEPTED `policy.validate` is the one command that REWRITES the policy aggregate's stored
 * shape: `installPolicy` commits `{slices}` while `validatePolicy` commits `{record, slices}`.
 * A reader that navigated to the calibration by position, by "the whole state is the slice map",
 * or by assuming a single-key state would read correctly all through the install cases here and
 * then fail the first time a project actually evaluated a policy — the ordinary case in J1's
 * bootstrap sequence, where `policy.validate` immediately follows `policy.install`.
 */
describe("the calibration survives an accepted policy evaluation", () => {
  it("still reads back after policy.validate rewrote the aggregate state shape", () => {
    const project = openProject();
    installAccepted(project, calibrationSlice(), "cmd-install-calibration", 0);
    installAccepted(project, HEX_POLICY_SLICE, "cmd-install-hex-policy", 1);

    const evaluated = project.dispatch(
      "policy.validate", { input: ACCEPTED_EVALUATION_INPUT }, "cmd-validate-accepted", 2,
    );

    // Without this the case would silently degrade into a third refusal test and the state
    // rewrite it exists to exercise would never happen.
    expect(evaluated.outcome).toBe("DECIDED");
    const read = readReviewerCalibration(project.store, PROJECT_ID);
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error(`the record went unreadable: ${read.code}`);
    expect(read.calibration.corpusRevision).toBe("corpus-2026-08");
    expect(read.calibration.sentinelPassed).toBe(true);
    expect(read.calibration.staleness).toBe("CURRENT");
  });
});
