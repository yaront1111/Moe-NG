/**
 * The six seeded durable sources a server-built `ReleaseHandoff` needs, in a real
 * file-backed store (task-a20e8ef668b54c3abbfce37a505252eb).
 *
 * EVERY DIGEST HERE COMES OUT OF A PRODUCTION DERIVATION. The observation is a genuine
 * `observeScope` answer, the input manifest a genuine `buildInputManifest`, the context
 * manifest a genuine `selectContext` -> `renderContext`, the record digests the production
 * derivers' own. A hand-forged digest would put a value in the fixture that no production
 * code ever produced, and every cross-source arm the builder relies on would then be
 * comparing two hand-written numbers — a tautology, not a test.
 *
 * The step and journal sources go through their production command handlers after the
 * fixture creates a real activation/session binding. Corrupt-tail helpers are deliberately
 * separate: they first require an honest production write and only then append malformed
 * evidence for refusal tests. A corrupt row is never presented as authority provenance.
 *
 * `overrides` on each seeder exists so a mutation drill can drift exactly ONE field of an
 * otherwise honest record. Every seeder is spread-last for that reason.
 */

import { join } from "node:path";

import { createDeadEndJournal, renderContext, selectContext } from "@moe/context";
import type { DeadEndJournalEntry } from "@moe/context";
import { buildInputManifest, observeScope } from "@moe/runner";
import type {
  ClaudeLaunchSelection, GitObserver, ProviderFactUnknown, ProviderRunRef,
  ScopeObservation, ScopePathObserver, WorkspaceInputEntry,
  WorkspaceInputManifest,
} from "@moe/runner";
import type { SqliteEventStore } from "@moe/store";

import {
  JOURNAL_APPEND_COMMAND_KIND, JOURNAL_APPEND_EVENT_TYPE, JOURNAL_APPEND_SCHEMA_VERSION,
  JOURNAL_RECORD_VERSION, deriveAttemptJournalAggregateId,
} from "../journal/journal-contracts.js";
import { runJournalAppendCommand } from "../journal/journal-append.js";
import { readFoundationActivationByAttempt } from "../activation/activation-attempt-reader.js";
import { readFoundationActivationHistory } from "../activation/activation-ledger-reader.js";
import { PRINCIPAL_ID, PROJECT_ID } from "../recovery/restore-test-harness.js";
import { PROVIDER_RUN_RECORD_VERSION } from "../telemetry/provider-run-contracts.js";
import type { ProviderRunRecord } from "../telemetry/provider-run-contracts.js";
import { commitProviderRunRecord } from "../telemetry/provider-run-ledger.js";
import { readCurrentProviderRun } from "../telemetry/provider-run-reader.js";
import { encodeFoundationPayload } from "./foundation-attempt-codec.js";
import { deriveDispatchAggregateId } from "./foundation-attempt-codec.js";
import { FOUNDATION_DISPATCH_EVENT_TYPES } from "./foundation-attempt-contracts.js";
import type { FoundationAttemptBound } from "./foundation-attempt-contracts.js";
import { commitFoundationPhase } from "./foundation-attempt-store.js";
import {
  FOUNDATION_CAPTURE_CONTEXT_VERSION, deriveFoundationCaptureContextRecordDigest,
} from "./foundation-capture-context-contract.js";
import { commitFoundationCaptureContext } from "./foundation-capture-context-ledger.js";
import { sealFoundationArtifactRoster } from "./foundation-artifact-ledger.js";
import {
  deriveFoundationContextRecordDigest,
} from "./foundation-context-manifest-codec.js";
import { commitFoundationContextManifest } from "./foundation-context-manifest-ledger.js";
import {
  STEP_CHECKPOINT_COMMAND_KIND, STEP_FINISH_COMMAND_KIND, STEP_LIFECYCLE_SCHEMA_VERSION,
  STEP_RECORD_VERSION, STEP_STARTED_EVENT_TYPE, STEP_START_COMMAND_KIND,
  deriveAttemptStepAggregateId, deriveStepRef,
} from "./step-lifecycle-contracts.js";
import type { StepLifecycleCommandKind } from "./step-lifecycle-contracts.js";
import { runStepLifecycleCommand } from "./step-lifecycle-command.js";

export const HANDOFF_HEAD_COMMIT = "a".repeat(40);
export const HANDOFF_OBSERVED_AT = "2026-08-19T00:00:00Z";
export const HANDOFF_DECIDED_AT = "2026-08-16T00:00:00.000Z";
export const HANDOFF_CONFIGURATION_DIGEST = "c".repeat(64);
const OBSERVER_VERSION = "moe-runner-scope-observer/1";
const DECLARED_PATHS = Object.freeze(["src/a.ts", "src/b.ts"]);
const encoder = new TextEncoder();

/** Which attempt is being seeded. Every field is one the SERVER already holds. */
export interface HandoffSeedIdentity {
  readonly activationDigest: string;
  readonly attemptAggregateId: string;
  readonly attemptRef: string;
  readonly decidedAt?: string;
  readonly effectId: string;
  readonly leaseRef: string;
  readonly nodeKey: string;
  readonly projectId: string;
  readonly sessionId: string;
}

type Patch = Readonly<Record<string, unknown>>;

export interface StepSeedOptions { readonly checkpoint?: boolean }
export interface StepSeedReceipt {
  readonly checkpointRef: string | null;
  readonly commandIds: readonly string[];
}
export interface JournalSeedReceipt { readonly commandId: string }
export interface ReleaseHandoffSeedOptions { readonly providerRun?: boolean }

const UNKNOWN_PROVIDER_FACT: ProviderFactUnknown = Object.freeze({
  code: "TELEMETRY_USAGE_ABSENT", known: false, layer: "TELEMETRY_RESULT",
});

export const HANDOFF_LAUNCH_SELECTION: ClaudeLaunchSelection = Object.freeze({
  concurrencyCeiling: 4, configurationDigest: HANDOFF_CONFIGURATION_DIGEST,
  modelSnapshotEvidence: "claude-opus-5-20260514/build-2026-05-14",
  modelSnapshotKind: "DATED_SNAPSHOT", orchestrationDigest: "3e".repeat(32),
  policyDigest: "2d".repeat(32), profileRevisionId: "profile-revision-19",
  provider: "claude", reasoningEffort: "high", selectedModelId: "claude-opus-5-20260514",
});

function providerRunRecord(ref: ProviderRunRef, overrides: Patch): ProviderRunRecord {
  return {
    concurrency: {
      achieved: UNKNOWN_PROVIDER_FACT, declaredCeiling: UNKNOWN_PROVIDER_FACT,
      fact: "NO_CONCURRENCY_FACTS",
    },
    declared: { known: true, selection: HANDOFF_LAUNCH_SELECTION },
    infrastructure: "NONE",
    launch: {
      activationDigest: null, completedAt: HANDOFF_DECIDED_AT, effectDigest: null,
      exit: { code: 0, kind: "EXITED" }, freshRuntimeDigest: null, kind: "OBSERVED",
      observationDigest: null, pinnedClosureDigest: null, quotedRuntimeDigest: null,
      reasonCode: null, reasonLayer: null, runtimeBindingDigest: null,
      startedAt: HANDOFF_DECIDED_AT, truthClass: "PROVEN",
    },
    observedEnd: null,
    observedModel: {
      modelId: UNKNOWN_PROVIDER_FACT, snapshotEvidence: UNKNOWN_PROVIDER_FACT,
      snapshotKind: "UNKNOWN",
    },
    observedStart: null, providerRunRef: ref, recordDigest: "",
    recordVersion: PROVIDER_RUN_RECORD_VERSION, sequence: { known: true, value: 1 },
    steps: { coverage: "UNKNOWN", turns: UNKNOWN_PROVIDER_FACT },
    stderrReceiptDigest: { known: true, value: "stderr-release-handoff" },
    stdoutReceiptDigest: { known: true, value: "stdout-release-handoff" },
    terminal: "COMPLETED",
    tokens: {
      cacheCreationInputTokens: UNKNOWN_PROVIDER_FACT,
      cacheReadInputTokens: UNKNOWN_PROVIDER_FACT, coverage: "UNKNOWN",
      inputTokens: UNKNOWN_PROVIDER_FACT, outputTokens: UNKNOWN_PROVIDER_FACT,
    },
    upstreamRefusal: null, usage: [], usageRefusals: [], ...overrides,
  };
}

/** A REAL sealed observation, driven through `observeScope`'s injected ports. */
function observationFor(root: string): ScopeObservation {
  const gitObserver: GitObserver = {
    headCommit: () => HANDOFF_HEAD_COMMIT,
    lsFilesIgnored: () => [],
    lsFilesTracked: () => [...DECLARED_PATHS],
    statusPorcelainV2: () => encoder.encode(`# branch.oid ${HANDOFF_HEAD_COMMIT}\0`),
    submodulePaths: () => [],
  };
  const pathObserver: ScopePathObserver = { exists: () => true, realpath: (path) => path };
  const observed = observeScope({
    baseIdentity: HANDOFF_HEAD_COMMIT, declaredScopePaths: [...DECLARED_PATHS], gitObserver,
    observedAt: HANDOFF_OBSERVED_AT, observerVersion: OBSERVER_VERSION, pathObserver,
    worktreeRoot: root,
  });
  if (!observed.ok) throw new Error(`fixture observation refused: ${observed.code}`);
  return observed.observation;
}

/** A REAL sealed input manifest, for the same reason. */
export function handoffInputManifest(): WorkspaceInputManifest {
  const entries: WorkspaceInputEntry[] = [0, 1].map((index) => ({
    byteLength: 8, path: `src/${String(index)}.ts`, producer: { kind: "BASE" as const },
    sha256: index.toString(16).padStart(64, "0"),
  }));
  const built = buildInputManifest({ baseIdentity: HANDOFF_HEAD_COMMIT, entries });
  if (!built.ok) throw new Error(`fixture manifest refused: ${built.code}`);
  return built.manifest;
}

/** The durable step record, with a checkpoint so `nextSafeAction` has a producer. */
function runStep(
  store: SqliteEventStore, identity: HandoffSeedIdentity,
  kind: StepLifecycleCommandKind, payload: Readonly<Record<string, unknown>>, suffix: string,
): string {
  const commandId = `cmd-handoff-step-${identity.activationDigest.slice(0, 8)}-${suffix}`;
  const decidedAt = seedCommandDecidedAt(store, identity);
  const outcome = runStepLifecycleCommand(store, encoder.encode(JSON.stringify({
    commandId, correlationId: `corr-${commandId}`, decidedAt,
    expectedVersion: 0, kind, payload, principalId: identity.sessionId,
    projectId: identity.projectId, schemaVersion: STEP_LIFECYCLE_SCHEMA_VERSION,
  })));
  if (!outcome.ok) {
    throw new Error(`step fixture ${suffix} refused: ${outcome.code}@${outcome.refusedBy}`);
  }
  return commandId;
}

export function seedStepRecord(
  store: SqliteEventStore, identity: HandoffSeedIdentity, options: StepSeedOptions = {},
): StepSeedReceipt {
  const common = { attemptAggregateId: identity.attemptAggregateId, effectId: identity.effectId };
  const planRef = deriveStepRef(identity.activationDigest, 0);
  const buildRef = deriveStepRef(identity.activationDigest, 1);
  const commandIds = [
    runStep(store, identity, STEP_START_COMMAND_KIND, { ...common, label: "plan" }, "start-plan"),
    runStep(store, identity, STEP_FINISH_COMMAND_KIND, { ...common, stepRef: planRef }, "finish-plan"),
    runStep(store, identity, STEP_START_COMMAND_KIND, { ...common, label: "build" }, "start-build"),
  ];
  if (options.checkpoint !== false) {
    commandIds.push(runStep(store, identity, STEP_CHECKPOINT_COMMAND_KIND,
      { ...common, nextSafeActionRef: buildRef }, "checkpoint-build"));
  }
  return Object.freeze({
    checkpointRef: options.checkpoint === false ? null : buildRef,
    commandIds: Object.freeze(commandIds),
  });
}

/**
 * One canonical dead-end entry, so a seeded journal is READABLE. Measured, not assumed:
 * `decodeJournalEntries` answers `JOURNAL_ENTRY_LIST_EMPTY` for `[]` and the reader maps
 * that to `JOURNAL_RECORD_MALFORMED`, so a zero-entry journal row is unreadable and an
 * attempt holding one has no releasable checkpoint at all.
 */
export function handoffJournalEntry(id = "dead-end-1"): DeadEndJournalEntry {
  return {
    actorId: "agent-1", baseDigest: "b".repeat(64), environmentDigest: "c".repeat(64),
    failureCode: "VERIFY_FAILED", id, kind: "VERIFICATION_FAILURE",
    occurredAt: "2026-08-15T00:00:01.000Z", primaryScope: "scope-1",
    recipeDigest: "d".repeat(64),
    retryPredicate: {
      expectedVersion: 2, factId: "fact-1", kind: "FACT_VERSION", operator: "GREATER_THAN",
    },
    text: `dead end ${id}`,
  } as DeadEndJournalEntry;
}

/** The durable journal. Its digest comes from `createDeadEndJournal` — the same production
 *  fold the reader re-runs — never from a literal, so the reader's re-derivation has
 *  something real to agree with. */
export function seedJournal(
  store: SqliteEventStore, identity: HandoffSeedIdentity,
  entries: readonly DeadEndJournalEntry[] = [handoffJournalEntry()],
): JournalSeedReceipt {
  ensureDispatchReservation(store, identity);
  const commandId = `cmd-handoff-journal-${identity.activationDigest.slice(0, 8)}`;
  const decidedAt = seedCommandDecidedAt(store, identity);
  const outcome = runJournalAppendCommand(store, encoder.encode(JSON.stringify({
    commandId, correlationId: `corr-${commandId}`, decidedAt,
    expectedVersion: 0, kind: JOURNAL_APPEND_COMMAND_KIND,
    payload: {
      attemptAggregateId: identity.attemptAggregateId, effectId: identity.effectId, entries,
    },
    principalId: identity.sessionId, projectId: identity.projectId,
    schemaVersion: JOURNAL_APPEND_SCHEMA_VERSION,
  })));
  if (!outcome.ok) {
    throw new Error(`journal fixture refused: ${outcome.code}@${outcome.refusedBy}`);
  }
  return Object.freeze({ commandId });
}

function seedCommandDecidedAt(
  store: SqliteEventStore, identity: HandoffSeedIdentity,
): string {
  if (identity.decidedAt !== undefined) return identity.decidedAt;
  const history = readFoundationActivationHistory(identity.attemptAggregateId,
    store.readEvents(identity.attemptAggregateId), identity.projectId);
  if (!history.ok) {
    const detail = "code" in history.result ? history.result.code : history.result.status;
    throw new Error(`handoff fixture activation refused: ${detail}`);
  }
  return new Date(history.history.record.lease.serverWallDeadline * 1_000).toISOString();
}

function ensureDispatchReservation(
  store: SqliteEventStore, identity: HandoffSeedIdentity,
): void {
  const target = deriveDispatchAggregateId(identity.attemptAggregateId);
  if (store.readEvents(target).some(({ eventType }) =>
    eventType === FOUNDATION_DISPATCH_EVENT_TYPES.RESERVED)) return;
  const history = readFoundationActivationHistory(identity.attemptAggregateId,
    store.readEvents(identity.attemptAggregateId), identity.projectId);
  if (!history.ok) {
    const detail = "code" in history.result ? history.result.code : history.result.status;
    throw new Error(`dispatch fixture activation refused: ${detail}`);
  }
  const grantId = history.history.record.grant.grantId;
  const bytes = encodeFoundationPayload({
    activationDigest: identity.activationDigest, attemptAggregateId: identity.attemptAggregateId,
    attemptId: identity.attemptRef, grantId, nodeKey: identity.nodeKey,
    recordVersion: "moe-foundation-attempt-reservation/1", requestDigest: "f".repeat(64),
    sessionId: identity.sessionId,
  });
  if (!bytes.ok) throw new Error(`dispatch fixture payload refused: ${bytes.code}`);
  const bound: FoundationAttemptBound = Object.freeze({
    aggregateId: identity.attemptAggregateId, claim: Object.freeze({}),
    commandId: `cmd-handoff-dispatch-${identity.activationDigest.slice(0, 8)}`,
    correlationId: `corr-handoff-dispatch-${identity.activationDigest.slice(0, 8)}`,
    nodeKey: identity.nodeKey, principalId: identity.sessionId, projectId: identity.projectId,
    sessionId: identity.sessionId, target,
  });
  const committed = commitFoundationPhase(store, bound, "RESERVED", bytes.bytes, 0,
    `${grantId}:HANDOFF_RESERVED`);
  if (committed === null || committed.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    throw new Error("dispatch fixture reservation was not committed");
  }
}

export function corruptStepTail(
  store: SqliteEventStore, identity: HandoffSeedIdentity, overrides: Patch,
): void {
  const startedSteps = ["plan", "build"].map((label, ordinal) => ({
    label, ordinal, stepRef: deriveStepRef(identity.activationDigest, ordinal),
  }));
  const body = {
    activationDigest: identity.activationDigest, attemptRef: identity.attemptRef,
    checkpointRef: startedSteps[1]?.stepRef ?? "",
    completedSteps: [startedSteps[0]?.stepRef ?? ""], effectId: identity.effectId,
    leaseRef: identity.leaseRef, projectId: identity.projectId,
    recordVersion: STEP_RECORD_VERSION, sessionId: identity.sessionId, startedSteps,
    truthClass: "DAEMON_VERIFIED", ...overrides,
  };
  plant(store, deriveAttemptStepAggregateId(identity.activationDigest), body,
    STEP_START_COMMAND_KIND, STEP_STARTED_EVENT_TYPE,
    `corrupt-step-${identity.activationDigest.slice(0, 8)}`);
}

export function corruptJournalTail(
  store: SqliteEventStore, identity: HandoffSeedIdentity, overrides: Patch,
): void {
  const admitted = createDeadEndJournal([handoffJournalEntry()]);
  if (admitted.kind !== "ADMITTED") throw new Error(`fixture journal refused: ${admitted.limit}`);
  const body = {
    activationDigest: identity.activationDigest, attemptRef: identity.attemptRef,
    effectId: identity.effectId, entries: admitted.journal.entries,
    journalDigest: admitted.journal.digest, leaseRef: identity.leaseRef,
    nodeKey: identity.nodeKey, projectId: identity.projectId,
    recordVersion: JOURNAL_RECORD_VERSION, sessionId: identity.sessionId,
    truthClass: "DAEMON_VERIFIED", ...overrides,
  };
  plant(store, deriveAttemptJournalAggregateId(identity.activationDigest), body,
    JOURNAL_APPEND_COMMAND_KIND, JOURNAL_APPEND_EVENT_TYPE,
    `corrupt-journal-${identity.activationDigest.slice(0, 8)}`);
}

/** THE PRODUCTION WRITER, unmodified. Returns the manifest sha the artifact seal and the
 *  context manifest must both agree with — the builder's two-source cross-check. */
export function seedCaptureContext(
  store: SqliteEventStore, identity: HandoffSeedIdentity, overrides: Patch = {},
): string {
  const manifest = handoffInputManifest();
  const root = join("fixture-parent", `${identity.projectId}-${identity.attemptRef}`);
  const body = {
    artifactDeclaration: "NONE", assignment: {
      adopted: false, assignmentVersion: "moe-worktree-assignment/1",
      attemptId: identity.attemptRef, baseIdentity: HANDOFF_HEAD_COMMIT,
      leaf: `${identity.projectId}-${identity.attemptRef}`, projectId: identity.projectId,
      realSourceRepositoryRoot: join("fixture-source", "repo"),
      realWorktreeParent: "fixture-parent", realWorktreePath: root, worktreePath: root,
    },
    attemptAggregateId: identity.attemptAggregateId, attemptId: identity.attemptRef,
    baselineDigest: manifest.sha256, catalogAuthority: {
      baseRevisionHash: HANDOFF_HEAD_COMMIT, catalogDigest: "c".repeat(64),
      declaredPaths: [...DECLARED_PATHS], projectId: identity.projectId,
      repositoryRef: "repo-main", scopeRef: "scope-default",
      sourceRepositoryRoot: join("fixture-source", "repo"), worktreeParent: "fixture-parent",
    },
    inputManifest: manifest, nodeKey: identity.nodeKey, observation: observationFor(root),
    observedAt: HANDOFF_OBSERVED_AT, projectId: identity.projectId,
    recordVersion: FOUNDATION_CAPTURE_CONTEXT_VERSION, requestDigest: "d".repeat(64),
    reservationDigest: "e".repeat(64), sessionId: identity.sessionId, ...overrides,
  };
  const candidate = {
    ...body, recordDigest: deriveFoundationCaptureContextRecordDigest(body),
  };
  const committed = commitFoundationCaptureContext(
    store, { candidate, decidedAt: HANDOFF_DECIDED_AT });
  if (!committed.ok) throw new Error(`capture seed refused: ${committed.code}`);
  return manifest.sha256;
}

/** A decision-verified provider run, committed through the production ledger writer. */
export function seedProviderRun(
  store: SqliteEventStore, identity: HandoffSeedIdentity, overrides: Patch = {},
  principalId = identity.sessionId,
): void {
  const binding = readFoundationActivationByAttempt(
    store, identity.projectId, identity.attemptRef);
  if (binding.status !== "BOUND") {
    throw new Error(`provider-run attempt unbound: ${binding.status}/${String(binding.code)}`);
  }
  const committed = commitProviderRunRecord(store, {
    correlationId: `corr-provider-run-${identity.attemptRef}`, decidedAt: HANDOFF_DECIDED_AT,
    key: {
      commandId: `cmd-provider-run-${identity.attemptRef}`, principalId,
      projectId: identity.projectId,
    },
    record: providerRunRecord({
      attemptRef: binding.attemptId, effectIntentId: binding.effectIntentId,
      epoch: binding.epoch, provider: "claude", runRef: `run-${identity.attemptRef}`,
    }, overrides),
    requestBytes: encoder.encode(`provider-run-request-${identity.attemptRef}`),
  });
  if (!committed.ok) {
    throw new Error(`provider run refused: ${committed.code} at ${committed.layer}`);
  }
}

function ensureProviderRun(store: SqliteEventStore, identity: HandoffSeedIdentity): void {
  const current = readCurrentProviderRun(store, {
    attemptRef: identity.attemptRef, projectId: identity.projectId,
  });
  if ("ok" in current && current.ok) return;
  if ("ok" in current && current.code === "PROVIDER_RUN_EVIDENCE_ABSENT") {
    seedProviderRun(store, identity);
    return;
  }
  throw new Error(`provider-run fixture refused: ${current.code}@${current.layer}`);
}

/** THE PRODUCTION WRITER, unmodified. `inputManifestDigest` is the CAPTURE record's own
 *  sha, which is what makes the builder's cross-check a real two-source comparison. */
export function seedContextManifest(
  store: SqliteEventStore, identity: HandoffSeedIdentity, inputManifestDigest: string,
  overrides: Patch = {},
): void {
  const selected = selectContext({
    byteBudget: 4_096, exclusions: [],
    mandatory: [{ content: "the task", id: "m-1", kind: "MANDATORY", section: "brief" }],
    optional: [],
  });
  if (selected.kind !== "ADMITTED") throw new Error(`fixture selection refused: ${selected.code}`);
  const fields = {
    attemptRef: identity.attemptRef, configurationDigest: "c".repeat(64),
    graphContentHash: "a".repeat(64), graphEpoch: 3, graphRevisionRef: "graph-revision-1",
    inputManifestDigest, manifest: renderContext(selected.selection).manifest,
    nodeKey: identity.nodeKey, projectId: identity.projectId, sessionId: identity.sessionId,
    ...overrides,
  };
  const committed = commitFoundationContextManifest(store, {
    candidate: { ...fields, recordDigest: deriveFoundationContextRecordDigest(fields) },
    decidedAt: HANDOFF_DECIDED_AT,
  });
  if (!committed.ok) throw new Error(`context seed refused: ${committed.code}`);
}

/** THE PRODUCTION WRITER, unmodified. It derives its own decided-at from the attempt
 *  aggregate, so the activation must already be committed when this runs. */
export function seedArtifactManifest(
  store: SqliteEventStore, identity: HandoffSeedIdentity, inputManifestSha256: string,
  overrides: Patch = {},
): void {
  const sealed = sealFoundationArtifactRoster(store, {
    attemptAggregateId: identity.attemptAggregateId, attemptRef: identity.attemptRef,
    commandId: `cmd-artifact-${identity.attemptRef}`,
    correlationId: `corr-artifact-${identity.attemptRef}`, declaredArtifactRefs: [],
    inputManifestSha256, principalId: PRINCIPAL_ID, projectId: identity.projectId,
    resultManifestSha256: "f".repeat(64), ...overrides,
  });
  if (!sealed.ok) throw new Error(`artifact seed refused: ${sealed.code}`);
}

/** All six seeded sources, in the order the builder reads them. Returns the shared input sha
 *  so a drill can drift ONE consumer of it and watch the cross-check refuse. */
export function seedReleaseHandoffSources(
  store: SqliteEventStore, identity: HandoffSeedIdentity,
  options: ReleaseHandoffSeedOptions = {},
): string {
  seedStepRecord(store, identity);
  seedJournal(store, identity);
  const inputSha = seedCaptureContext(store, identity);
  if (options.providerRun !== false) ensureProviderRun(store, identity);
  seedContextManifest(store, identity, inputSha);
  seedArtifactManifest(store, identity, inputSha);
  return inputSha;
}

/** The store's own write API, used ONLY where a command handler fences on a session
 *  binding no fixture may manufacture. Named at every call site above. */
function plant(
  store: SqliteEventStore, aggregateId: string, body: unknown, commandKind: string,
  eventType: string, slug: string,
): void {
  const encoded = encodeFoundationPayload(body);
  if (!encoded.ok) throw new Error(`planted body refused by the codec: ${encoded.code}`);
  const response = store.commitExpectedVersionDecision({
    commandKind, committedResultBytes: encoded.bytes, correlationId: `corr-plant-${slug}`,
    decidedAt: HANDOFF_DECIDED_AT,
    events: [{ eventId: `planted-${slug}`, eventType, payload: encoded.bytes }],
    expectedVersion: store.readEvents(aggregateId).length,
    key: { commandId: `cmd-plant-${slug}`, principalId: PRINCIPAL_ID, projectId: PROJECT_ID },
    requestBytes: encoded.bytes, targetAggregateId: aggregateId,
  });
  if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    throw new Error(`planting refused: ${response.decision.effectDisposition}`);
  }
}
