/**
 * DoD 3 — a missing inventory, artifact proof or key proof keeps recovery
 * UNAVAILABLE, answered as UNKNOWN_TRUTH at RECOVERY_INVENTORY.
 *
 * Production always answers that ONE coordinator code, so the code alone cannot
 * tell the three absences apart; the upstream tuple is what carries provenance
 * and every case pins it. Distinctness is enforced at the end over the upstreams
 * PRODUCTION RETURNED — each case hands its target-absence upstream to
 * `observeUpstream` BEFORE pinning it, so a future collapse into a single "not
 * available" reddens the distinctness assertion itself and not merely the
 * per-case pins. Asserting distinctness over restated literals would be
 * unkillable: distinct literals are distinct under every production change.
 *
 * Each fixture is built VALID at every earlier layer and lacks only its target
 * proof. Case 2 proves that explicitly: the record is recorded, the ledger reads
 * it back as FOUND, and the five non-artifact proof classes are COMPLETE — so
 * the guard under test is the one that answers, not an earlier one.
 */
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  RECOVERY_BINDING_CODEC_VERSION,
  RECOVERY_BINDING_SLOTS,
} from "../../../packages/store/src/index.js";
import type { SqliteEventStore } from "../../../packages/store/src/index.js";
import {
  RECOVERY_COMPLETE_PAYLOAD_KEYS,
  RECOVERY_COMPLETION_SCHEMA_VERSION,
  anchorIncarnation,
  createNodeRecoveryCryptoPort,
  createRecoveryIncarnationService,
  readRecoveryCompletionEvidence,
  readRecoveryReconciliation,
  recordRecoveryReconciliation,
  runRecoveryCompleteCommand,
} from "@moe/daemon";
import type {
  RecoveryCompletionUpstream,
  RecoveryInventoryRefusal,
  RestoreIncarnationBinding,
} from "@moe/daemon";

import {
  DISASTER_PREPARED_AT,
  DISASTER_PRINCIPAL_ID,
  DISASTER_PROJECT_ID,
  cleanupDisasterRoots,
  openDisasterStore,
  recoveryCompleteEnvelope,
  seedGeneration,
  unreachableAuthority,
} from "./disaster-harness.js";
import type { SeededGeneration } from "./disaster-harness.js";

/**
 * Hand-written. `RECOVERY_PROOF_CLASSES` is not a value export, so the list is
 * policed the other way round: it is fed to the builder and the RECORDED
 * record's own `configuredClasses` is compared back against it. A seventh
 * production class would make the builder refuse CLASS_OMITTED and redden here.
 */
const PROOF_CLASSES = Object.freeze([
  "PROVIDER_PROCESS_LAUNCH_LOCK",
  "RESOURCE",
  "WORKSPACE",
  "INTEGRATION_TARGET",
  "GIT_INTEGRATION_ON_DISK",
  "ARTIFACT_OBJECT_STAGING",
] as const);

const ARTIFACT_CLASS = "ARTIFACT_OBJECT_STAGING";
const UNKNOWN_PROOF_DIGEST = "0".repeat(64);
const ABSENT_DIGEST = "ab".repeat(32);

const writeRequest = {
  correlationId: "correlation-disaster-unknown",
  decidedAt: DISASTER_PREPARED_AT,
  principalId: DISASTER_PRINCIPAL_ID,
  projectId: DISASTER_PROJECT_ID,
};

let generation: SeededGeneration;
let identity: RestoreIncarnationBinding;

/**
 * The upstream tuple production ACTUALLY returned for each case's target
 * absence, keyed by case. The type is the UNION OF THE TWO PRODUCTION UPSTREAM
 * TYPES the three cases answer with — the inventory ledger's and the completion
 * evidence reader's — rather than a locally restated `{ code, layer }`. A
 * restated shape is what let the previous version of the closing test detach
 * from its subject.
 */
type ObservedUpstream = RecoveryInventoryRefusal["upstream"] | RecoveryCompletionUpstream;

const observedUpstreams = new Map<string, ObservedUpstream>();

/**
 * Records what production answered, and is called BEFORE the per-case pin on
 * purpose: if a collapse makes two cases agree, the map still holds three
 * entries and the distinctness test fails on distinctness rather than being
 * pre-empted by a per-case `toEqual`.
 *
 * A null upstream is refused rather than skipped. Production losing the tuple
 * entirely is exactly the provenance collapse this file exists to catch, so it
 * must not silently shrink the observed set into a vacuous pass.
 */
function observeUpstream(label: string, upstream: ObservedUpstream | null): void {
  expect(upstream, `${label} returned no upstream tuple`).not.toBeNull();
  if (upstream === null) throw new Error(`${label} returned no upstream tuple`);
  observedUpstreams.set(label, upstream);
}

beforeAll(async () => {
  generation = await seedGeneration("unknown-truth");
  const minted = await createRecoveryIncarnationService(createNodeRecoveryCryptoPort()).mint({
    backupGenerationDigest: generation.generationDigest,
    restoreCommandId: "restore-command-unknown-truth",
  });
  if (!minted.ok) throw new Error(`mint refused: ${minted.code}`);
  identity = minted.binding;
}, 60_000);

function caseStore(label: string): SqliteEventStore {
  return openDisasterStore(join(generation.root, `${label}.db`));
}

function installBinding(store: SqliteEventStore): void {
  const installed = store.installRecoveryBinding({
    bindingCodecVersion: RECOVERY_BINDING_CODEC_VERSION,
    incarnationRef: identity.incarnationRef,
    installedAt: DISASTER_PREPARED_AT,
    keyEpochRef: identity.keyEpochRef,
    payload: new TextEncoder().encode(generation.generationDigest),
    slot: RECOVERY_BINDING_SLOTS[0],
  });
  if (!installed.ok) throw new Error(`binding install refused: ${installed.code}`);
}

/** Facts with a COMPLETE proof row for every class except the omitted one. */
function facts(omitted: string | null): Record<string, unknown> {
  return {
    backupCursor: "0",
    backupGenerationDigest: generation.generationDigest,
    configuredClasses: [...PROOF_CLASSES],
    projectTag: "disaster-tag",
    proofs: PROOF_CLASSES.filter((entry) => entry !== omitted).map((entry, index) => ({
      class: entry,
      sourceProofDigest: `${String(index + 1).repeat(2)}`.repeat(32).slice(0, 64),
      truth: "COMPLETE",
      upstream: null,
    })),
    subjects: [],
  };
}

interface Withheld {
  readonly command: ReturnType<typeof runRecoveryCompleteCommand>;
  readonly decisionAfter: unknown;
  readonly recoveredEvents: number;
  readonly versionMoved: boolean;
}

/**
 * Drives the real command and measures what it did NOT do. A reader answering
 * UNKNOWN is not the same fact as authority being withheld, so both are read.
 */
function driveCompletion(store: SqliteEventStore, label: string, digest: string): Withheld {
  const commandId = `recovery-complete-${label}`;
  const before = store.getAggregateVersion(DISASTER_PROJECT_ID);
  const command = runRecoveryCompleteCommand(
    store,
    recoveryCompleteEnvelope({
      commandId,
      payloadKeys: RECOVERY_COMPLETE_PAYLOAD_KEYS,
      reconciliationDigest: digest,
      schemaVersion: RECOVERY_COMPLETION_SCHEMA_VERSION,
    }),
    unreachableAuthority(),
  );
  return {
    command,
    decisionAfter: store.getCommandDecision({
      commandId,
      principalId: DISASTER_PRINCIPAL_ID,
      projectId: DISASTER_PROJECT_ID,
    }),
    recoveredEvents: store
      .readAggregateEvents(DISASTER_PROJECT_ID, 0, 100)
      .items.filter((event) => event.eventType === "ProjectRecovered").length,
    versionMoved: store.getAggregateVersion(DISASTER_PROJECT_ID) !== before,
  };
}

/** Recovery stayed unavailable, and nothing durable moved while it did. */
function expectWithheld(withheld: Withheld, upstreamCode: string, upstreamLayer: string): void {
  const { command } = withheld;
  expect(command.ok).toBe(false);
  if (command.ok) throw new Error("a missing proof must never complete recovery");
  expect(command.code).toBe("UNKNOWN_TRUTH");
  expect(command.refusedBy).toBe("RECOVERY_INVENTORY");
  expect(command.upstream).toEqual({ code: upstreamCode, layer: upstreamLayer });
  expect(command.authority).toBe("NONE");
  // The negatives: no lifecycle transition, no appended completion, no decision.
  expect(withheld.versionMoved).toBe(false);
  expect(withheld.recoveredEvents).toBe(0);
  expect(withheld.decisionAfter).toBeNull();
}

describe("a missing inventory, artifact proof or key proof keeps recovery UNKNOWN", () => {
  afterAll(cleanupDisasterRoots);

  it("case 1: no recorded inventory at all", () => {
    const store = caseStore("no-inventory");
    const read = readRecoveryReconciliation(store, DISASTER_PROJECT_ID, ABSENT_DIGEST);
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("an unrecorded digest must not read as FOUND");
    expect(read.code).toBe("UNKNOWN_TRUTH");
    expect(read.layer).toBe("RECOVERY_INVENTORY");
    observeUpstream("case 1: absent inventory", read.upstream);
    expect(read.upstream).toEqual({
      code: "RECORD_NOT_FOUND",
      layer: "RECOVERY_INVENTORY_LEDGER",
    });

    const evidence = readRecoveryCompletionEvidence(store, DISASTER_PROJECT_ID, ABSENT_DIGEST);
    expect(evidence.ok).toBe(false);
    if (evidence.ok) throw new Error("absent inventory must not assemble evidence");
    expect(evidence.code).toBe("UNKNOWN_TRUTH");
    expect(evidence.refusedBy).toBe("RECOVERY_INVENTORY");
    expect(evidence.upstream).toEqual({
      code: "RECORD_NOT_FOUND",
      layer: "RECOVERY_INVENTORY_LEDGER",
    });

    expectWithheld(
      driveCompletion(store, "no-inventory", ABSENT_DIGEST),
      "RECORD_NOT_FOUND",
      "RECOVERY_INVENTORY_LEDGER",
    );
  });

  it("case 2: a recorded inventory whose ARTIFACT proof is absent", () => {
    const store = caseStore("no-artifact-proof");
    if (!anchorIncarnation(store, writeRequest, identity)) throw new Error("anchor failed");
    installBinding(store);

    const recorded = recordRecoveryReconciliation(store, writeRequest, facts(ARTIFACT_CLASS));
    if (!recorded.ok) throw new Error(`recording refused: ${recorded.upstream.code}`);
    // Valid at every EARLIER layer: the record exists and the ledger reads it
    // back, so the truth gate below is genuinely the guard that answers.
    expect(recorded.record.configuredClasses).toEqual([...PROOF_CLASSES]);
    const found = readRecoveryReconciliation(store, DISASTER_PROJECT_ID, recorded.recordDigest);
    expect(found.ok).toBe(true);

    // Only the artifact proof is missing; the other five are COMPLETE.
    const artifact = recorded.record.proofs.find((proof) => proof.class === ARTIFACT_CLASS);
    expect(artifact?.truth).toBe("UNKNOWN");
    expect(artifact?.sourceProofDigest).toBe(UNKNOWN_PROOF_DIGEST);
    expect(artifact?.upstream).toEqual({
      code: "RECOVERY_INVENTORY_PROOF_MISSING",
      layer: "RECOVERY_INVENTORY",
    });
    expect(
      recorded.record.proofs.filter((proof) => proof.truth !== "COMPLETE").map((p) => p.class),
    ).toEqual([ARTIFACT_CLASS]);
    expect(recorded.record.truth).toBe("UNKNOWN");

    const evidence = readRecoveryCompletionEvidence(
      store,
      DISASTER_PROJECT_ID,
      recorded.recordDigest,
    );
    expect(evidence.ok).toBe(false);
    if (evidence.ok) throw new Error("an incomplete proof set must not assemble evidence");
    expect(evidence.code).toBe("UNKNOWN_TRUTH");
    expect(evidence.refusedBy).toBe("RECOVERY_INVENTORY");
    observeUpstream("case 2: absent artifact proof", evidence.upstream);
    expect(evidence.upstream).toEqual({
      code: "RECOVERY_INVENTORY_PROOF_INCOMPLETE",
      layer: "RECOVERY_INVENTORY",
    });

    expectWithheld(
      driveCompletion(store, "no-artifact-proof", recorded.recordDigest),
      "RECOVERY_INVENTORY_PROOF_INCOMPLETE",
      "RECOVERY_INVENTORY",
    );
  });

  it("case 3: an anchored incarnation whose installed key-epoch proof is absent", () => {
    const store = caseStore("no-key-proof");
    // Anchored, so the incarnation half is present and cannot be what refuses.
    if (!anchorIncarnation(store, writeRequest, identity)) throw new Error("anchor failed");

    const refused = recordRecoveryReconciliation(store, writeRequest, facts(null));
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("no key-epoch proof must not record a reconciliation");
    expect(refused.code).toBe("UNKNOWN_TRUTH");
    expect(refused.layer).toBe("RECOVERY_INVENTORY");
    observeUpstream("case 3: absent key-epoch proof", refused.upstream);
    expect(refused.upstream).toEqual({
      code: "RECOVERY_BINDING_UNAVAILABLE",
      layer: "RECOVERY_INVENTORY_LEDGER",
    });

    // Nothing was recorded, so recovery is unavailable downstream as well.
    expectWithheld(
      driveCompletion(store, "no-key-proof", ABSENT_DIGEST),
      "RECORD_NOT_FOUND",
      "RECOVERY_INVENTORY_LEDGER",
    );
  });

  // ORDER-DEPENDENT BY DESIGN, and it fails closed. This case reads what cases
  // 1-3 observed, so running it alone (`.only`, a name filter, a shuffled
  // sequence) leaves the map short and the size assertion below reddens. That is
  // the intended direction: without the three cases there is nothing to compare,
  // and a silent pass on an empty set is the exact defect this replaced.
  it("keeps the three absences distinguishable by upstream, not by code", () => {
    // Read from what production RETURNED in cases 1-3, never from restated
    // literals: a local array of three distinct strings is distinct under every
    // possible production change and so could not fail.
    const observed = [...observedUpstreams.values()];
    // The sweep actually swept. Without this, a case that stopped observing
    // would leave this test comparing an empty set against itself and passing.
    expect(observedUpstreams.size).toBe(3);

    // Every case answered the SAME coordinator code upstream of here, which is
    // precisely why the code cannot tell them apart and the tuple must.
    expect(new Set(observed.map((upstream) => upstream.code)).size).toBe(observed.length);
    expect(
      new Set(observed.map((upstream) => `${upstream.code}@${upstream.layer}`)).size,
    ).toBe(observed.length);
  });
});
