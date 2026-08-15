import { createHash } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { RECOVERY_BINDING_CODEC_VERSION } from "@moe/store";
import type { SqliteEventStore } from "@moe/store";

import { readDurableLedger, stateOf } from "../bootstrap/bootstrap-ledger.js";
import {
  RECOVERY_COMPLETION_CODES,
  RECOVERY_COMPLETION_DIGEST_DOMAIN,
  RECOVERY_COMPLETION_LAYER,
  RECOVERY_COMPLETION_SCHEMA_VERSION,
  RECOVERY_COVERAGE_PROOF_DIGEST_DOMAIN,
  RECOVERY_STEP_UP_REF_PREFIX,
  recoveryCompletionPreimage,
  recoveryCompletionDigest,
  recoveryCoverageProofDigest,
} from "./recovery-completion-digest.js";
import type {
  RecoveryCompletionEvidence,
  RecoveryCompletionItemEvidence,
  RecoveryCompletionProofEvidence,
} from "./recovery-completion-digest.js";
import {
  readRecoveryCompletionEvidence,
  runRecoveryCompleteCommand,
} from "./recovery-completion.js";
import {
  RECOVERY_INVENTORY_POPULATIONS,
  RECOVERY_PROOF_CLASSES,
  recoveryPopulationClass,
} from "./recovery-inventory-contract.js";
import type { RecoveryProofClass } from "./recovery-inventory-contract.js";
import { recordRecoveryReconciliation } from "./recovery-inventory-ledger.js";
import type { RecoveryReconciliationExternalFacts } from "./recovery-inventory-ledger.js";
import type {
  RecoveryReconciliationSubject,
  RecoverySubjectEvidence,
} from "./recovery-inventory-subject.js";
import { runRestoreQuiesce } from "./restore-controller.js";
import {
  DECIDED_AT,
  PRINCIPAL_ID,
  PROJECT_ID,
  anchoredIncarnation,
  cleanupRestoreHarnesses,
  restoreHarness,
  restoreRequest,
} from "./restore-test-harness.js";

const hex = (tag: string): string =>
  (tag.replace(/[^0-9a-f]/gu, "") + "0".repeat(64)).slice(0, 64);

const PROOFS: readonly RecoveryCompletionProofEvidence[] = Object.freeze([
  Object.freeze({
    class: "PROVIDER_PROCESS_LAUNCH_LOCK",
    itemCount: 2,
    sourceProofDigest: hex("c0"),
    truth: "COMPLETE",
  }),
  Object.freeze({
    class: "RESOURCE",
    itemCount: 1,
    sourceProofDigest: hex("c1"),
    truth: "COMPLETE",
  }),
]);

const ITEMS: readonly RecoveryCompletionItemEvidence[] = Object.freeze([
  Object.freeze({
    class: "PROVIDER_PROCESS_LAUNCH_LOCK",
    disposition: "ABSENT",
    identity: "external-EFFECT_LOCK_WRAPPER_REGISTRATION",
    population: "EFFECT_LOCK_WRAPPER_REGISTRATION",
    quarantineRef: null,
    sourceProofDigest: hex("c0"),
  }),
  Object.freeze({
    class: "RESOURCE",
    disposition: "ADOPTED",
    identity: "external-RESOURCE",
    population: "RESOURCE",
    quarantineRef: null,
    sourceProofDigest: hex("c1"),
  }),
]);

const EVIDENCE: RecoveryCompletionEvidence = Object.freeze({
  anchorBindingDigest: hex("a1"),
  backupCursor: "000000000000000000042",
  backupGenerationDigest: hex("b2"),
  configuredClasses: Object.freeze(["PROVIDER_PROCESS_LAUNCH_LOCK", "RESOURCE"]),
  incarnationRef: hex("c3"),
  items: ITEMS,
  keyEpochRef: hex("d4"),
  projectId: "project-1",
  projectTag: "moe-project:project-1",
  proofs: PROOFS,
  reconciliationRecordDigest: hex("e5"),
  restoreBindingSlot: "ACTIVE",
  restoreCommandId: "restore-cmd-1",
  restoreGenerationDigest: hex("f6"),
});

/**
 * The hand-written census of the evidence tuple. The sweep below is GENERATED
 * from the record's own key set so a later field cannot escape it, but a
 * generated table cannot police its own generator: this list and the case count
 * are written by hand, so adding a field to the evidence without extending the
 * sweep fails here rather than passing silently with one fewer case.
 */
const EVIDENCE_KEYS: readonly string[] = Object.freeze([
  "anchorBindingDigest",
  "backupCursor",
  "backupGenerationDigest",
  "configuredClasses",
  "incarnationRef",
  "items",
  "keyEpochRef",
  "projectId",
  "projectTag",
  "proofs",
  "reconciliationRecordDigest",
  "restoreBindingSlot",
  "restoreCommandId",
  "restoreGenerationDigest",
]);

/** 11 scalars + configuredClasses[0] + 4 proof fields + 6 item fields. */
const EXPECTED_SWEEP_CASES = 22;

const flip = (value: unknown): unknown => {
  if (value === null) return "quarantine-ref-1";
  if (typeof value === "string") return `${value}-mutated`;
  if (typeof value === "number") return value + 1;
  throw new Error(`the sweep cannot flip a ${typeof value} evidence field`);
};

interface SweepCase {
  readonly label: string;
  readonly topKey: string;
  readonly value: RecoveryCompletionEvidence;
}

/** One case per own key, descending into element 0 of every array field. */
function sweepCases(evidence: RecoveryCompletionEvidence): readonly SweepCase[] {
  const source = evidence as unknown as Record<string, unknown>;
  const cases: SweepCase[] = [];
  for (const topKey of Object.keys(source)) {
    const current = source[topKey];
    if (!Array.isArray(current)) {
      cases.push({
        label: topKey,
        topKey,
        value: { ...source, [topKey]: flip(current) } as unknown as RecoveryCompletionEvidence,
      });
      continue;
    }
    const [head, ...tail] = current as readonly unknown[];
    if (head === undefined) throw new Error(`evidence field ${topKey} has no element to flip`);
    if (typeof head !== "object" || head === null) {
      cases.push({
        label: `${topKey}[0]`,
        topKey,
        value: {
          ...source, [topKey]: [flip(head), ...tail],
        } as unknown as RecoveryCompletionEvidence,
      });
      continue;
    }
    const entry = head as Record<string, unknown>;
    for (const entryKey of Object.keys(entry)) {
      cases.push({
        label: `${topKey}[0].${entryKey}`,
        topKey,
        value: {
          ...source,
          [topKey]: [{ ...entry, [entryKey]: flip(entry[entryKey]) }, ...tail],
        } as unknown as RecoveryCompletionEvidence,
      });
    }
  }
  return cases;
}

describe("recovery completion digest", () => {
  it("publishes its own layer, domains and closed refusal vocabulary", () => {
    expect(RECOVERY_COMPLETION_LAYER).toBe("RECOVERY_COMPLETION");
    expect(RECOVERY_COMPLETION_DIGEST_DOMAIN).not.toBe(RECOVERY_COVERAGE_PROOF_DIGEST_DOMAIN);
    for (const code of [
      "RECOVERY_COMPLETION_APPROVAL_INVALID",
      "RECOVERY_COMPLETION_DIGEST_MISMATCH",
      "RECOVERY_COMPLETION_EVIDENCE_ABSENT",
      "RECOVERY_COMPLETION_EVIDENCE_MISMATCH",
      "RECOVERY_COMPLETION_REQUEST_MALFORMED",
      "RECOVERY_COMPLETION_STALE",
      "RECOVERY_COMPLETION_STORE_UNAVAILABLE",
      "RECOVERY_RECONCILIATION_REQUIRED",
    ]) {
      expect(RECOVERY_COMPLETION_CODES).toContain(code);
    }
    expect(Object.isFrozen(RECOVERY_COMPLETION_CODES)).toBe(true);
  });

  it("is a stable hex64 across two calls on equal input", () => {
    const first = recoveryCompletionDigest(EVIDENCE);
    const second = recoveryCompletionDigest({
      ...EVIDENCE,
      configuredClasses: [...EVIDENCE.configuredClasses],
      items: EVIDENCE.items.map((item) => ({ ...item })),
      proofs: EVIDENCE.proofs.map((proof) => ({ ...proof })),
    });
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(second).toBe(first);
  });

  it("is domain-separated from a bare hash of the same canonical preimage", () => {
    const preimage = recoveryCompletionPreimage(EVIDENCE);
    const bare = createHash("sha256").update(preimage).digest("hex");
    expect(bare).toMatch(/^[0-9a-f]{64}$/u);
    expect(recoveryCompletionDigest(EVIDENCE)).not.toBe(bare);
  });

  it("changes on every single-field flip the evidence key set can produce", () => {
    const baseline = recoveryCompletionDigest(EVIDENCE);
    const cases = sweepCases(EVIDENCE);
    // A sweep that silently produced zero cases would pass while testing
    // nothing, so the count and the key census are asserted before the loop.
    expect(cases.length).toBe(EXPECTED_SWEEP_CASES);
    expect([...new Set(cases.map((entry) => entry.topKey))].sort()).toEqual([...EVIDENCE_KEYS]);
    const digests = new Set<string>();
    for (const entry of cases) {
      const digest = recoveryCompletionDigest(entry.value);
      expect(digest, `flipping ${entry.label} must change the digest`).not.toBe(baseline);
      digests.add(digest);
    }
    // Distinct flips must also stay distinct from each other: a preimage that
    // collided two different tuples would be exactly the concatenation defect
    // length framing exists to prevent.
    expect(digests.size).toBe(EXPECTED_SWEEP_CASES);
  });

  it("treats configuredClasses, proof and item ORDER as significant, never normalized", () => {
    const baseline = recoveryCompletionDigest(EVIDENCE);
    expect(recoveryCompletionDigest({
      ...EVIDENCE, configuredClasses: [...EVIDENCE.configuredClasses].reverse(),
    })).not.toBe(baseline);
    expect(recoveryCompletionDigest({
      ...EVIDENCE, proofs: [...EVIDENCE.proofs].reverse(),
    })).not.toBe(baseline);
    expect(recoveryCompletionDigest({
      ...EVIDENCE, items: [...EVIDENCE.items].reverse(),
    })).not.toBe(baseline);
  });

  it("cannot be collided by moving bytes across the cursor/tag boundary", () => {
    // Without per-component length framing "ab" + "c" and "a" + "bc" hash the
    // same. Both halves stay the same total length here, so only framing can
    // tell them apart.
    const left = recoveryCompletionDigest({
      ...EVIDENCE, backupCursor: "00", projectTag: "moe-project:project-1x",
    });
    const right = recoveryCompletionDigest({
      ...EVIDENCE, backupCursor: "x00", projectTag: "moe-project:project-1",
    });
    expect(left).not.toBe(right);
  });

  it("derives the coverage proof hash from classes and proofs under its own domain", () => {
    const coverage = recoveryCoverageProofDigest(EVIDENCE.configuredClasses, EVIDENCE.proofs);
    expect(coverage).toMatch(/^[0-9a-f]{64}$/u);
    expect(coverage).toBe(
      recoveryCoverageProofDigest([...EVIDENCE.configuredClasses], [...EVIDENCE.proofs]),
    );
    expect(coverage).not.toBe(recoveryCompletionDigest(EVIDENCE));
    expect(coverage).not.toBe(
      recoveryCoverageProofDigest([...EVIDENCE.configuredClasses].reverse(), EVIDENCE.proofs),
    );
    expect(coverage).not.toBe(
      recoveryCoverageProofDigest(EVIDENCE.configuredClasses, [...EVIDENCE.proofs].reverse()),
    );
  });
});

// ---------------------------------------------------------------------------
// Service half. Every fixture below is driven through a SHIPPED production
// surface: the real bootstrap commands, the real restore controller, the real
// anchor, the real reconciliation ledger. Nothing here restates a rule the
// service under test owns, and the digest the approval binds to is read back
// through the production evidence reader rather than recomputed test-side.
// ---------------------------------------------------------------------------

const PROJECT_TAG = "moe-project:project-1";
const BACKUP_CURSOR = "000000000000000000042";
/** 60s before the harness decision instant: inside the 300s step-up window. */
const STEP_UP_REF = `${RECOVERY_STEP_UP_REF_PREFIX}2026-08-10T23:59:00.000Z:${hex("5e")}`;
const DECISION_REASON = "R3 cutover approved after external inventory review";

const encoder = new TextEncoder();
let label = 0;

afterAll(() => {
  cleanupRestoreHarnesses();
});

beforeEach(() => {
  label += 1;
});

type SubjectEvidenceFor = (population: string, proofDigest: string) => RecoverySubjectEvidence;

const negativeComplete: SubjectEvidenceFor = (_population, proofDigest) =>
  ({ kind: "NEGATIVE_COMPLETE", proofDigest });

const unresolved: SubjectEvidenceFor = () => ({
  kind: "UNRESOLVED",
  upstream: { code: "RECOVERY_INVENTORY_COVERAGE_UNKNOWN", layer: "RECOVERY_INVENTORY" },
});

const orphaned: SubjectEvidenceFor = (population) => ({
  kind: "ORPHAN", quarantineRef: `quarantine-${population}`,
});

function facts(
  backupGenerationDigest: string,
  evidenceFor: SubjectEvidenceFor,
  backupCursor: string = BACKUP_CURSOR,
): RecoveryReconciliationExternalFacts {
  const classDigest = (proofClass: RecoveryProofClass): string =>
    hex(`c${RECOVERY_PROOF_CLASSES.indexOf(proofClass)}`);
  const subjects: RecoveryReconciliationSubject[] = RECOVERY_INVENTORY_POPULATIONS.map(
    (population) => {
      const proofClass = recoveryPopulationClass(population) as RecoveryProofClass;
      return {
        class: proofClass as string,
        evidence: evidenceFor(population, classDigest(proofClass)),
        identity: `external-${population}`,
        population: population as string,
        sourceProofDigest: classDigest(proofClass),
      };
    },
  );
  return {
    backupCursor,
    backupGenerationDigest,
    configuredClasses: [...RECOVERY_PROOF_CLASSES],
    projectTag: PROJECT_TAG,
    proofs: RECOVERY_PROOF_CLASSES.map((proofClass) => ({
      class: proofClass,
      sourceProofDigest: classDigest(proofClass),
      truth: "COMPLETE" as const,
      upstream: null,
    })),
    subjects,
  };
}

interface Scenario {
  readonly backupGenerationDigest: string;
  readonly digest: string;
  readonly incarnationRef: string;
  readonly recordDigest: string;
  readonly store: SqliteEventStore;
  readonly version: number;
}

/** A real QUIESCED project with a real installed restore, anchor and record. */
async function scenario(evidenceFor: SubjectEvidenceFor = negativeComplete): Promise<Scenario> {
  const harness = await restoreHarness(`complete-${label}`);
  const binding = await anchoredIncarnation(harness, `restore-cmd-${label}`);
  const quiesced = runRestoreQuiesce(harness.store, restoreRequest(harness, binding));
  if (!quiesced.ok) throw new Error(`restore quiesce refused: ${quiesced.code}`);
  const written = recordRecoveryReconciliation(
    harness.store,
    {
      correlationId: "corr-1", decidedAt: DECIDED_AT,
      principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    },
    facts(binding.backupGenerationDigest, evidenceFor),
  );
  if (!written.ok) throw new Error(`reconciliation record refused: ${written.upstream.code}`);
  // The digest comes back through the PRODUCTION reader; a test-side
  // recomputation would be a helper reimplementing the surface it certifies.
  const evidence = readRecoveryCompletionEvidence(harness.store, PROJECT_ID, written.recordDigest);
  return {
    backupGenerationDigest: binding.backupGenerationDigest,
    digest: evidence.ok ? evidence.digest : "",
    incarnationRef: binding.incarnationRef,
    recordDigest: written.recordDigest,
    store: harness.store,
    version: harness.store.getAggregateVersion(PROJECT_ID),
  };
}

/**
 * A SECOND durable record in the same store, differing only in its backup
 * cursor. Both pass every cross-check, so the digest is the only thing that can
 * tell them apart -- which is exactly the DoD-5 case where the world moved
 * after the human approved.
 */
function secondRecordDigest(scene: Scenario, cursor: string): string {
  const written = recordRecoveryReconciliation(
    scene.store,
    {
      correlationId: "corr-2", decidedAt: DECIDED_AT,
      principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    },
    facts(scene.backupGenerationDigest, negativeComplete, cursor),
  );
  if (!written.ok) throw new Error(`second record refused: ${written.upstream.code}`);
  const evidence = readRecoveryCompletionEvidence(
    scene.store, PROJECT_ID, written.recordDigest,
  );
  if (!evidence.ok) throw new Error(`second record evidence refused: ${evidence.code}`);
  return evidence.digest;
}

interface ApprovalOverrides {
  readonly command?: Record<string, unknown>;
  readonly record?: Record<string, unknown>;
}

interface ApprovalPair {
  readonly approval: Record<string, unknown>;
  readonly command: Record<string, unknown>;
}

function approvalPair(digest: string, overrides: ApprovalOverrides = {}): ApprovalPair {
  return {
    approval: {
      actor: "human:operator-1",
      actorKind: "HUMAN",
      applicablePolicyRef: hex("aa"),
      approvalRef: "approval-recovery-r3-1",
      approvedNodeScope: [],
      budgetRef: hex("bb"),
      criteriaRef: hex("cc"),
      decision: null,
      decisionReason: null,
      dependencyChanges: { additions: [], challenges: [], removals: [] },
      exactRevisionHash: digest,
      lifecycle: "PENDING",
      planQualityAssessmentRef: hex("dd"),
      policyDecisionRef: null,
      riskTier: "R3",
      stepUpAuthRef: STEP_UP_REF,
      truthClass: "HUMAN_APPROVED",
      validity: "CURRENT",
      ...overrides.record,
    },
    command: {
      decision: "APPROVE",
      decisionReason: DECISION_REASON,
      kind: "approval.decide",
      stepUpAuthRef: STEP_UP_REF,
      ...overrides.command,
    },
  };
}

interface RequestOptions {
  readonly approvals?: ApprovalOverrides;
  readonly commandId?: string;
  readonly envelope?: Record<string, unknown>;
  readonly payload?: Record<string, unknown>;
  readonly reconciliationDigest?: string;
}

function requestBytes(scene: Scenario, options: RequestOptions = {}): Uint8Array {
  const pair = approvalPair(scene.digest, options.approvals ?? {});
  return encoder.encode(JSON.stringify({
    commandId: options.commandId ?? "recovery-complete-1",
    correlationId: "corr-complete-1",
    decidedAt: DECIDED_AT,
    expectedVersion: scene.version,
    kind: "recovery.complete",
    payload: {
      approval: pair.approval,
      command: pair.command,
      reconciliationDigest: options.reconciliationDigest ?? scene.recordDigest,
      ...options.payload,
    },
    principalId: PRINCIPAL_ID,
    projectId: PROJECT_ID,
    schemaVersion: RECOVERY_COMPLETION_SCHEMA_VERSION,
    ...options.envelope,
  }));
}

const projectEvents = (store: SqliteEventStore): readonly string[] =>
  store.readAggregateEvents(PROJECT_ID, 0, 100).items.map((event) => event.eventType);

const projectState = (store: SqliteEventStore): Record<string, unknown> => {
  const state = stateOf(readDurableLedger(store, PROJECT_ID), PROJECT_ID);
  if (state === null || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("the seeded project must have durable state");
  }
  return state as Record<string, unknown>;
};

const recoveredCount = (store: SqliteEventStore): number =>
  projectEvents(store).filter((kind) => kind === "ProjectRecovered").length;

/** No refusal may leave a decision, an event, or a cleared quiesce behind. */
function expectNothingWritten(scene: Scenario, commandId = "recovery-complete-1"): void {
  expect(scene.store.getCommandDecision({
    commandId, principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
  })).toBeNull();
  expect(recoveredCount(scene.store)).toBe(0);
  expect(projectState(scene.store)["lifecycle"]).toBe("QUIESCED");
  expect(projectState(scene.store)["recoveryRequired"]).toBe(true);
}

describe("recovery.complete durable command", () => {
  it("commits one decision, one event, and clears QUIESCED for the exact evidence", async () => {
    const scene = await scenario();
    expect(scene.digest).toMatch(/^[0-9a-f]{64}$/u);
    const outcome = runRecoveryCompleteCommand(scene.store, requestBytes(scene));

    expect(outcome.ok, outcome.ok ? "" : outcome.code).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.disposition).toBe("DECIDED");
    expect(outcome.authority).toBe("DURABLE_DECISION");
    expect(outcome.witness.truthClass).toBe("HUMAN_APPROVED");
    expect(outcome.witness.recoveryIncarnationRef).toBe(scene.incarnationRef);
    expect(outcome.witness.inventoryReconciliationHash).toBe(scene.recordDigest);
    expect(outcome.witness.recoveryDecisionRef).toBe("approval-recovery-r3-1");

    expect(recoveredCount(scene.store)).toBe(1);
    // The effect embargo is a PURE FUNCTION of this state, so asserting the
    // state in the same committed sequence IS asserting the embargo release.
    expect(projectState(scene.store)["lifecycle"]).toBe("READY");
    expect(projectState(scene.store)["recoveryRequired"]).toBe(false);
    expect(projectState(scene.store)["version"]).toBe(scene.version + 1);
  });

  it("answers a replayed commandId from the store without a second transition", async () => {
    const scene = await scenario();
    const first = runRecoveryCompleteCommand(scene.store, requestBytes(scene));
    expect(first.ok, first.ok ? "" : first.code).toBe(true);
    const second = runRecoveryCompleteCommand(scene.store, requestBytes(scene));

    expect(second.ok).toBe(true);
    if (!second.ok || !first.ok) throw new Error("unreachable");
    expect(second.disposition).toBe("REPLAYED");
    expect(second.decision.decisionId).toBe(first.decision.decisionId);
    expect(recoveredCount(scene.store)).toBe(1);
    expect(projectState(scene.store)["version"]).toBe(scene.version + 1);
  });

  it("refuses a malformed envelope at DAEMON_INGRESS before any evidence is read", async () => {
    const scene = await scenario();
    const cases: readonly (readonly [string, unknown])[] = [
      ["not bytes", "recovery.complete"],
      ["wrong kind", requestBytes(scene, { envelope: { kind: "recovery.restore_quiesce" } })],
      ["smuggled payload key", requestBytes(scene, { payload: { truthClass: "HUMAN_APPROVED" } })],
      ["smuggled witness", requestBytes(scene, { payload: { witness: {} } })],
      ["missing payload key", encoder.encode(JSON.stringify({
        commandId: "recovery-complete-1", correlationId: "corr-complete-1",
        decidedAt: DECIDED_AT, expectedVersion: scene.version, kind: "recovery.complete",
        payload: { reconciliationDigest: scene.recordDigest }, principalId: PRINCIPAL_ID,
        projectId: PROJECT_ID, schemaVersion: RECOVERY_COMPLETION_SCHEMA_VERSION,
      }))],
    ];
    expect(cases).toHaveLength(5);
    for (const [name, bytes] of cases) {
      const outcome = runRecoveryCompleteCommand(scene.store, bytes);
      expect(outcome.ok, name).toBe(false);
      if (outcome.ok) throw new Error("unreachable");
      expect(outcome.code, name).toBe("RECOVERY_COMPLETION_REQUEST_MALFORMED");
      expect(outcome.refusedBy, name).toBe("DAEMON_INGRESS");
      expect(outcome.upstream, name).toBeNull();
    }
    expectNothingWritten(scene);
  });

  it("surfaces the ledger's own RECORD_NOT_FOUND for an unknown reconciliation digest",
    async () => {
      const scene = await scenario();
      const outcome = runRecoveryCompleteCommand(
        scene.store, requestBytes(scene, { reconciliationDigest: hex("dead") }),
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("unreachable");
      expect(outcome.code).toBe("UNKNOWN_TRUTH");
      expect(outcome.refusedBy).toBe("RECOVERY_INVENTORY");
      expect(outcome.upstream).toEqual({
        code: "RECORD_NOT_FOUND", layer: "RECOVERY_INVENTORY_LEDGER",
      });
      expectNothingWritten(scene);
    });

  it("refuses an UNKNOWN-truth record with the inventory's own coordinator answer", async () => {
    const scene = await scenario(unresolved);
    const outcome = runRecoveryCompleteCommand(scene.store, requestBytes(scene));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.code).toBe("UNKNOWN_TRUTH");
    expect(outcome.refusedBy).toBe("RECOVERY_INVENTORY");
    expect(outcome.upstream?.code).toBe("RECOVERY_INVENTORY_ITEM_UNRESOLVED");
    expectNothingWritten(scene);
  });

  it("refuses a COMPLETE record that still carries a QUARANTINED item", async () => {
    // deriveRecoveryReconciliationTruth treats only UNKNOWN as incomplete, so
    // this record's own truth IS "COMPLETE" with a null coordinator. This
    // service is the only thing standing between a quarantined external object
    // and a cleared quiesce.
    const scene = await scenario(orphaned);
    const outcome = runRecoveryCompleteCommand(scene.store, requestBytes(scene));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.code).toBe("RECOVERY_RECONCILIATION_REQUIRED");
    expect(outcome.refusedBy).toBe("RECOVERY_INVENTORY");
    expectNothingWritten(scene);
  });

  it("refuses a digest the approval did not bind, at RECOVERY_COMPLETION", async () => {
    const scene = await scenario();
    const outcome = runRecoveryCompleteCommand(scene.store, requestBytes(scene, {
      approvals: { record: { exactRevisionHash: hex("beef") } },
    }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.code).toBe("RECOVERY_COMPLETION_DIGEST_MISMATCH");
    expect(outcome.refusedBy).toBe("RECOVERY_COMPLETION");
    expectNothingWritten(scene);
  });

  it("refuses when the world moved after the approval, leaving the project quiesced", async () => {
    const scene = await scenario();
    // Both records are real, durable, and pass every cross-check; they differ
    // only in the backup cursor the digest frames. The human approved one of
    // them, and the request points at the other.
    const approved = secondRecordDigest(scene, "000000000000000000043");
    expect(approved).not.toBe(scene.digest);
    const outcome = runRecoveryCompleteCommand(scene.store, requestBytes(scene, {
      approvals: { record: { exactRevisionHash: approved } },
    }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.code).toBe("RECOVERY_COMPLETION_DIGEST_MISMATCH");
    expect(outcome.refusedBy).toBe("RECOVERY_COMPLETION");
    expectNothingWritten(scene);
  });

  it("lets core answer first for a SYSTEM_POLICY record that claims R3", async () => {
    const scene = await scenario();
    const outcome = runRecoveryCompleteCommand(scene.store, requestBytes(scene, {
      approvals: {
        command: { stepUpAuthRef: null },
        record: {
          actor: `policy:${hex("f1")}`, actorKind: "SYSTEM_POLICY",
          policyDecisionRef: hex("f2"), stepUpAuthRef: null, truthClass: "DAEMON_VERIFIED",
        },
      },
    }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    // core's validActorAuthority confines SYSTEM_POLICY to R0/R1, so the record
    // is invalid input to CORE before this layer's tier check is ever reached.
    expect(outcome.code).toBe("INPUT_INVALID");
    expect(outcome.refusedBy).toBe("CORE_APPROVAL");
    expectNothingWritten(scene);
  });

  it("refuses a SYSTEM_POLICY approval core accepts, because R3 is human-only", async () => {
    const scene = await scenario();
    const outcome = runRecoveryCompleteCommand(scene.store, requestBytes(scene, {
      approvals: {
        command: { stepUpAuthRef: null },
        record: {
          actor: `policy:${hex("f1")}`, actorKind: "SYSTEM_POLICY", policyDecisionRef: hex("f2"),
          riskTier: "R1", stepUpAuthRef: null, truthClass: "DAEMON_VERIFIED",
        },
      },
    }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.code).toBe("RECOVERY_COMPLETION_APPROVAL_INVALID");
    expect(outcome.refusedBy).toBe("RECOVERY_COMPLETION");
    expectNothingWritten(scene);
  });

  it("refuses every approval binding weaker than a current, reasoned, stepped-up R3", async () => {
    const stale = `${RECOVERY_STEP_UP_REF_PREFIX}2026-08-10T23:50:00.000Z:${hex("5e")}`;
    const future = `${RECOVERY_STEP_UP_REF_PREFIX}2026-08-11T00:01:00.000Z:${hex("5e")}`;
    const cases: readonly (readonly [string, ApprovalOverrides, string, string])[] = [
      ["R2 tier", { record: { riskTier: "R2" } },
        "RECOVERY_COMPLETION_APPROVAL_INVALID", "RECOVERY_COMPLETION"],
      ["a REJECT decision", { command: { decision: "REJECT" } },
        "RECOVERY_COMPLETION_APPROVAL_INVALID", "RECOVERY_COMPLETION"],
      ["an opaque step-up ref",
        { command: { stepUpAuthRef: "stepup-1" }, record: { stepUpAuthRef: "stepup-1" } },
        "RECOVERY_COMPLETION_APPROVAL_INVALID", "RECOVERY_COMPLETION"],
      ["a step-up outside the 300s window",
        { command: { stepUpAuthRef: stale }, record: { stepUpAuthRef: stale } },
        "RECOVERY_COMPLETION_APPROVAL_INVALID", "RECOVERY_COMPLETION"],
      ["a step-up dated after the decision",
        { command: { stepUpAuthRef: future }, record: { stepUpAuthRef: future } },
        "RECOVERY_COMPLETION_APPROVAL_INVALID", "RECOVERY_COMPLETION"],
      ["an absent decision reason", { command: { decisionReason: null } },
        "ILLEGAL_TRANSITION", "CORE_APPROVAL"],
      ["an empty decision reason", { command: { decisionReason: "" } },
        "INPUT_INVALID", "CORE_APPROVAL"],
      ["an already DECIDED lifecycle",
        { record: { decision: "APPROVE", lifecycle: "DECIDED" } },
        "ILLEGAL_TRANSITION", "CORE_APPROVAL"],
      ["an INVALIDATED approval", { record: { validity: "INVALIDATED" } },
        "ILLEGAL_TRANSITION", "CORE_APPROVAL"],
    ];
    expect(cases).toHaveLength(9);
    for (const [name, overrides, code, layer] of cases) {
      const scene = await scenario();
      const outcome = runRecoveryCompleteCommand(
        scene.store, requestBytes(scene, { approvals: overrides }),
      );
      expect(outcome.ok, name).toBe(false);
      if (outcome.ok) throw new Error("unreachable");
      expect(outcome.code, name).toBe(code);
      expect(outcome.refusedBy, name).toBe(layer);
      expectNothingWritten(scene);
    }
  });

  it("refuses a stale expectedVersion at this layer before core sees a command", async () => {
    const scene = await scenario();
    const outcome = runRecoveryCompleteCommand(scene.store, requestBytes(scene, {
      envelope: { expectedVersion: scene.version - 1 },
    }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.code).toBe("RECOVERY_COMPLETION_STALE");
    expect(outcome.refusedBy).toBe("RECOVERY_COMPLETION");
    expectNothingWritten(scene);
  });

  it("refuses a second completion on an already-recovered project", async () => {
    const scene = await scenario();
    const first = runRecoveryCompleteCommand(scene.store, requestBytes(scene));
    expect(first.ok, first.ok ? "" : first.code).toBe(true);
    const after: Scenario = { ...scene, version: scene.store.getAggregateVersion(PROJECT_ID) };
    const outcome = runRecoveryCompleteCommand(
      scene.store, requestBytes(after, { commandId: "recovery-complete-2" }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    // The project is READY, so the QUIESCED evidence cross-check answers before
    // the reducer's own transition table is consulted.
    expect(outcome.code).toBe("RECOVERY_COMPLETION_EVIDENCE_MISMATCH");
    expect(outcome.refusedBy).toBe("RECOVERY_COMPLETION");
    expect(recoveredCount(scene.store)).toBe(1);
  });

  it("refuses a record whose project never installed a restore, before any other gate",
    async () => {
      // A REAL anchored incarnation and a REAL durable record, but the ACTIVE
      // slot holds bytes that are not a restore record — so the store never
      // restored. The evidence reader consults the installed restore before the
      // anchor and before project state, and this pins that it answers first.
      const harness = await restoreHarness(`absent-${label}`);
      const binding = await anchoredIncarnation(harness, `restore-cmd-absent-${label}`);
      expect(harness.store.installRecoveryBinding({
        bindingCodecVersion: RECOVERY_BINDING_CODEC_VERSION,
        incarnationRef: binding.incarnationRef,
        installedAt: DECIDED_AT,
        keyEpochRef: binding.keyEpochRef,
        payload: encoder.encode("not-a-restore-record"),
        slot: "ACTIVE",
      })).toMatchObject({ ok: true, outcome: "INSTALLED" });
      const written = recordRecoveryReconciliation(
        harness.store,
        {
          correlationId: "corr-1", decidedAt: DECIDED_AT,
          principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
        },
        facts(binding.backupGenerationDigest, negativeComplete),
      );
      expect(written.ok).toBe(true);
      if (!written.ok) throw new Error("unreachable");

      const scene: Scenario = {
        backupGenerationDigest: binding.backupGenerationDigest,
        digest: "",
        incarnationRef: binding.incarnationRef,
        recordDigest: written.recordDigest,
        store: harness.store,
        version: harness.store.getAggregateVersion(PROJECT_ID),
      };
      const outcome = runRecoveryCompleteCommand(scene.store, requestBytes(scene));
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("unreachable");
      expect(outcome.code).toBe("RECOVERY_COMPLETION_EVIDENCE_ABSENT");
      expect(outcome.refusedBy).toBe("RECOVERY_COMPLETION");
      // The restore controller's own code rides along rather than being
      // flattened into a bare "not available".
      expect(outcome.upstream?.layer).toBe("DAEMON_RESTORE_CONTROLLER");
      expect(scene.store.getCommandDecision({
        commandId: "recovery-complete-1", principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
      })).toBeNull();
      expect(recoveredCount(scene.store)).toBe(0);
    });

  it("refuses a reconciliation record minted against another project's restore", async () => {
    const first = await scenario();
    const second = await scenario();
    const outcome = runRecoveryCompleteCommand(first.store, requestBytes(first, {
      reconciliationDigest: second.recordDigest,
    }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.code).toBe("UNKNOWN_TRUTH");
    expect(outcome.refusedBy).toBe("RECOVERY_INVENTORY");
    expect(outcome.upstream?.layer).toBe("RECOVERY_INVENTORY_LEDGER");
    expectNothingWritten(first);
  });
});
