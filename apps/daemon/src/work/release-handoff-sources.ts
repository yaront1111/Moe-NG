/**
 * The seven durable sources behind the scheduler's nine-key `ReleaseHandoff`, each read
 * through the reader that OWNS it (task-a20e8ef668b54c3abbfce37a505252eb).
 *
 * NOTHING HERE RE-IMPLEMENTS A READ. Every fact arrives from the production reader that
 * already owns its refusal vocabulary, its canonical-form check and its aggregate-scoped
 * horizon guard. A second definition of "what the journal digest is" would be a second
 * thing to keep in step with the first, and the whole point of this builder is that the
 * handoff repeats what the system already committed.
 *
 * CONTEXT RULING. No durable per-attempt record outside the context manifest carries the
 * graph revision/hash/epoch. The triple was verified against the server graph at SEAL time
 * (`foundation-context-prelaunch.ts`), and release reports the context the attempt RAN WITH,
 * not graph currency. The event read therefore supplies only that sealed triple to the strict
 * reader, matching `expansion-release-selector-scan.ts`; this is an explicit non-claim.
 * Node comes from server identity, input digest from the independent capture writer, and
 * configuration digest from the independent provider-run writer. Those three disagreements,
 * plus slot identity, refuse through the strict reader rather than duplicated local fences.
 */

import type { ProviderRunRef } from "@moe/runner";
import type { SqliteEventStore } from "@moe/store";

import type { FoundationAttemptBinding } from "../activation/activation-attempt-reader.js";
import { readCurrentAttemptJournal } from "../journal/journal-reader.js";
import { readCurrentProviderRun } from "../telemetry/provider-run-reader.js";
import { readFoundationArtifactForAttempt } from "./foundation-artifact-ledger.js";
import {
  deriveFoundationCaptureRef, readFoundationCaptureContext,
} from "./foundation-capture-context-ledger.js";
import { deriveFoundationContextAggregateId } from "./foundation-context-manifest-identity.js";
import { readSealedFoundationContext } from "./foundation-context-record.js";
import {
  FOUNDATION_CONTEXT_READER, readFoundationContextManifestEvent,
} from "./foundation-context-manifest-reader.js";
import {
  carrySourceRefusal, isHandoffRefusal, refuseConflict, refuseForeign,
} from "./release-handoff-classify.js";
import { isHandoffDigest, refuseHandoff } from "./release-handoff-contracts.js";
import type {
  ReleaseHandoffFactsResult, ReleaseHandoffIdentity, ReleaseHandoffRefused,
} from "./release-handoff-contracts.js";
import { deriveReleaseTerminalEvidence } from "./release-terminal-evidence.js";
import { readCurrentAttemptStepRecord } from "./step-lifecycle-reader.js";

interface StepFacts {
  readonly completedSteps: readonly string[];
  readonly effectId: string;
  readonly leaseRef: string;
  readonly nextSafeAction: string;
}

/** `completedSteps` and `nextSafeAction`. A null `checkpointRef` is ABSENT, not a
 *  substitute: `ReleaseHandoff.nextSafeAction` is a required ref and no command kind,
 *  literal or empty string may stand in for a step identity this daemon never minted. */
function readStepFacts(
  store: SqliteEventStore, binding: FoundationAttemptBinding, identity: ReleaseHandoffIdentity,
): StepFacts | ReleaseHandoffRefused {
  const record = readCurrentAttemptStepRecord(
    store, binding.activationDigest, identity.projectId);
  if (!record.ok) return carrySourceRefusal("step-record", record.code, record.layer);
  if (record.attemptRef !== binding.attemptId) {
    return refuseForeign("step-record", "STEP_RECORD_NAMES_ANOTHER_ATTEMPT");
  }
  if (record.sessionId !== identity.sessionId) {
    return refuseForeign("step-record", "STEP_RECORD_NAMES_ANOTHER_SESSION");
  }
  if (record.checkpointRef === null) {
    return refuseHandoff("RELEASE_HANDOFF_SOURCE_ABSENT", "step-record",
      { code: "STEP_CHECKPOINT_TARGET_UNKNOWN", layer: record.authority });
  }
  return {
    completedSteps: record.completedSteps, effectId: record.effectId,
    leaseRef: record.leaseRef, nextSafeAction: record.checkpointRef,
  };
}

/** The journal digest, RE-DERIVED by its reader rather than trusted: `readCurrentAttemptJournal`
 *  re-runs `createDeadEndJournal` over the stored entries and demands digest AND order
 *  equality, which is what catches a stored digest that stopped covering its entries. */
function readJournalDigest(
  store: SqliteEventStore, binding: FoundationAttemptBinding, identity: ReleaseHandoffIdentity,
  step: StepFacts,
): string | ReleaseHandoffRefused {
  const journal = readCurrentAttemptJournal(
    store, binding.activationDigest, identity.projectId);
  if (!journal.ok) return carrySourceRefusal("attempt-journal", journal.code, journal.layer);
  if (journal.attemptRef !== binding.attemptId || journal.sessionId !== identity.sessionId
    || journal.nodeKey !== identity.nodeKey) {
    return refuseForeign("attempt-journal", "JOURNAL_NAMES_ANOTHER_ATTEMPT");
  }
  // TWO SOURCES, ONE ATTEMPT. The step record and the journal both name the lease and the
  // effect; a disagreement is not a malformed row, it is two authorities describing the
  // same attempt differently, and it demands a different repair from either being wrong.
  if (journal.effectId !== step.effectId || journal.leaseRef !== step.leaseRef) {
    return refuseConflict("attempt-journal", "JOURNAL_AND_STEP_RECORD_DISAGREE");
  }
  return isHandoffDigest(journal.journalDigest)
    ? journal.journalDigest
    : refuseHandoff("RELEASE_HANDOFF_SOURCE_MALFORMED", "attempt-journal",
      { code: "JOURNAL_DIGEST_MISMATCH", layer: journal.authority });
}

interface CaptureFacts {
  readonly inputDigest: string;
  readonly worktreeDigest: string;
}

interface ProviderRunFacts {
  readonly configurationDigest: string;
  readonly providerRunRef: ProviderRunRef;
}

/** The launch selection for this attempt, from a writer independent of the context seal. */
function readProviderRunFacts(
  store: SqliteEventStore, binding: FoundationAttemptBinding, identity: ReleaseHandoffIdentity,
): ProviderRunFacts | ReleaseHandoffRefused {
  const run = readCurrentProviderRun(store, {
    attemptRef: binding.attemptId, projectId: identity.projectId,
  });
  if (!("ok" in run)) return carrySourceRefusal("provider-run", run.code, run.layer);
  if (!run.ok) return carrySourceRefusal("provider-run", run.code, run.layer);
  if (run.sessionId !== identity.sessionId) {
    return refuseForeign("provider-run", "PROVIDER_RUN_NAMES_ANOTHER_SESSION");
  }
  const { declared } = run.record;
  if (!declared.known) {
    return refuseHandoff("RELEASE_HANDOFF_SOURCE_ABSENT", "provider-run",
      { code: declared.code, layer: declared.layer });
  }
  const { configurationDigest } = declared.selection;
  if (!isHandoffDigest(configurationDigest)) {
    return refuseHandoff("RELEASE_HANDOFF_SOURCE_MALFORMED", "provider-run",
      { code: "PROVIDER_RUN_FIELD_INVALID", layer: "PROVIDER_RUN_READER" });
  }
  return { configurationDigest, providerRunRef: run.record.providerRunRef };
}

/** `inputDigest` and `worktreeDigest` seal DIFFERENT facts and are never aliased
 *  (foundation-artifact-manifest.ts:11): the sealed workspace input manifest and the
 *  observed worktree, read side by side out of one durable capture record. */
function readCaptureFacts(
  store: SqliteEventStore, binding: FoundationAttemptBinding, identity: ReleaseHandoffIdentity,
): CaptureFacts | ReleaseHandoffRefused {
  const captureRef = deriveFoundationCaptureRef({
    attemptAggregateId: binding.activationAggregateId, attemptId: binding.attemptId,
    nodeKey: identity.nodeKey, projectId: identity.projectId, sessionId: identity.sessionId,
  });
  const capture = readFoundationCaptureContext(store, captureRef);
  if (!capture.ok) return carrySourceRefusal("capture-context", capture.code, capture.layer);
  const { record } = capture;
  if (record.attemptId !== binding.attemptId || record.projectId !== identity.projectId
    || record.nodeKey !== identity.nodeKey || record.sessionId !== identity.sessionId
    || record.attemptAggregateId !== binding.activationAggregateId) {
    return refuseForeign("capture-context", "CAPTURE_CONTEXT_NAMES_ANOTHER_ATTEMPT");
  }
  const inputDigest: unknown = record.inputManifest.sha256;
  const worktreeDigest: unknown = record.observation.sha256;
  if (!isHandoffDigest(inputDigest) || !isHandoffDigest(worktreeDigest)) {
    return refuseHandoff("RELEASE_HANDOFF_SOURCE_MALFORMED", "capture-context",
      { code: "FOUNDATION_CAPTURE_CONTEXT_UNSEALED", layer: capture.record.recordVersion });
  }
  return { inputDigest, worktreeDigest };
}

/** `contextDigest`, strict-read against independent server node, capture input and
 *  provider-run configuration facts. Only the sealed graph triple is record-supplied,
 *  under the explicit graph-currency non-claim stated in this module's header. */
function readContextDigest(
  store: SqliteEventStore, binding: FoundationAttemptBinding, identity: ReleaseHandoffIdentity,
  capture: CaptureFacts, configurationDigest: string,
): string | ReleaseHandoffRefused {
  const aggregateId = deriveFoundationContextAggregateId({
    attemptRef: binding.attemptId, projectId: identity.projectId,
    sessionId: identity.sessionId,
  });
  let events;
  try { events = store.readEvents(aggregateId); } catch {
    return refuseHandoff("RELEASE_HANDOFF_SOURCE_UNREADABLE", "context-manifest",
      { code: "FOUNDATION_CONTEXT_READER_UNREADABLE", layer: FOUNDATION_CONTEXT_READER });
  }
  const durable = readFoundationContextManifestEvent(events);
  if (!durable.ok) return carrySourceRefusal("context-manifest", durable.code, durable.layer);
  const { record } = durable;
  const strict = readSealedFoundationContext(store, {
    attemptRef: binding.attemptId, projectId: identity.projectId, sessionId: identity.sessionId,
  }, {
    configurationDigest, graphContentHash: record.graphContentHash, graphEpoch: record.graphEpoch,
    graphRevisionRef: record.graphRevisionRef, inputManifestDigest: capture.inputDigest,
    nodeKey: identity.nodeKey,
  });
  if (!strict.ok) return carrySourceRefusal("context-manifest", strict.code, strict.layer);
  return isHandoffDigest(strict.record.manifest.digest)
    ? strict.record.manifest.digest
    : refuseHandoff("RELEASE_HANDOFF_SOURCE_MALFORMED", "context-manifest",
      { code: "FOUNDATION_CONTEXT_RECORD_DIGEST_MISMATCH", layer: FOUNDATION_CONTEXT_READER });
  }

/** `artifactDigest`, read through the ATTEMPT-bound entry so a roster sealed under
 *  attempt X inside the right project is not evidence about attempt Y. */
function readArtifactDigest(
  store: SqliteEventStore, binding: FoundationAttemptBinding, identity: ReleaseHandoffIdentity,
  capture: CaptureFacts,
): string | ReleaseHandoffRefused {
  const answer = readFoundationArtifactForAttempt(store, {
    attemptAggregateId: binding.activationAggregateId, projectId: identity.projectId,
  }, binding.attemptId);
  if (!answer.ok) return carrySourceRefusal("artifact-manifest", answer.code, answer.layer);
  const { manifest } = answer;
  if (manifest.inputManifestSha256 !== capture.inputDigest) {
    return refuseConflict("artifact-manifest", "ARTIFACT_AND_CAPTURE_INPUT_MANIFESTS_DISAGREE");
  }
  return isHandoffDigest(manifest.artifactDigest)
    ? manifest.artifactDigest
    : refuseHandoff("RELEASE_HANDOFF_SOURCE_MALFORMED", "artifact-manifest",
      { code: "FOUNDATION_ARTIFACT_MANIFEST_UNSEALABLE", layer: answer.manifest.manifestVersion });
}

/**
 * `activeProcessResourceFacts`, WITH ITS DENOMINATOR. The scheduler types the field as a
 * string list, so the enumerated count rides as its own leading member: an empty roster
 * with no denominator behind it is an unfalsifiable claim, and this is what keeps "the
 * attempt held nothing" distinguishable from "nobody measured".
 *
 * A set that is not proven terminal produces NO handoff. The release aggregate cannot
 * upgrade DRAINING to RELEASED, so a handoff composed over a still-movable set would
 * authorise a row nobody could correct.
 */
function readResourceFacts(
  store: SqliteEventStore, binding: FoundationAttemptBinding, identity: ReleaseHandoffIdentity,
): readonly string[] | ReleaseHandoffRefused {
  const evidence = deriveReleaseTerminalEvidence(
    store, { attemptRef: binding.attemptId, projectId: identity.projectId });
  if (!evidence.ok) return carrySourceRefusal("terminal-evidence", evidence.code, evidence.layer);
  if (evidence.attemptRef !== binding.attemptId || evidence.projectId !== identity.projectId) {
    return refuseForeign("terminal-evidence", "TERMINAL_EVIDENCE_NAMES_ANOTHER_ATTEMPT");
  }
  if (!evidence.resourcesTerminal) {
    return refuseHandoff("RELEASE_HANDOFF_SOURCE_STALE", "terminal-evidence",
      { code: "RELEASE_TERMINAL_RESOURCES_MOVABLE", layer: "RELEASE_TERMINAL_EVIDENCE" });
  }
  const enumerated = evidence.enumeratedResources;
  if (enumerated !== evidence.terminalResourceRefs.length) {
    return refuseConflict("terminal-evidence", "TERMINAL_RESOURCE_DENOMINATOR_DISAGREES");
  }
  return Object.freeze([
    `resources.enumerated:${String(enumerated)}`,
    ...[...evidence.terminalResourceRefs].sort().map((ref) => `resources.terminal:${ref}`),
  ]);
}

/** Every source, in a FIXED order so attribution is stable, and the first refusal wins. */
export function readReleaseHandoffFacts(
  store: SqliteEventStore, binding: FoundationAttemptBinding, identity: ReleaseHandoffIdentity,
  onProviderRun?: (ref: ProviderRunRef) => ReleaseHandoffRefused | null,
): ReleaseHandoffFactsResult {
  const step = readStepFacts(store, binding, identity);
  if (isHandoffRefusal(step)) return step;
  const journalDigest = readJournalDigest(store, binding, identity, step);
  if (typeof journalDigest !== "string") return journalDigest;
  const capture = readCaptureFacts(store, binding, identity);
  if (isHandoffRefusal(capture)) return capture;
  const providerRun = readProviderRunFacts(store, binding, identity);
  if (isHandoffRefusal(providerRun)) return providerRun;
  const providerHorizon = onProviderRun?.(providerRun.providerRunRef) ?? null;
  if (providerHorizon !== null) return providerHorizon;
  const contextDigest = readContextDigest(
    store, binding, identity, capture, providerRun.configurationDigest);
  if (typeof contextDigest !== "string") return contextDigest;
  const artifactDigest = readArtifactDigest(store, binding, identity, capture);
  if (typeof artifactDigest !== "string") return artifactDigest;
  const resourceFacts = readResourceFacts(store, binding, identity);
  if (!Array.isArray(resourceFacts)) return resourceFacts as ReleaseHandoffRefused;
  return {
    artifactDigest, completedSteps: step.completedSteps, contextDigest,
    inputDigest: capture.inputDigest, journalDigest, nextSafeAction: step.nextSafeAction,
    resourceFacts, worktreeDigest: capture.worktreeDigest,
  };
}
