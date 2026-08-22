import { rmSync } from "node:fs";

import * as daemon from "@moe/daemon";
import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import {
  CLAUDE_LAUNCHER_VERSION, buildInputManifest, buildProviderRuntimeObservation, observeScope,
} from "@moe/runner";
import type { DeclaredInput, GitObserver, ProviderRuntimeObservation } from "@moe/runner";
import type { SqliteEventStore } from "@moe/store";

import {
  ACTIVATION_INGRESS_SCHEMA_VERSION, EFFECT_ACTIVATE_COMMAND_KIND,
} from "../activation/activation-ingress-contracts.js";
import { runEffectActivateCommand } from "../activation/activation-ingress.js";
import { seedActivationWorld } from "../activation/activation-world-fixtures.js";
import { deriveActivationAggregateId } from "../activation/activation-ledger-contracts.js";
import { readFoundationActivationHistory } from "../activation/activation-ledger-reader.js";
import { createFoundationLauncherAuthority } from "../activation/foundation-launch-authority.js";
import {
  PROJECT_ID, SEALED_SUBMISSION_HASH, approvalPayload, approvalRecord, driveThrough, envelope,
  send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { createFoundationVerificationService } from "../evidence/foundation-verification-service.js";
import { seedVerifierReceipt } from "../review/review-test-fixtures.js";
import { encodeFoundationPayload } from "../work/foundation-attempt-codec.js";
import {
  FOUNDATION_RESERVATION_VERSION, deriveDispatchAggregateId,
} from "../work/foundation-attempt-contracts.js";
import type { FoundationAttemptBound } from "../work/foundation-attempt-contracts.js";
import {
  commitFoundationPhase, readDurableFoundationObservation, readFoundationAttemptRecord,
  recordProvenFoundationAttempt,
} from "../work/foundation-attempt-store.js";
import {
  candidateTreeEntries, materializeCandidateTree, type CandidateTree,
} from "../evidence/foundation-verification-tree-fixtures.js";

/**
 * Durable evidence for the goal-closure suites, seeded through PRODUCTION code only.
 *
 * `seedVerifiedNode` drives the whole real chain — activation ingress, launcher authority,
 * the durable attempt writer, the sealed recipe and a REAL child process through the shipped
 * node launcher. A receipt minted from a recording launcher would be exactly the mock-backed
 * acceptance the task rails forbid, so no stand-in appears anywhere below.
 *
 * EVERY IDENTITY IS DERIVED FROM THE NODE REF. Two nodes seeded into one store would otherwise
 * share a lease, an effect intent and therefore a grant, and `runVerifierProcess` keeps a
 * module-level run registry keyed by grantId: the second node would silently adopt the first
 * one's run.
 *
 * Test-tier scaffolding, reached only from `*.test.ts`, so it deliberately has no `.js` bridge —
 * `review-test-fixtures.ts` has none either.
 */

const encoder = new TextEncoder();
const PRINCIPAL_ID = "principal-1";
const DECIDED_AT = "2026-08-15T00:00:00.000Z";
const OPERATOR_CREDENTIAL = "j1-operator-credential";
const OPERATOR_PRINCIPAL_ID = "j1-operator";

const DIGEST = "a".repeat(64);
const DIGEST_A = "2".repeat(64), DIGEST_B = "3".repeat(64), DIGEST_C = "4".repeat(64);

const scratchRoots: string[] = [];

/** Recursive and forced: a win32 host briefly holds a handle on a just-exited child's cwd. */
export function cleanupGoalClosureFixtures(): void {
  while (scratchRoots.length > 0) {
    const root = scratchRoots.pop();
    if (root !== undefined) rmSync(root, { force: true, maxRetries: 20, recursive: true, retryDelay: 250 });
  }
}

let seedOrdinal = 0;

/**
 * A label that is unique for the whole PROCESS, not just the store.
 *
 * `runVerifierProcess` keeps a module-level run registry keyed by grantId, and the grant is
 * derived from the whole successor intent — so two seeds sharing a label refuse
 * GRANT_ALREADY_CONSUMED in the SECOND test even though each has its own store. Measured, not
 * assumed: that is exactly how this fixture failed before the ordinal was added.
 */
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
    authorityHashRef: DIGEST, epoch: 3, expectedVersion: 7, leaseToken: `token-${label}`,
    ownerSessionRef: `session-${label}`,
  };
}

const VERIFIER_IDENTITY = Object.freeze({
  capabilitySchemaDigest: DIGEST_B, verifierId: "moe-verifier", verifierVersion: "1.0.0",
});
/** An argv the wrapper's launch gate accepts: an absolute executable path. */
const EXIT_ZERO = Object.freeze([process.execPath, "-e", "process.exit(0)"]);
const EXIT_THREE = Object.freeze([process.execPath, "-e", "process.exit(3)"]);

function activationBytes(label: string): Uint8Array {
  const intentId = `intent-${label}`;
  const lease = leaseRecord(label);
  const proof = leaseProof(label);
  return encoder.encode(JSON.stringify({
    commandId: `cmd-activate-${label}`, correlationId: `corr-${label}`, decidedAt: DECIDED_AT,
    expectedVersion: 0, kind: EFFECT_ACTIVATE_COMMAND_KIND,
    payload: structuredClone({
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
          predecessorCursor: "cursor-1", protocolVersion: "moe-effect-intent/1",
          runtimeObservationDigest: DIGEST, state: "PENDING", version: 0,
        },
      },
      lease: { proof, record: lease },
      liveClaims: [{ dimension: "default", slotRef: `held-${label}`, state: "RESERVED" }],
      slot: {
        dimension: "default", requestId: `req-${label}`,
        rows: [{
          capacityUnits: 1, effectIntentRef: `intent-ref-${label}`, epoch: 1, external: false,
          fenceable: true, resourceId: `res-${label}`, state: "ACTIVE",
        }],
        slotRef: `slot-${label}`,
      },
    }),
    principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    schemaVersion: ACTIVATION_INGRESS_SCHEMA_VERSION,
  }));
}

function fakeGit(head: string): GitObserver {
  return {
    headCommit: () => head, lsFilesIgnored: () => [], lsFilesTracked: () => [],
    statusPorcelainV2: () => encoder.encode(`# branch.oid ${head}\0`), submodulePaths: () => [],
  };
}

/**
 * The workspace answer the runner's result-manifest builder accepts. Its inherited entry
 * names the REAL tree's bytes: the verification service binds a candidate root to the
 * durable input manifest byte for byte before it activates anything, so the manifest
 * and the tree it is later verified against must agree on HEAD and on every sealed byte.
 */
function captureAnswer(tree: CandidateTree): Record<string, unknown> {
  const observed = observeScope({
    baseIdentity: tree.head, declaredScopePaths: ["pkg/src"], gitObserver: fakeGit(tree.head),
    observedAt: "2026-08-15T00:00:02Z", observerVersion: "moe-runner-scope-observer/1",
    pathObserver: { exists: () => false, realpath: (path: string) => path },
    worktreeRoot: "fixture-root",
  });
  if (!observed.ok) throw new Error(`scope fixture failed: ${observed.code}`);
  return {
    authoredPaths: ["pkg/src/authored.ts"],
    declaredArtifactRefs: [{ byteLength: 7, sha256: DIGEST_C }],
    resultTreeEntries: [
      {
        byteLength: tree.byteLength, kind: "REGULAR", origin: "INHERITED", path: "pkg/src/base.ts",
        sha256: tree.sha256,
      },
      {
        byteLength: 4, kind: "REGULAR", origin: "AUTHORED", path: "pkg/src/authored.ts",
        sha256: DIGEST_B,
      },
    ],
    scopeObservation: observed.observation,
  };
}

function sealedInput(tree: CandidateTree): Record<string, unknown> {
  const built = buildInputManifest({
    baseIdentity: tree.head, entries: candidateTreeEntries(tree) as never,
  });
  if (!built.ok) throw new Error(`input manifest fixture refused: ${built.code}`);
  return built.manifest as unknown as Record<string, unknown>;
}

/** A genuinely digest-bound quote from the runner's own observation builder. */
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

export interface SeededAttempt {
  readonly attemptAggregateId: string;
  /** The real tree the attempt's input manifest was sealed over; verify against THIS root. */
  readonly candidateRoot: string;
  readonly recordDigest: string;
}

/**
 * A durable PROVEN attempt record, produced by the production chain only: activation ingress ->
 * launcher authority GRANT_CONSUMED/PREFLIGHT/PROCESS_OBSERVED -> `readDurableFoundationObservation`
 * -> `recordProvenFoundationAttempt`. `nodeKey` is the node ref, which is the only durable
 * node -> receipt edge: `buildEvidenceReceipt` copies it into `receipt.graphIdentity`.
 */
export function seedProvenAttempt(
  store: SqliteEventStore, nodeRef: string, label: string = nextLabel(nodeRef),
): SeededAttempt {
  // The activation below is the exact call whose authority moves from the caller's budget
  // section to the durable ACTIVE graph (task-e194c5f6 step 6). Enriching the world here is a
  // strict no-op today and is what keeps this lineage off that wall; it is idempotent, so a
  // caller that already drove the planning chain to an ACTIVE graph is left untouched.
  seedActivationWorld(store);
  const tree = materializeCandidateTree(label);
  scratchRoots.push(tree.root);
  const activationAggregate = deriveActivationAggregateId(`agg-${label}`, `idem-${label}`);
  const activated = runEffectActivateCommand(store, activationBytes(label));
  if (!activated.ok) throw new Error(`activation refused: ${activated.code}`);
  const initial = readFoundationActivationHistory(
    activationAggregate, store.readEvents(activationAggregate), PROJECT_ID);
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
    aggregateId: activationAggregate, correlationId: `corr-tail-${label}`,
    key: { commandId: `cmd-tail-${label}`, principalId: PRINCIPAL_ID, projectId: PROJECT_ID },
    projectId: PROJECT_ID, store,
  });
  const consumed = authority.consumeGrantDurably(record.grant, record.grant.wrapperIdentity);
  const grant = nested(consumed as Record<string, unknown>, "grant");
  authority.commitProcessRegistration({
    claim, phase: "PREFLIGHT", prior: null,
    registration: {
      ...registration, processIdentity: `pending:${record.grant.wrapperIdentity}`,
      registeredAt: "2026-08-15T00:00:00.500Z",
    },
  });
  authority.commitProcessRegistration({ claim, phase: "STARTED", prior: null, registration });
  const bound: FoundationAttemptBound = Object.freeze({
    aggregateId: activationAggregate, claim, commandId: `cmd-dispatch-${label}`,
    correlationId: `corr-dispatch-${label}`, nodeKey: nodeRef, principalId: PRINCIPAL_ID,
    projectId: PROJECT_ID, sessionId: `session-${label}`,
    target: deriveDispatchAggregateId(activationAggregate),
  });
  const observed = readDurableFoundationObservation(store, bound, record, {
    code: null, consumedGrant: grant, kind: "OBSERVED", layer: null,
    observation: {
      activationDigest: record.activationDigest, completedAt: "2026-08-15T00:00:02.000Z",
      consumedGrantDigest: DIGEST_A, effectDigest: DIGEST_B, exit: { code: 0, kind: "EXITED" },
      freshRuntimeDigest: DIGEST_C, grantId: record.grant.grantId,
      launcherVersion: CLAUDE_LAUNCHER_VERSION, lockIdentity: registration.lockIdentity,
      observationDigest: DIGEST_A, pinnedClosureDigest: DIGEST_B,
      processIdentity: registration.processIdentity, quotedRuntimeDigest: DIGEST,
      reasonCode: null, reasonLayer: null, registrationDigest: DIGEST_C,
      runtimeBindingDigest: DIGEST, startedAt: "2026-08-15T00:00:01.000Z",
      stderr: { sha256: DIGEST_B }, stdout: { sha256: DIGEST_A }, truthClass: "PROVEN",
      wrapperIdentity: registration.wrapperIdentity,
    },
    ok: true, registration: { ...registration }, truthClass: "PROVEN",
  });
  if (observed === null) throw new Error("durable observation fixture was refused");
  // RECORDED commits at expectedVersion 1, so the dispatch aggregate must already carry its
  // RESERVED event — the production reservation, not a shortcut around it.
  const reservation = encodeFoundationPayload({
    activationDigest: record.activationDigest, attemptAggregateId: bound.aggregateId,
    attemptId: record.attempt.attemptId, grantId: record.grant.grantId, nodeKey: bound.nodeKey,
    recordVersion: FOUNDATION_RESERVATION_VERSION, requestDigest: DIGEST_A,
    sessionId: bound.sessionId,
  });
  if (!reservation.ok) throw new Error("reservation fixture refused");
  const reserved = commitFoundationPhase(
    store, bound, "RESERVED", reservation.bytes, 0, `${record.grant.grantId}:RESERVED`);
  if (reserved === null || reserved.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    throw new Error("reservation fixture was not committed");
  }
  recordProvenFoundationAttempt(store, bound, record, sealedInput(tree), {
    answer: captureAnswer(tree), observation: observed[0], registration: observed[1],
  });
  // The digest always comes from the RE-DECODED durable record, never from the writer's answer.
  const stored = readFoundationAttemptRecord(store, activationAggregate);
  if (!stored.ok) throw new Error(`record fixture unreadable: ${stored.code}`);
  return {
    attemptAggregateId: activationAggregate, candidateRoot: tree.root, recordDigest: stored.digest,
  };
}

export interface SeededVerification {
  readonly attemptAggregateId: string;
  readonly effectIdentity: string;
  readonly leaseIdentity: string;
  readonly nodeRef: string;
  readonly receiptSha256: string;
  readonly recordDigest: string;
  readonly row: Record<string, unknown>;
  readonly verificationId: string;
}

/**
 * One durably RECEIPTED, PASSED verification naming `nodeRef`, through the real chain and a
 * real child process. It THROWS on anything other than a PASSED receipt: a fixture that
 * silently produced no row would leave every later assertion inspecting an empty store.
 *
 * The store must already be a bootstrapped, ACTIVE project — every caller drives
 * `bootstrapSequence` first, so re-seeding the project here would only replay it.
 */
export interface SeedVerifiedNodeOptions {
  /** A verifier that exits non-zero, so the durable receipt lands verdict FAILED. */
  readonly failing?: boolean;
}

export async function seedVerifiedNode(
  store: SqliteEventStore, nodeRef: string, options: SeedVerifiedNodeOptions = {},
): Promise<SeededVerification> {
  const label = nextLabel(nodeRef);
  const failing = options.failing === true;
  const ground = seedProvenAttempt(store, nodeRef, label);
  const service = createFoundationVerificationService({
    principalId: PRINCIPAL_ID, projectId: PROJECT_ID, store,
  });
  const sealed = service.sealRecipe({
    argv: failing ? EXIT_THREE : EXIT_ZERO, declaredInputs: declaredInputs(),
    declaredOutputPaths: [], recipeAggregateId: `recipe-${label}`,
    runtimeObservation: runtimeQuote(), verifierIdentity: VERIFIER_IDENTITY,
  });
  if (!sealed.ok) throw new Error(`recipe seal fixture refused: ${sealed.code}`);
  const outcome = await service.verify({
    attemptAggregateId: ground.attemptAggregateId, candidateRoot: ground.candidateRoot,
    expectedRecordDigest: ground.recordDigest, recipeAggregateId: `recipe-${label}`,
    verificationId: `verify-${label}`,
  });
  if (!outcome.ok) throw new Error(`verification fixture refused: ${outcome.code}`);
  const expected = failing ? "FAILED" : "PASSED";
  if (outcome.verdict !== expected) {
    throw new Error(`verification fixture answered ${outcome.verdict}, not ${expected}`);
  }
  const receipt = nested(outcome.row, "receipt");
  if (receipt["graphIdentity"] !== nodeRef) {
    throw new Error(`receipt names ${String(receipt["graphIdentity"])}, not ${nodeRef}`);
  }
  return Object.freeze({
    attemptAggregateId: ground.attemptAggregateId,
    effectIdentity: String(receipt["effectIdentity"]),
    leaseIdentity: String(receipt["leaseIdentity"]),
    nodeRef,
    receiptSha256: String(outcome.row["receiptSha256"]),
    recordDigest: ground.recordDigest,
    row: outcome.row,
    verificationId: `verify-${label}`,
  });
}

/** The approval whose durable `approvedNodeScope` is the closure's node set. */
export function approveNodes(store: SqliteEventStore, nodeRefs: readonly string[]): void {
  driveThrough(store, "approval.decide");
  const outcome = send(store, envelope("approval.decide", 0, approvalPayload({
    // The SEALED hash: `driveThrough` proposed through the shipped journey, whose propose
    // terminal carries the authority member, so the run's submission hash is the sealed
    // plan body's own `planHash` and an approval naming the legacy constant is refused
    // BOOTSTRAP_REVISION_HASH_MISMATCH (task-074e6d2e).
    record: { ...approvalRecord(SEALED_SUBMISSION_HASH), approvedNodeScope: [...nodeRefs] },
  })));
  if (!outcome.ok) throw new Error(`approval setup failed: ${outcome.code}`);
}

/**
 * The daemon-side review acceptance required before the third human action, driven through the
 * PUBLISHED, authenticated package-root command path. The verifier receipt is the daemon's own
 * internal producer, so the fixture seeds that durable fact and nothing else.
 */
export function seedReviewAcceptance(store: SqliteEventStore, nodeRef = "node-1"): void {
  const receipt = seedVerifierReceipt(store, nodeRef, PROJECT_ID);
  const ports = daemon.createDaemonCommandPorts({
    clock: () => "2026-08-16T00:00:00.000Z",
    operatorPrincipalId: OPERATOR_PRINCIPAL_ID,
    projectId: PROJECT_ID,
    store,
  });
  const outcome = daemon.handleCommandRequest({
    authenticator: {
      authenticate: (credential) => credential === OPERATOR_CREDENTIAL
        ? {
          principal: {
            capabilities: daemon.OPERATOR_CAPABILITIES,
            principalId: OPERATOR_PRINCIPAL_ID,
            projectId: PROJECT_ID,
          },
          verdict: "AUTHENTICATED" as const,
        }
        : { verdict: "UNAUTHENTICATED" as const },
    },
    ...ports,
  }, {
    body: encoder.encode(JSON.stringify({
      commandId: `cmd-j1-review-accept-${nodeRef}`,
      commandKind: "integration.accept_output",
      correlationId: "corr-j1-review",
      expectedVersion: receipt.currentVersion,
      payload: { receiptId: receipt.receiptId, subjectRef: nodeRef },
      requestDigest: "a".repeat(64),
      schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: OPERATOR_CREDENTIAL,
      targetAggregateId: nodeRef,
    })),
    credential: OPERATOR_CREDENTIAL,
    protocolVersion: daemon.WIRE_PROTOCOL_VERSION,
  });
  if (!outcome.ok) throw new Error(`authenticated review setup failed for ${nodeRef}`);
}
