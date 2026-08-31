import { rmSync } from "node:fs";

import {
  CLAUDE_LAUNCHER_VERSION, buildInputManifest, buildProviderRuntimeObservation, observeScope,
} from "@moe/runner";
import type { DeclaredInput, GitObserver, ProviderRuntimeObservation } from "@moe/runner";
import type { SqliteEventStore } from "@moe/store";

import {
  ACTIVATION_INGRESS_SCHEMA_VERSION, EFFECT_ACTIVATE_COMMAND_KIND,
} from "../../apps/daemon/src/activation/activation-ingress-contracts.js";
import { runEffectActivateCommand } from "../../apps/daemon/src/activation/activation-ingress.js";
import { deriveActivationAggregateId } from "../../apps/daemon/src/activation/activation-ledger-contracts.js";
import { readFoundationActivationHistory } from "../../apps/daemon/src/activation/activation-ledger-reader.js";
import { createFoundationLauncherAuthority } from "../../apps/daemon/src/activation/foundation-launch-authority.js";
import {
  candidateTreeEntries, materializeCandidateTree,
} from "../../apps/daemon/src/evidence/foundation-verification-tree-fixtures.js";
import type { CandidateTree } from "../../apps/daemon/src/evidence/foundation-verification-tree-fixtures.js";
import { createFoundationVerificationService } from "../../apps/daemon/src/evidence/foundation-verification-service.js";
import { PRINCIPAL_ID, PROJECT_ID } from "../../apps/daemon/src/recovery/restore-test-harness.js";
import { encodeFoundationPayload } from "../../apps/daemon/src/work/foundation-attempt-codec.js";
import {
  FOUNDATION_RESERVATION_VERSION, deriveDispatchAggregateId,
} from "../../apps/daemon/src/work/foundation-attempt-contracts.js";
import type { FoundationAttemptBound } from "../../apps/daemon/src/work/foundation-attempt-contracts.js";
import {
  commitFoundationPhase,
  readDurableFoundationObservation,
  readFoundationAttemptRecord,
  recordProvenFoundationAttempt,
} from "../../apps/daemon/src/work/foundation-attempt-store.js";

const encoder = new TextEncoder();
const DECIDED_AT = "2026-08-15T00:00:00.000Z";
const DIGEST = "a".repeat(64);
const DIGEST_A = "2".repeat(64);
const DIGEST_B = "3".repeat(64);
const DIGEST_C = "4".repeat(64);
const EXIT_ZERO = Object.freeze([process.execPath, "-e", "process.exit(0)"]);
const VERIFIER_IDENTITY = Object.freeze({
  capabilitySchemaDigest: DIGEST_B,
  verifierId: "moe-verifier",
  verifierVersion: "1.0.0",
});

const scratchRoots: string[] = [];
let seedOrdinal = 0;

/** Candidate roots outlive the real verifier child until the security suite's afterAll. */
export function cleanupGoalClosureVerificationFixtures(): void {
  while (scratchRoots.length > 0) {
    const root = scratchRoots.pop();
    if (root !== undefined) {
      rmSync(root, { force: true, maxRetries: 20, recursive: true, retryDelay: 250 });
    }
  }
}

/** Globally unique because the runner's grant registry survives individual fixture stores. */
function nextLabel(nodeRef: string): string {
  seedOrdinal += 1;
  return `${nodeRef.replace(/[^0-9a-zA-Z-]/gu, "-")}-${String(seedOrdinal)}`;
}

function leaseRecord(label: string): Record<string, unknown> {
  return {
    authorityHashRef: DIGEST, bootId: "boot-1", epoch: 3, kind: "ASSIGNMENT",
    leaseId: `lease-${label}`, leaseToken: `token-${label}`, monotonicObservation: 500,
    ownerSessionRef: `session-${label}`, serverWallDeadline: 1_000, state: "ACTIVE", version: 7,
  };
}

function leaseProof(label: string): Record<string, unknown> {
  return {
    authorityHashRef: DIGEST, epoch: 3, expectedVersion: 7,
    leaseToken: `token-${label}`, ownerSessionRef: `session-${label}`,
  };
}

function activationBytes(label: string): Uint8Array {
  const intentId = `intent-${label}`;
  const lease = leaseRecord(label);
  const proof = leaseProof(label);
  return encoder.encode(JSON.stringify({
    commandId: `cmd-activate-${label}`, correlationId: `corr-${label}`, decidedAt: DECIDED_AT,
    expectedVersion: 0, kind: EFFECT_ACTIVATE_COMMAND_KIND,
    payload: {
      activation: {
        attempt: {
          aggregateId: `agg-${label}`, attemptId: `attempt-${label}`, intentId,
          state: "LAUNCH_REQUESTED", version: 0,
        },
        claim: {
          claimId: `claim-${label}`, claimedAt: DECIDED_AT, intentId,
          lockIdentity: `lock-${label}`, wrapperIdentity: `wrapper-${label}`,
        },
        dependencyWitnesses: [], desiredState: "ACTIVE", leaseProof: proof,
        lockIdentity: `lock-${label}`, observedGraphEpoch: 4, observedRuntimeDigest: DIGEST,
        tombstone: null, wrapperIdentity: `wrapper-${label}`,
      },
      effect: {
        command: { kind: "claim" },
        intent: {
          aggregateId: `agg-${label}`, desiredState: "ACTIVE", expectedGraphEpoch: 4,
          idempotencyKey: `idem-${label}`, inputBinding: DIGEST, intentId, leaseBinding: lease,
          predecessorCursor: `cursor-${label}`, protocolVersion: "moe-effect-intent/1",
          runtimeObservationDigest: DIGEST, state: "PENDING", version: 0,
        },
      },
      lease: { proof, record: lease },
      liveClaims: [{ dimension: "default", slotRef: `held-${label}`, state: "RESERVED" }],
      slot: {
        dimension: "default",
        requestId: `req-${label}`,
        rows: [{
          capacityUnits: 1, effectIntentRef: `intent-ref-${label}`, epoch: 1, external: false,
          fenceable: true, resourceId: `res-${label}`, state: "ACTIVE",
        }],
        slotRef: `slot-${label}`,
      },
    },
    principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    schemaVersion: ACTIVATION_INGRESS_SCHEMA_VERSION,
  }));
}

function fakeGit(head: string): GitObserver {
  return {
    headCommit: () => head,
    lsFilesIgnored: () => [],
    lsFilesTracked: () => [],
    statusPorcelainV2: () => encoder.encode(`# branch.oid ${head}\0`),
    submodulePaths: () => [],
  };
}

function captureAnswer(tree: CandidateTree): Record<string, unknown> {
  const observed = observeScope({
    baseIdentity: tree.head, declaredScopePaths: ["pkg/src"], gitObserver: fakeGit(tree.head),
    observedAt: "2026-08-15T00:00:02Z",
    observerVersion: "moe-runner-scope-observer/1",
    pathObserver: { exists: () => false, realpath: (path: string) => path },
    worktreeRoot: "fixture-root",
  });
  if (!observed.ok) throw new Error(`scope fixture failed: ${observed.code}`);
  return {
    authoredPaths: ["pkg/src/authored.ts"],
    declaredArtifactRefs: [],
    resultTreeEntries: [
      {
        byteLength: tree.byteLength, kind: "REGULAR", origin: "INHERITED",
        path: "pkg/src/base.ts", sha256: tree.sha256,
      },
      {
        byteLength: 4, kind: "REGULAR", origin: "AUTHORED",
        path: "pkg/src/authored.ts", sha256: DIGEST_B,
      },
    ],
    scopeObservation: observed.observation,
  };
}

function sealedInput(tree: CandidateTree): Record<string, unknown> {
  const built = buildInputManifest({
    baseIdentity: tree.head,
    entries: candidateTreeEntries(tree) as never,
  });
  if (!built.ok) throw new Error(`input manifest fixture refused: ${built.code}`);
  return built.manifest as unknown as Record<string, unknown>;
}

function runtimeQuote(): ProviderRuntimeObservation {
  const built = buildProviderRuntimeObservation({
    adapterCapabilitySchemaDigest: DIGEST_B, clock: { observedAt: () => DECIDED_AT },
    pinningMethod: "CONTENT_ADDRESSED_COPY",
    platformIdentity: { arch: "x64", os: "win32", osVersion: "10.0.26200" },
    reportedVersion: "claude/2.0.0",
    resolvedRuntimeClosure: [
      { kind: "EXECUTABLE", path: "C:\\installed\\claude.exe", sha256: DIGEST_A },
    ] as never,
  });
  if (!built.ok) throw new Error(`runtime quote fixture refused: ${built.code}`);
  return built.observation;
}

function declaredInputs(): readonly DeclaredInput[] {
  return [{ path: "pkg/src/base.ts", ref: { byteLength: 10, sha256: DIGEST_A } }];
}

function nested(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const found = value[key];
  if (typeof found !== "object" || found === null || Array.isArray(found)) {
    throw new TypeError(`${key} is not a record`);
  }
  return found as Record<string, unknown>;
}

interface ProvenAttempt {
  readonly attemptAggregateId: string;
  readonly candidateRoot: string;
  readonly recordDigest: string;
}

/**
 * Builds the exact prerequisite a verifier is allowed to consume. Activation, launcher
 * authority, reservation and attempt settlement all cross their production writers.
 */
function seedProvenAttempt(
  store: SqliteEventStore,
  nodeRef: string,
  label: string,
): ProvenAttempt {
  const tree = materializeCandidateTree(label);
  scratchRoots.push(tree.root);
  const activationAggregate = deriveActivationAggregateId(`agg-${label}`, `idem-${label}`);
  const activated = runEffectActivateCommand(store, activationBytes(label));
  if (!activated.ok) throw new Error(`activation refused: ${activated.code}`);
  const initial = readFoundationActivationHistory(
    activationAggregate,
    store.readEvents(activationAggregate),
    PROJECT_ID,
  );
  if (!initial.ok) throw new Error(`activation unreadable: ${initial.result.status}`);
  const { record } = initial.history;
  const claim = {
    claimId: `claim-${label}`, claimedAt: DECIDED_AT, intentId: `intent-${label}`,
    lockIdentity: `lock-${label}`, wrapperIdentity: `wrapper-${label}`,
  };
  const registration = {
    bootstrapCredentialDigest: DIGEST_B, lockIdentity: `lock-${label}`,
    processIdentity: `windows:4242:${label}`, registeredAt: "2026-08-15T00:00:01.000Z",
    wrapperIdentity: `wrapper-${label}`,
  };
  const authority = createFoundationLauncherAuthority({
    aggregateId: activationAggregate,
    correlationId: `corr-tail-${label}`,
    key: {
      commandId: `cmd-tail-${label}`, principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    },
    projectId: PROJECT_ID,
    store,
  });
  const consumed = authority.consumeGrantDurably(record.grant, record.grant.wrapperIdentity);
  const grant = nested(consumed as Record<string, unknown>, "grant");
  authority.commitProcessRegistration({
    claim,
    phase: "PREFLIGHT",
    prior: null,
    registration: {
      ...registration,
      processIdentity: `pending:${record.grant.wrapperIdentity}`,
      registeredAt: "2026-08-15T00:00:00.500Z",
    },
  });
  authority.commitProcessRegistration({ claim, phase: "STARTED", prior: null, registration });
  const bound: FoundationAttemptBound = Object.freeze({
    aggregateId: activationAggregate, claim, commandId: `cmd-dispatch-${label}`,
    correlationId: `corr-dispatch-${label}`, nodeKey: nodeRef, principalId: PRINCIPAL_ID,
    projectId: PROJECT_ID,
    sessionId: `session-${label}`,
    target: deriveDispatchAggregateId(activationAggregate),
  });
  const observed = readDurableFoundationObservation(store, bound, record, {
    code: null, consumedGrant: grant, kind: "OBSERVED", layer: null,
    observation: {
      activationDigest: record.activationDigest,
      completedAt: "2026-08-15T00:00:02.000Z",
      consumedGrantDigest: DIGEST_A, effectDigest: DIGEST_B,
      exit: { code: 0, kind: "EXITED" },
      freshRuntimeDigest: DIGEST_C,
      grantId: record.grant.grantId, launcherVersion: CLAUDE_LAUNCHER_VERSION,
      lockIdentity: registration.lockIdentity,
      observationDigest: DIGEST_A, pinnedClosureDigest: DIGEST_B,
      processIdentity: registration.processIdentity, quotedRuntimeDigest: DIGEST,
      reasonCode: null, reasonLayer: null, registrationDigest: DIGEST_C,
      runtimeBindingDigest: DIGEST,
      startedAt: "2026-08-15T00:00:01.000Z",
      stderr: { sha256: DIGEST_B },
      stdout: { sha256: DIGEST_A },
      truthClass: "PROVEN", wrapperIdentity: registration.wrapperIdentity,
    },
    ok: true,
    registration: { ...registration },
    truthClass: "PROVEN",
  });
  if (observed === null) throw new Error("durable observation fixture was refused");
  const reservation = encodeFoundationPayload({
    activationDigest: record.activationDigest, attemptAggregateId: bound.aggregateId,
    attemptId: record.attempt.attemptId, grantId: record.grant.grantId, nodeKey: bound.nodeKey,
    recordVersion: FOUNDATION_RESERVATION_VERSION,
    requestDigest: DIGEST_A,
    sessionId: bound.sessionId,
  });
  if (!reservation.ok) throw new Error("reservation fixture refused");
  const reserved = commitFoundationPhase(
    store,
    bound,
    "RESERVED",
    reservation.bytes,
    0,
    `${record.grant.grantId}:RESERVED`,
  );
  if (reserved === null || reserved.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    throw new Error("reservation fixture was not committed");
  }
  recordProvenFoundationAttempt(store, bound, record, sealedInput(tree), {
    answer: captureAnswer(tree),
    observation: observed[0],
    registration: observed[1],
  });
  const stored = readFoundationAttemptRecord(store, activationAggregate);
  if (!stored.ok) throw new Error(`record fixture unreadable: ${stored.code}`);
  return Object.freeze({
    attemptAggregateId: activationAggregate,
    candidateRoot: tree.root,
    recordDigest: stored.digest,
  });
}

/** One production-minted PASSED receipt naming nodeRef, using a real verifier child process. */
export async function seedVerifiedNode(
  store: SqliteEventStore,
  nodeRef: string,
): Promise<void> {
  const label = nextLabel(nodeRef);
  const ground = seedProvenAttempt(store, nodeRef, label);
  const service = createFoundationVerificationService({
    principalId: PRINCIPAL_ID,
    projectId: PROJECT_ID,
    store,
  });
  const recipeAggregateId = `recipe-${label}`;
  const verificationId = `verify-${label}`;
  const sealed = service.sealRecipe({
    argv: EXIT_ZERO,
    declaredInputs: declaredInputs(),
    declaredOutputPaths: [],
    recipeAggregateId,
    runtimeObservation: runtimeQuote(),
    verifierIdentity: VERIFIER_IDENTITY,
  });
  if (!sealed.ok) throw new Error(`recipe seal fixture refused: ${sealed.code}`);
  const outcome = await service.verify({
    attemptAggregateId: ground.attemptAggregateId,
    candidateRoot: ground.candidateRoot,
    expectedRecordDigest: ground.recordDigest,
    recipeAggregateId,
    verificationId,
  });
  if (!outcome.ok) throw new Error(`verification fixture refused: ${outcome.code}`);
  if (outcome.verdict !== "PASSED") {
    throw new Error(`verification fixture answered ${outcome.verdict}, not PASSED`);
  }
  const receipt = nested(outcome.row, "receipt");
  if (receipt["graphIdentity"] !== nodeRef) {
    throw new Error(`receipt names ${String(receipt["graphIdentity"])}, not ${nodeRef}`);
  }
}
