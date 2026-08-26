/**
 * TEST-TIER. The one durable world the expansion release selector is graded over, plus the
 * narrowly scoped faults its hostile roster needs.
 *
 * EVERY ACCEPTED FACT COMES FROM A PRODUCTION WRITER. The project, the sealed planning chain,
 * the human approval, the project configuration, the provider profile, the activation, the
 * dispatch reservation and attempt record, the journal append, both review rounds, the capture
 * context, the sealed context manifest, the step record, the artifact roster, the provider run,
 * the terminal effect and resource reports, the sealed recipe and receipt, and finally the
 * RELEASE itself — which is committed by the SERVED `foundation.verification` command through
 * the real HTTP adapter, never by a hand-written release row. A world assembled any other way
 * would only prove the selector can read a fixture back.
 *
 * THE CONTEXT MANIFEST IS SEALED FROM A REAL SELECTION. `assembleFoundationContextSelection`
 * and `renderContext` are the production composer and renderer; only their composition into a
 * candidate is done here, exactly as `foundation-context-prelaunch.ts` does it. The hostile
 * VARIANTS below deliberately re-render mutated bytes — that is what a cross-spliced or
 * malformed durable row IS — and every one of them must refuse.
 *
 * NOT `seedReleaseHandoffSources`: it internally seals a STUB context manifest on the same slot
 * aggregate (attemptRef+projectId+sessionId), which would collide with the real seal. Its
 * sub-seeders are called individually instead.
 *
 * NO `.js` BRIDGE. `runtime-entrypoint.test.ts` pins the bridge set to RUNTIME modules only.
 *
 * WINDOWS HANDLE DISCIPLINE: every handle is closed before its directory is removed. A handle
 * held across `rmSync` throws EPERM and kills the vitest worker with no output.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PROJECT_CONFIGURATION_LIMIT_KEYS, RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { ProjectConfigurationLimitKey, RuntimeCommandEnvelope } from "@moe/contracts";
import { digestContextManifest, renderContext } from "@moe/context";
import type { ContextRenderManifest } from "@moe/context";
import {
  createProjectConfigurationManifest, encodeProjectConfigurationManifest,
} from "@moe/core";
import { buildInputManifest, observeScope } from "@moe/runner";
import type {
  GitObserver, ScopeObservation, ScopePathObserver, WorkspaceInputEntry, WorkspaceInputManifest,
} from "@moe/runner";
import { SqliteEventStore } from "@moe/store";
import type { CommandDecisionRecord, CursorPage, StoredEvent } from "@moe/store";

import {
  ACTIVATION_INGRESS_SCHEMA_VERSION, EFFECT_ACTIVATE_COMMAND_KIND,
  EFFECT_ACTIVATE_PAYLOAD_KEYS,
} from "../activation/activation-ingress-contracts.js";
import { runEffectActivateCommand } from "../activation/activation-ingress.js";
import { deriveActivationAggregateId } from "../activation/activation-ledger-contracts.js";
import { readFoundationActivationHistory } from "../activation/activation-ledger-reader.js";
import {
  GOAL_ID, RUN_ID, SEALED_SUBMISSION_HASH, approvalPayload, approvalRecord, envelope,
  finalizeChain, hex64, sealedPlanningChain, send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { selectProjectConfiguration } from "../configuration/project-configuration-selection.js";
import { createStoreDependencies } from "../daemon-store-dependencies.js";
import {
  FOUNDATION_VERIFICATION_COMMAND_KIND,
} from "../evidence/foundation-verification-contracts.js";
import { handleAsyncCommandRequest } from "../http/http-adapter.js";
import { WIRE_PROTOCOL_VERSION } from "../http/http-contract.js";
import { installTestRecoveryBinding } from "../identity/session-test-fixtures.js";
import { runJournalAppendCommand } from "../journal/journal-append.js";
import {
  JOURNAL_APPEND_COMMAND_KIND, JOURNAL_APPEND_SCHEMA_VERSION,
} from "../journal/journal-contracts.js";
import { PRINCIPAL_ID, PROJECT_ID, seedReadyProject } from "../recovery/restore-test-harness.js";
import { REVIEW_SCHEMA_VERSION } from "../review/review-contracts.js";
import { finding, packageItems } from "../review/review-test-fixtures.js";
import { runReviewCommand } from "../review/review-services.js";
import {
  seedProvenAttemptRecord, seedProviderRun, seedReceipt, seedSealedRecipe, withStoreOverride,
} from "../work/attempt-finalization-test-harness.js";
import { applyAttemptResourceReport } from "../work/attempt-resource-authority.js";
import { recordTerminalEffect } from "../work/effect-terminal-ledger.js";
import { deriveDispatchAggregateId } from "../work/foundation-attempt-codec.js";
import type { FoundationAttemptBound } from "../work/foundation-attempt-contracts.js";
import {
  deriveFoundationCaptureContextRecordDigest,
} from "../work/foundation-capture-context-contract.js";
import { commitFoundationCaptureContext } from "../work/foundation-capture-context-ledger.js";
import { deriveFoundationContextRecordDigest }
  from "../work/foundation-context-manifest-codec.js";
import { commitFoundationContextManifest }
  from "../work/foundation-context-manifest-ledger.js";
import { createFoundationContextAuthority } from "../work/foundation-context-selection.js";
import type { FoundationContextProvenance } from "../work/foundation-context-selection.js";
import { seedArtifactManifest, seedStepRecord } from "../work/release-handoff-test-harness.js";

export { PRINCIPAL_ID, PROJECT_ID, withStoreOverride };

export const SELECTOR_GOAL_ID = GOAL_ID;
export const SELECTOR_RUN_ID = RUN_ID;
export const SELECTOR_NODE_KEY = "dev-solo";
export const SELECTOR_ATTEMPT_ID = "attempt-1";
export const SELECTOR_SESSION_ID = "session-1";
export const SELECTOR_DECIDED_AT = "2026-08-22T00:00:00.000Z";
const HEAD_COMMIT = "9".repeat(40);
const OBSERVER_VERSION = "moe-scope-observer/1";
const DECLARED_PATHS = Object.freeze(["src/0.ts", "src/1.ts"]);
const PROFILE_REF = "profile-ref-1";
const MINIMUM_REF = "provider-profile-1";
const DIGEST = "a".repeat(64);
const CREDENTIAL = "expansion-release-selector-credential";
const LIVE_DEADLINE = Math.floor(Date.parse(SELECTOR_DECIDED_AT) / 1_000) + 3_600;

/** The exact four-key query the accepted control answers for. */
export const selectorQuery = (): Record<string, unknown> => ({
  goalRef: SELECTOR_GOAL_ID, parentNodeRef: SELECTOR_NODE_KEY,
  parentRunRef: SELECTOR_RUN_ID, projectId: PROJECT_ID,
});

const SELECTION = Object.freeze({
  modelRef: "model-ref-1", profileRef: PROFILE_REF, providerRef: "provider-ref-1",
  reasoningEffortRef: "reasoning-effort-ref-1", runtimeRef: "runtime-ref-1",
  snapshotRef: "snapshot-ref-1", structuredOutputSchemaRef: "structured-output-schema-ref-1",
});

const limitValue = (key: ProjectConfigurationLimitKey): number =>
  PROJECT_CONFIGURATION_LIMIT_KEYS.indexOf(key) + 1;

const profileBody = (): Record<string, unknown> => ({
  capabilitySchemaDigest: hex64("ca9ab111"),
  concurrencyCeiling: limitValue("activeProviderSessions"),
  contextLimit: {
    bytes: 400_000, kind: "CONSERVATIVE_INPUT_BYTES",
    source: "model card: claude-opus-5 200k window, output reserved",
  },
  limits: {
    stderrBytes: limitValue("capturedOutputBytes"), stdoutBytes: limitValue("capturedOutputBytes"),
    tailBytes: limitValue("uiTailBytes"), timeoutMs: limitValue("runnerAuthorizedMsPerAttempt"),
  },
  modelSnapshotEvidence: "claude-cli-2.0.30-2026-05-01", modelSnapshotKind: "DATED_SNAPSHOT",
  profileRevisionId: PROFILE_REF, provider: "claude", providerMinimumProfileRef: MINIMUM_REF,
  reasoningEffort: "high", selectedModelId: "claude-opus-5", selection: SELECTION,
});

const settingsBody = (): Record<string, unknown> => ({
  isolation: { hostContainment: "NOT_CLAIMED", workspace: "PER_ATTEMPT_WORKTREE" },
  limits: PROJECT_CONFIGURATION_LIMIT_KEYS.map((key) => ({ key, value: limitValue(key) })),
  network: { daemonExposure: "LOOPBACK_ONLY", providerEgress: "EGRESS_ALLOWLISTED" },
  orchestrationSource: { objectFormat: "sha256", sourceSha: hex64("0c5") },
  policy: {
    acceptanceGate: "MANUAL_HUMAN_APPROVAL", autoApprovalOptInDigest: null,
    evaluatorVersion: "policy-evaluator-v1", expansionGate: "MANUAL_HUMAN_APPROVAL",
    planningGate: "MANUAL_HUMAN_APPROVAL", policyRevisionId: "policy-revision-1", revision: 1,
  },
  schemaVersions: {
    commandSchemaVersion: "moe-command-1", errorSchemaVersion: "moe-error-1",
    querySchemaVersion: "moe-query-1",
  },
  selection: SELECTION,
});

/** A REAL sealed input manifest and a REAL scope observation, both from @moe/runner. */
function manifestFor(): WorkspaceInputManifest {
  const entries: WorkspaceInputEntry[] = DECLARED_PATHS.map((path, index) => ({
    byteLength: 8, path, producer: { kind: "BASE" as const },
    sha256: index.toString(16).padStart(64, "0"),
  }));
  const built = buildInputManifest({ baseIdentity: HEAD_COMMIT, entries });
  if (!built.ok) throw new Error(`fixture manifest refused: ${built.code}`);
  return built.manifest;
}

function observationFor(root: string): ScopeObservation {
  const gitObserver: GitObserver = {
    headCommit: () => HEAD_COMMIT, lsFilesIgnored: () => [],
    lsFilesTracked: () => [...DECLARED_PATHS],
    statusPorcelainV2: () => new TextEncoder().encode(`# branch.oid ${HEAD_COMMIT}\0`),
    submodulePaths: () => [],
  };
  const pathObserver: ScopePathObserver = { exists: () => true, realpath: (path) => path };
  const observed = observeScope({
    baseIdentity: HEAD_COMMIT, declaredScopePaths: [...DECLARED_PATHS], gitObserver,
    observedAt: SELECTOR_DECIDED_AT, observerVersion: OBSERVER_VERSION, pathObserver,
    worktreeRoot: root,
  });
  if (!observed.ok) throw new Error(`fixture observation refused: ${observed.code}`);
  return observed.observation;
}

const ACTIVATION_SLUG = "xrsel";
export const SELECTOR_ACTIVATION_AGGREGATE =
  deriveActivationAggregateId(`agg-${ACTIVATION_SLUG}`, `idem-${ACTIVATION_SLUG}`);

/** This world's own `effect.activate` envelope, its sections filtered through the PRODUCTION
 *  key roster rather than a hand-copied list: the payload shape is mid-migration. */
function activationBytes(): Uint8Array {
  const slug = ACTIVATION_SLUG;
  const lease = {
    authorityHashRef: DIGEST, bootId: "boot-1", epoch: 3, kind: "ASSIGNMENT",
    leaseId: `lease-${slug}`, leaseToken: `token-${slug}`, monotonicObservation: 500,
    ownerSessionRef: SELECTOR_SESSION_ID, serverWallDeadline: LIVE_DEADLINE, state: "ACTIVE",
    version: 7,
  } as const;
  const proof = {
    authorityHashRef: DIGEST, epoch: 3, expectedVersion: 7, leaseToken: `token-${slug}`,
    ownerSessionRef: SELECTOR_SESSION_ID,
  } as const;
  const claim = {
    claimId: `claim-${slug}`, claimedAt: SELECTOR_DECIDED_AT, intentId: `intent-${slug}`,
    lockIdentity: `lock-${slug}`, wrapperIdentity: `wrapper-${slug}`,
  } as const;
  const sections: Record<string, unknown> = {
    activation: {
      attempt: {
        aggregateId: `agg-${slug}`, attemptId: SELECTOR_ATTEMPT_ID, intentId: `intent-${slug}`,
        state: "LAUNCH_REQUESTED", version: 0,
      },
      claim, dependencyWitnesses: [], desiredState: "ACTIVE", leaseProof: proof,
      lockIdentity: `lock-${slug}`, observedGraphEpoch: 4, observedRuntimeDigest: DIGEST,
      tombstone: null, wrapperIdentity: `wrapper-${slug}`,
    },
    budget: { reservation: null },
    effect: {
      command: { kind: "claim" },
      intent: {
        aggregateId: `agg-${slug}`, desiredState: "ACTIVE", expectedGraphEpoch: 4,
        idempotencyKey: `idem-${slug}`, inputBinding: DIGEST, intentId: `intent-${slug}`,
        leaseBinding: lease, predecessorCursor: `cursor-${slug}`,
        protocolVersion: "moe-effect-intent/1", runtimeObservationDigest: DIGEST,
        state: "PENDING", version: 0,
      },
    },
    lease: { proof, record: lease },
    liveClaims: [{ dimension: slug, slotRef: `held-${slug}`, state: "RESERVED" }],
    slot: {
      dimension: slug, requestId: `req-${slug}`, slotRef: `slot-${slug}`,
      rows: [{
        capacityUnits: 1, effectIntentRef: `intent-ref-${slug}`, epoch: 1, external: false,
        fenceable: true, resourceId: `res-${slug}`, state: "ACTIVE",
      }],
    },
  };
  const payload: Record<string, unknown> = {};
  for (const key of EFFECT_ACTIVATE_PAYLOAD_KEYS) payload[key] = sections[key];
  return new TextEncoder().encode(JSON.stringify({
    commandId: `cmd-activate-${slug}`, correlationId: `corr-${slug}`,
    decidedAt: SELECTOR_DECIDED_AT, expectedVersion: 0, kind: EFFECT_ACTIVATE_COMMAND_KIND,
    payload, principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    schemaVersion: ACTIVATION_INGRESS_SCHEMA_VERSION,
  }));
}

function captureCandidate(worktreeRoot: string): Record<string, unknown> {
  const manifest = manifestFor();
  const body = {
    artifactDeclaration: "NONE",
    assignment: {
      adopted: false, assignmentVersion: "moe-worktree-assignment/1",
      attemptId: SELECTOR_ATTEMPT_ID, baseIdentity: HEAD_COMMIT,
      leaf: `${PROJECT_ID}-${SELECTOR_ATTEMPT_ID}`, projectId: PROJECT_ID,
      realSourceRepositoryRoot: join("fixture-source", "repo"),
      realWorktreeParent: "fixture-parent", realWorktreePath: worktreeRoot,
      worktreePath: worktreeRoot,
    },
    attemptAggregateId: SELECTOR_ACTIVATION_AGGREGATE, attemptId: SELECTOR_ATTEMPT_ID,
    baselineDigest: manifest.sha256,
    catalogAuthority: {
      baseRevisionHash: HEAD_COMMIT, catalogDigest: "c".repeat(64),
      declaredPaths: [...DECLARED_PATHS], projectId: PROJECT_ID, repositoryRef: "repo-main",
      scopeRef: "scope-default", sourceRepositoryRoot: join("fixture-source", "repo"),
      worktreeParent: "fixture-parent",
    },
    inputManifest: manifest, nodeKey: SELECTOR_NODE_KEY,
    observation: observationFor(worktreeRoot), observedAt: SELECTOR_DECIDED_AT,
    projectId: PROJECT_ID, recordVersion: "moe-foundation-capture-context/1",
    requestDigest: "d".repeat(64), reservationDigest: "e".repeat(64),
    sessionId: SELECTOR_SESSION_ID,
  };
  return { ...body, recordDigest: deriveFoundationCaptureContextRecordDigest(body) };
}

function seedApprovalChain(store: SqliteEventStore): void {
  const chain = [
    envelope("provider.probe", 1, {
      observation: {
        profile: profileBody(), providerMinimumProfileRef: MINIMUM_REF,
        truthClass: "DAEMON_VERIFIED",
      },
    }, "cmd-provider-probe-selector"),
    envelope("plan.propose", 0, { commands: sealedPlanningChain(), runId: SELECTOR_RUN_ID }),
    envelope("plan.propose", 0, { commands: finalizeChain(), runId: SELECTOR_RUN_ID },
      "cmd-finalize"),
    envelope("approval.decide", 0, approvalPayload({
      record: {
        ...approvalRecord(SEALED_SUBMISSION_HASH), approvedNodeScope: [SELECTOR_NODE_KEY],
      },
    })),
  ];
  for (const step of chain) {
    const outcome = send(store, step);
    if (!outcome.ok) throw new Error(`world seed refused at ${step.kind}: ${outcome.code}`);
  }
}

function seedConfiguration(store: SqliteEventStore): string {
  const created = createProjectConfigurationManifest(PROJECT_ID, settingsBody());
  if (!created.ok) throw new Error(`configuration manifest refused: ${created.code}`);
  const encoded = encodeProjectConfigurationManifest(created.manifest);
  if (!encoded.ok) throw new Error(`configuration encode refused: ${encoded.code}`);
  const selected = selectProjectConfiguration(store, {
    commandId: "configuration-command-1", correlationId: "correlation-configuration-1",
    decidedAt: SELECTOR_DECIDED_AT, expectedVersion: 0, manifestBytes: encoded.bytes,
    principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
  });
  if (!selected.ok) throw new Error(`configuration refused: ${selected.code}`);
  return created.manifest.settingsDigest;
}

function seedJournalAndReviews(store: SqliteEventStore): void {
  const appended = runJournalAppendCommand(store, new TextEncoder().encode(JSON.stringify({
    commandId: "cmd-journal-selector", correlationId: "corr-journal-selector",
    decidedAt: SELECTOR_DECIDED_AT, expectedVersion: 0, kind: JOURNAL_APPEND_COMMAND_KIND,
    payload: {
      attemptAggregateId: SELECTOR_ACTIVATION_AGGREGATE, effectId: `intent-${ACTIVATION_SLUG}`,
      entries: [{
        actorId: SELECTOR_SESSION_ID, baseDigest: DIGEST, environmentDigest: DIGEST,
        failureCode: "CONTEXT_WORLD_SEED_FAILED", id: "journal-entry-1",
        kind: "FAILED_APPROACH", occurredAt: SELECTOR_DECIDED_AT, primaryScope: "src/0.ts",
        recipeDigest: DIGEST,
        retryPredicate: {
          expectedValue: "ready", factId: "fact-context-world", kind: "FACT_VALUE",
          operator: "EQUALS",
        },
        text: "The caller budget section is dead input and cannot be revived.",
      }],
    },
    principalId: SELECTOR_SESSION_ID, projectId: PROJECT_ID,
    schemaVersion: JOURNAL_APPEND_SCHEMA_VERSION,
  })));
  if (!appended.ok) throw new Error(`journal append refused: ${appended.code}`);
  for (const round of [1, 2]) {
    const outcome = runReviewCommand(store, new TextEncoder().encode(JSON.stringify({
      commandId: `cmd-review-selector-${round}`, correlationId: `corr-review-selector-${round}`,
      decidedAt: SELECTOR_DECIDED_AT, expectedVersion: round - 1, kind: "review.submit",
      payload: {
        findings: [finding({
          ruleId: `rule-round-${round}`, subject: { kind: "NODE", locator: SELECTOR_NODE_KEY },
        })],
        packageItems: packageItems(), round, subjectRef: SELECTOR_NODE_KEY,
      },
      principalId: PRINCIPAL_ID, projectId: PROJECT_ID, schemaVersion: REVIEW_SCHEMA_VERSION,
    })));
    if (!outcome.ok) throw new Error(`review ${round} refused: ${outcome.code}`);
  }
}

/** The five release-side facts, then the SERVED verification command that records the release.
 *  The seeding handle is closed before the shipped provider reopens the same file: Windows will
 *  not share the lock. */
interface ReleaseSeed {
  readonly activationDigest: string;
  readonly provenance: FoundationContextProvenance;
  readonly recordDigest: string;
  readonly root: string;
}

async function seedRelease(
  store: SqliteEventStore, storePath: string, seed: ReleaseSeed,
): Promise<void> {
  const { activationDigest, provenance, recordDigest, root } = seed;
  const identity = {
    activationDigest, attemptAggregateId: SELECTOR_ACTIVATION_AGGREGATE,
    attemptRef: SELECTOR_ATTEMPT_ID, effectId: `intent-${ACTIVATION_SLUG}`,
    leaseRef: `lease-${ACTIVATION_SLUG}`, nodeKey: SELECTOR_NODE_KEY, projectId: PROJECT_ID,
    sessionId: SELECTOR_SESSION_ID,
  };
  seedStepRecord(store, identity);
  seedArtifactManifest(store, identity, provenance.inputManifestSha256);
  seedProviderRun(store, "selector");
  const effect = recordTerminalEffect(store, {
    attemptRef: SELECTOR_ATTEMPT_ID, projectId: PROJECT_ID,
  });
  if (!effect.ok) throw new Error(`terminal effect refused: ${effect.code}`);
  const resources = applyAttemptResourceReport(store, {
    activationAggregateId: SELECTOR_ACTIVATION_AGGREGATE, commandId: "cmd-resources-selector",
    correlationId: "corr-resources-selector", principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
  }, { disposition: "FAILED", epoch: 1, kind: "FAIL", resourceId: `res-${ACTIVATION_SLUG}` });
  if (!resources.ok) throw new Error(`resource report refused: ${resources.code}`);

  const candidateRoot = join(root, "candidate");
  const recipeAggregateId = "recipe-selector";
  const verificationId = "verification-selector";
  const recipeSha256 = seedSealedRecipe(store, recipeAggregateId);
  seedReceipt(store, {
    attemptAggregateId: SELECTOR_ACTIVATION_AGGREGATE, candidateRoot, recipeAggregateId,
    recipeSha256, recordDigest, verificationId,
  });
  installTestRecoveryBinding(store);
  store.close();

  const provider = createStoreDependencies({
    clock: (): string => SELECTOR_DECIDED_AT, credential: CREDENTIAL, principalId: PRINCIPAL_ID,
    projectId: PROJECT_ID, storePath,
  });
  const request: RuntimeCommandEnvelope = {
    commandId: "cmd-served-selector", commandKind: FOUNDATION_VERIFICATION_COMMAND_KIND,
    correlationId: "corr-served-selector", expectedVersion: 0,
    payload: {
      attemptAggregateId: SELECTOR_ACTIVATION_AGGREGATE, candidateRoot,
      expectedRecordDigest: recordDigest, recipeAggregateId, verificationId,
    } as RuntimeCommandEnvelope["payload"],
    requestDigest: DIGEST, schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    sessionCredential: CREDENTIAL, targetAggregateId: SELECTOR_ACTIVATION_AGGREGATE,
  };
  try {
    const answered = await handleAsyncCommandRequest(provider.provide(), {
      body: new TextEncoder().encode(JSON.stringify(request)),
      credential: CREDENTIAL, protocolVersion: WIRE_PROTOCOL_VERSION,
    });
    if (!answered.ok) throw new Error(`served verification refused: ${JSON.stringify(answered)}`);
  } finally {
    provider.close();
  }
}

export interface SelectorWorldOptions {
  /** `false` seals no context manifest at all: the home of a zero-candidate scan. */
  readonly seal?: boolean;
  /** `false` stops before the release chain: an attempt with no releasable evidence. */
  readonly release?: boolean;
  /** Extra sealed manifests, each a deliberate corruption of the real one. */
  readonly variants?: readonly SelectorManifestPatch[];
}

export interface SelectorWorld {
  readonly manifest: ContextRenderManifest;
  readonly provenance: FoundationContextProvenance;
  readonly recordDigest: string;
  readonly root: string;
  readonly storePath: string;
}

const roots: string[] = [];

/** Removes every directory this module created. Call from an `afterAll`. */
export function cleanupSelectorWorlds(): void {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, maxRetries: 5, recursive: true });
  }
}

export function openSelectorStore(storePath: string): SqliteEventStore {
  return SqliteEventStore.openForProject(storePath, PROJECT_ID);
}

/** ONE store, every production writer, in the only order that admits them all. */
export async function selectorWorld(
  label: string, options: SelectorWorldOptions = {},
): Promise<SelectorWorld> {
  const root = mkdtempSync(join(tmpdir(), `moe-selector-${label}-`));
  roots.push(root);
  const storePath = join(root, "project.db");
  const store = openSelectorStore(storePath);
  let closed = false;
  try {
    seedReadyProject(store, { approval: "DEFER" });
    seedApprovalChain(store);
    const configurationDigest = seedConfiguration(store);
    const activated = runEffectActivateCommand(store, activationBytes());
    if (!activated.ok) throw new Error(`activation refused: ${activated.code}`);
    const history = readFoundationActivationHistory(SELECTOR_ACTIVATION_AGGREGATE,
      store.readEvents(SELECTOR_ACTIVATION_AGGREGATE), PROJECT_ID);
    if (!history.ok) throw new Error(`activation unreadable: ${history.result.status}`);
    const bound: FoundationAttemptBound = Object.freeze({
      aggregateId: SELECTOR_ACTIVATION_AGGREGATE, claim: {}, commandId: "cmd-dispatch-selector",
      correlationId: "corr-dispatch-selector", nodeKey: SELECTOR_NODE_KEY,
      principalId: PRINCIPAL_ID, projectId: PROJECT_ID, sessionId: SELECTOR_SESSION_ID,
      target: deriveDispatchAggregateId(SELECTOR_ACTIVATION_AGGREGATE),
    });
    const recordDigest = seedProvenAttemptRecord(store, bound, history.history.record);
    const { activationDigest } = history.history.record;
    seedJournalAndReviews(store);
    const sealedCapture = commitFoundationCaptureContext(store, {
      candidate: captureCandidate(join(root, "worktree")), decidedAt: SELECTOR_DECIDED_AT,
    });
    if (!sealedCapture.ok) throw new Error(`capture refused: ${sealedCapture.code}`);

    const assembled = createFoundationContextAuthority({
      expectedConfigurationDigest: configurationDigest, store,
    }).assembleFoundationContextSelection({
      attemptRef: SELECTOR_ATTEMPT_ID, nodeKey: SELECTOR_NODE_KEY, projectId: PROJECT_ID,
      sessionId: SELECTOR_SESSION_ID,
    });
    if (!assembled.ok) throw new Error(`context selection refused: ${assembled.code}`);
    const manifest = renderContext(assembled.selection).manifest;
    const world: SelectorWorld = {
      manifest, provenance: assembled.provenance, recordDigest, root, storePath,
    };
    if (options.seal !== false) sealSelectorManifest(store, world, {});
    for (const patch of options.variants ?? []) sealSelectorManifest(store, world, patch);
    if (options.release !== false) {
      closed = true;
      await seedRelease(store, storePath, {
        activationDigest, provenance: assembled.provenance, recordDigest, root,
      });
    }
    return world;
  } finally {
    if (!closed) store.close();
  }
}

/** A durable manifest row, optionally corrupted. Every field the patch does not name is the
 *  REAL one, so an arm names exactly the one fact it is about. */
export interface SelectorManifestPatch {
  readonly attemptRef?: string;
  readonly sessionId?: string;
  readonly nodeKey?: string;
  /** Per-item field overrides, keyed by canonical item id. */
  readonly itemFields?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly dropItem?: string;
  readonly duplicateItem?: string;
  /** Replaces the rendered bytes with something that is not canonical item text at all. */
  readonly unparsableBytes?: boolean;
}

function patchedBytes(
  manifest: ContextRenderManifest, patch: SelectorManifestPatch,
): readonly number[] {
  const encoder = new TextEncoder();
  if (patch.unparsableBytes === true) {
    return Array.from(encoder.encode("this is not a canonical context item"));
  }
  const text = new TextDecoder("utf-8", { fatal: true })
    .decode(Uint8Array.from(manifest.binding.exactBytes));
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    const item = JSON.parse(line) as Record<string, unknown>;
    const id = item["id"];
    if (id === patch.dropItem) continue;
    const fields = patch.itemFields?.[typeof id === "string" ? id : ""];
    if (fields !== undefined) {
      const content = { ...JSON.parse(item["content"] as string) as object, ...fields };
      lines.push(JSON.stringify({ ...item, content: JSON.stringify(content) }));
    } else lines.push(JSON.stringify(item));
    if (id === patch.duplicateItem) lines.push(lines[lines.length - 1] as string);
  }
  return Array.from(encoder.encode(lines.join("\n")));
}

/**
 * Seals one manifest through the PRODUCTION writer. The digest is recomputed by the production
 * `digestContextManifest` over the patched binding, so a corrupted row is durably self-consistent
 * — which is the only kind of corruption worth grading: a row the codec would reject on its own
 * never reaches the join this selector performs.
 */
export function sealSelectorManifest(
  store: SqliteEventStore, world: SelectorWorld, patch: SelectorManifestPatch,
): void {
  const binding = { ...world.manifest.binding, exactBytes: patchedBytes(world.manifest, patch) };
  const manifest: ContextRenderManifest = {
    binding, digest: digestContextManifest(binding), version: world.manifest.version,
  };
  const { provenance } = world;
  const fields = {
    attemptRef: patch.attemptRef ?? provenance.attemptRef,
    configurationDigest: provenance.configurationDigest,
    graphContentHash: provenance.graphContentHash, graphEpoch: provenance.graphEpoch,
    graphRevisionRef: provenance.graphRevisionId,
    inputManifestDigest: provenance.inputManifestSha256, manifest,
    nodeKey: patch.nodeKey ?? provenance.nodeKey, projectId: provenance.projectId,
    sessionId: patch.sessionId ?? provenance.sessionId,
  };
  const committed = commitFoundationContextManifest(store, {
    candidate: { ...fields, recordDigest: deriveFoundationContextRecordDigest(fields) },
    decidedAt: SELECTOR_DECIDED_AT,
  });
  if (!committed.ok) throw new Error(`variant seal refused: ${committed.code}`);
}

// ============================================================================
// NARROWLY SCOPED FAULTS. Each replaces exactly ONE store method and forwards the rest to the
// real instance, so an arm cannot pass because the whole store went dark.
// ============================================================================

/** The horizon MOVES after the first read. The activation reader takes its own two readings
 *  after that point and sees a stable value, so this arm reaches the composition's own
 *  currentness fence rather than an upstream one. */
export function movingHorizonStore(store: SqliteEventStore): SqliteEventStore {
  let reads = 0;
  const base = store.readEventHorizon();
  return withStoreOverride(store, {
    readEventHorizon: (): bigint => {
      reads += 1;
      return reads === 1 ? base : base + 1n;
    },
  });
}

/** The ACTIVE graph is enumerable for the parent-authority leg and gone for the selector's own
 *  re-read: the graph moved out from under the composition. */
export function movingGraphStore(store: SqliteEventStore): SqliteEventStore {
  let reads = 0;
  return withStoreOverride(store, {
    enumerateAggregateIdsByPrefix: (prefix: string): readonly string[] => {
      reads += 1;
      return reads === 1 ? store.enumerateAggregateIdsByPrefix(prefix) : [];
    },
  });
}

/** The goal aggregate loses its `GoalExecutionEnabled` witness and keeps everything else. The
 *  durable ledger folds COMMAND DECISIONS, not events, so the parent-authority leg is untouched
 *  and the approved-run leg is the one that answers. */
export function witnesslessStore(store: SqliteEventStore, goalId: string): SqliteEventStore {
  return withStoreOverride(store, {
    readEvents: (aggregateId: string): readonly StoredEvent[] => {
      const events = store.readEvents(aggregateId);
      return aggregateId === goalId
        ? events.filter((event) => event.eventType !== "GoalExecutionEnabled") : events;
    },
  });
}

/** A SECOND durable PlanningRun under the same goal. The approved plan still names the first,
 *  so a query naming this one passes the parent-authority leg and fails the run join. */
export function extraPlanningRunStore(
  store: SqliteEventStore, runId: string, goalRef: string,
): SqliteEventStore {
  const encoder = new TextEncoder();
  return withStoreOverride(store, {
    readCommandDecisionsAfter: (
      after: bigint, limit?: number,
    ): CursorPage<CommandDecisionRecord, bigint> => {
      const page = store.readCommandDecisionsAfter(after, limit);
      const [seed] = page.items.filter((item) => item.effectDisposition === "EFFECTS_COMMITTED");
      if (seed === undefined) return page;
      const injected = {
        ...seed, targetAggregateId: runId,
        resultBytes: encoder.encode(JSON.stringify({
          state: { goalRef, lifecycle: "APPROVED", runId },
        })),
      } as CommandDecisionRecord;
      return { ...page, items: [...page.items, injected] };
    },
  });
}

/** The typed pager THROWS: the locator cannot read its own evidence. */
export function pagerFaultStore(store: SqliteEventStore): SqliteEventStore {
  return withStoreOverride(store, {
    readEventsByTypeAfter: (): never => { throw new Error("injected typed-page read failure"); },
  });
}

/** The typed pager claims more pages and returns none: a truncated walk that must never be
 *  mistaken for a complete one. */
export function truncatedPagerStore(store: SqliteEventStore): SqliteEventStore {
  return withStoreOverride(store, {
    readEventsByTypeAfter: (): CursorPage<StoredEvent, bigint> =>
      ({ hasMore: true, items: [], nextCursor: null }),
  });
}

/** The store answers for another project. */
export function foreignProjectStore(store: SqliteEventStore): SqliteEventStore {
  return withStoreOverride(store, {
    getHealth: (): unknown => ({ ...store.getHealth(), projectId: "project-elsewhere" }),
  });
}

/** The store cannot report its own health. */
export function unhealthyStore(store: SqliteEventStore): SqliteEventStore {
  return withStoreOverride(store, {
    getHealth: (): never => { throw new Error("injected store health failure"); },
  });
}

/**
 * ONE extra durable aggregate, folded from a real committed decision so the ledger admits it.
 * `state` is the record `stateOf` will hand back verbatim — a goal record is read at the top
 * level, a planning-run record under a `state` key — which is what lets an arm name a goal or a
 * run this project never owned WITHOUT the store having to answer for a foreign project.
 */
export function injectedStateStore(
  store: SqliteEventStore, aggregateId: string, state: Record<string, unknown>,
): SqliteEventStore {
  const encoder = new TextEncoder();
  return withStoreOverride(store, {
    readCommandDecisionsAfter: (
      after: bigint, limit?: number,
    ): CursorPage<CommandDecisionRecord, bigint> => {
      const page = store.readCommandDecisionsAfter(after, limit);
      const [seed] = page.items.filter((item) => item.effectDisposition === "EFFECTS_COMMITTED");
      if (seed === undefined) return page;
      const injected = {
        ...seed, resultBytes: encoder.encode(JSON.stringify(state)),
        targetAggregateId: aggregateId,
      } as CommandDecisionRecord;
      return { ...page, items: [...page.items, injected] };
    },
  });
}
