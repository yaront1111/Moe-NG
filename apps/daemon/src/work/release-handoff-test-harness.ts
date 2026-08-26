/**
 * The five durable sources a server-built `ReleaseHandoff` needs, seeded into a real
 * file-backed store (task-a20e8ef668b54c3abbfce37a505252eb).
 *
 * EVERY DIGEST HERE COMES OUT OF A PRODUCTION DERIVATION. The observation is a genuine
 * `observeScope` answer, the input manifest a genuine `buildInputManifest`, the context
 * manifest a genuine `selectContext` -> `renderContext`, the record digests the production
 * derivers' own. A hand-forged digest would put a value in the fixture that no production
 * code ever produced, and every cross-source arm the builder relies on would then be
 * comparing two hand-written numbers — a tautology, not a test.
 *
 * TWO OF THE FIVE ARE PLANTED THROUGH THE STORE'S OWN WRITE API rather than through their
 * command handlers, and the reason is named rather than glossed: `runStepLifecycleCommand`
 * and the journal append both fence on `readCurrentEffectSessionBinding`, which no fixture
 * may manufacture. The BODIES are still built from the production contracts and their refs
 * from `deriveStepRef`, so what lands is what those writers would have written. The other
 * three go through `commitFoundationCaptureContext`, `commitFoundationContextManifest` and
 * `sealFoundationArtifactRoster` — the real writers, unmodified.
 *
 * `overrides` on each seeder exists so a mutation drill can drift exactly ONE field of an
 * otherwise honest record. Every seeder is spread-last for that reason.
 */

import { join } from "node:path";

import { createDeadEndJournal, renderContext, selectContext } from "@moe/context";
import type { DeadEndJournalEntry } from "@moe/context";
import { buildInputManifest, observeScope } from "@moe/runner";
import type {
  GitObserver, ScopeObservation, ScopePathObserver, WorkspaceInputEntry,
  WorkspaceInputManifest,
} from "@moe/runner";
import type { SqliteEventStore } from "@moe/store";

import {
  JOURNAL_APPEND_COMMAND_KIND, JOURNAL_APPEND_EVENT_TYPE, JOURNAL_RECORD_VERSION,
  deriveAttemptJournalAggregateId,
} from "../journal/journal-contracts.js";
import { PRINCIPAL_ID, PROJECT_ID } from "../recovery/restore-test-harness.js";
import { encodeFoundationPayload } from "./foundation-attempt-codec.js";
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
  STEP_RECORD_VERSION, STEP_STARTED_EVENT_TYPE, deriveAttemptStepAggregateId, deriveStepRef,
} from "./step-lifecycle-contracts.js";

export const HANDOFF_HEAD_COMMIT = "a".repeat(40);
export const HANDOFF_OBSERVED_AT = "2026-08-19T00:00:00Z";
export const HANDOFF_DECIDED_AT = "2026-08-16T00:00:00.000Z";
const OBSERVER_VERSION = "moe-runner-scope-observer/1";
const DECLARED_PATHS = Object.freeze(["src/a.ts", "src/b.ts"]);
const encoder = new TextEncoder();

/** Which attempt is being seeded. Every field is one the SERVER already holds. */
export interface HandoffSeedIdentity {
  readonly activationDigest: string;
  readonly attemptAggregateId: string;
  readonly attemptRef: string;
  readonly effectId: string;
  readonly leaseRef: string;
  readonly nodeKey: string;
  readonly projectId: string;
  readonly sessionId: string;
}

type Patch = Readonly<Record<string, unknown>>;

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
export function seedStepRecord(
  store: SqliteEventStore, identity: HandoffSeedIdentity, overrides: Patch = {},
): string {
  const { activationDigest } = identity;
  const startedSteps = ["plan", "build"].map((label, ordinal) => ({
    label, ordinal, stepRef: deriveStepRef(activationDigest, ordinal),
  }));
  const checkpointRef = startedSteps[1]?.stepRef ?? "";
  const body = {
    activationDigest, attemptRef: identity.attemptRef, checkpointRef,
    completedSteps: [startedSteps[0]?.stepRef ?? ""], effectId: identity.effectId,
    leaseRef: identity.leaseRef, projectId: identity.projectId,
    recordVersion: STEP_RECORD_VERSION, sessionId: identity.sessionId, startedSteps,
    truthClass: "DAEMON_VERIFIED", ...overrides,
  };
  plant(store, deriveAttemptStepAggregateId(activationDigest), body, "step.start",
    STEP_STARTED_EVENT_TYPE, `step-${activationDigest.slice(0, 8)}`);
  return checkpointRef;
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
  store: SqliteEventStore, identity: HandoffSeedIdentity, overrides: Patch = {},
  entries: readonly DeadEndJournalEntry[] = [handoffJournalEntry()],
): void {
  const admitted = createDeadEndJournal(entries);
  if (admitted.kind !== "ADMITTED") throw new Error(`fixture journal refused: ${admitted.limit}`);
  const body = {
    activationDigest: identity.activationDigest, attemptRef: identity.attemptRef,
    effectId: identity.effectId, entries: admitted.journal.entries,
    journalDigest: admitted.journal.digest,
    leaseRef: identity.leaseRef, nodeKey: identity.nodeKey, projectId: identity.projectId,
    recordVersion: JOURNAL_RECORD_VERSION, sessionId: identity.sessionId,
    truthClass: "DAEMON_VERIFIED", ...overrides,
  };
  plant(store, deriveAttemptJournalAggregateId(identity.activationDigest), body,
    JOURNAL_APPEND_COMMAND_KIND, JOURNAL_APPEND_EVENT_TYPE,
    `journal-${identity.activationDigest.slice(0, 8)}`);
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

/** All five, in the order the builder reads them. Returns the shared input-manifest sha
 *  so a drill can drift ONE consumer of it and watch the cross-check refuse. */
export function seedReleaseHandoffSources(
  store: SqliteEventStore, identity: HandoffSeedIdentity,
): string {
  seedStepRecord(store, identity);
  seedJournal(store, identity);
  const inputSha = seedCaptureContext(store, identity);
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
