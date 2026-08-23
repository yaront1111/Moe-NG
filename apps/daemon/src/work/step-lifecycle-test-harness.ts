import type { SqliteEventStore } from "@moe/store";

import { PRINCIPAL_ID, PROJECT_ID } from "../recovery/restore-test-harness.js";
import type { ActivationFixture } from "../journal/journal-test-harness.js";
import { encodeFoundationPayload } from "./foundation-attempt-codec.js";
import {
  STEP_LIFECYCLE_SCHEMA_VERSION, STEP_RECORD_VERSION, STEP_STARTED_EVENT_TYPE,
  deriveAttemptStepAggregateId, deriveStepRef,
} from "./step-lifecycle-contracts.js";
import type { StartedStep } from "./step-lifecycle-contracts.js";

/**
 * The step-lifecycle suites' fixture. The ATTEMPT half is reused verbatim from
 * `../journal/journal-test-harness.js` rather than re-forged here: it commits a REAL
 * activation through `runEffectActivateCommand`, a REAL dispatch reservation through
 * `commitFoundationPhase`, and stands the REAL HTTP seam over the REAL session
 * authenticator on a file-backed SqliteEventStore. Nothing in it is journal-specific
 * — `parseActivationGrant` demands a grantId derived from the whole successor intent,
 * so hand-forging a second coherent activation would only duplicate that work with a
 * worse fixture.
 *
 * What IS local here is the durable STEP body and the planting writer, so the reader
 * can be driven by evidence rather than by a stub.
 */

export {
  DECIDED_AT, OPERATOR_CREDENTIAL, SESSION_ID, activate,
  openJournalHarness as openStepHarness,
} from "../journal/journal-test-harness.js";
export type { ActivationFixture } from "../journal/journal-test-harness.js";

const PLANT_DECIDED_AT = "2026-08-15T00:00:00.000Z";
const encoder = new TextEncoder();

/**
 * Request bytes shaped EXACTLY as `createDaemonCommandPorts`' `requestOf` shapes
 * them (apps/daemon/src/daemon-command-registry.ts:111-127): the same nine envelope
 * keys, with `projectId`, `principalId` and `decidedAt` as SERVER stamps rather than
 * payload fields. `principalId` is the attempt's session id because that is what the
 * authenticated principal IS for an agent session, and it is the value
 * `readCurrentEffectSessionBinding` compares against `lease.ownerSessionRef`.
 */
export function requestBytes(
  kind: string, harness: { readonly attempt: ActivationFixture }, commandId: string,
  payload: Readonly<Record<string, unknown>>,
): Uint8Array {
  return encoder.encode(JSON.stringify({
    commandId, correlationId: `corr-${commandId}`, decidedAt: PLANT_DECIDED_AT,
    expectedVersion: 0, kind, payload, principalId: harness.attempt.sessionId,
    projectId: PROJECT_ID, schemaVersion: STEP_LIFECYCLE_SCHEMA_VERSION,
  }));
}

/** The SERVER's own roster shape: ordinal is the index, and every ref is re-derived
 *  through the production `deriveStepRef` so no fixture literal can stand in for it. */
export function startedRoster(
  activationDigest: string, labels: readonly string[],
): readonly StartedStep[] {
  return labels.map((label, ordinal) => ({
    label, ordinal, stepRef: deriveStepRef(activationDigest, ordinal),
  }));
}

/**
 * A well-formed durable body. Every planted case drifts exactly ONE field of this
 * value and a positive control asserts the undrifted body reads OK — without that
 * control a "refused" assertion could be caused by the fixture being invalid at an
 * earlier layer rather than by the field under test.
 */
export function stepBody(
  attempt: ActivationFixture, labels: readonly string[],
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const { activationDigest } = attempt.record;
  return {
    activationDigest,
    attemptRef: attempt.record.attempt.attemptId,
    checkpointRef: null,
    completedSteps: [],
    effectId: attempt.record.effectIntent.intentId,
    leaseRef: attempt.record.lease.leaseId,
    projectId: PROJECT_ID,
    recordVersion: STEP_RECORD_VERSION,
    sessionId: attempt.sessionId,
    startedSteps: startedRoster(activationDigest, labels),
    truthClass: "DAEMON_VERIFIED",
    ...overrides,
  };
}

/** Writes a row this suite did not compose through the writer, so the reader's guards
 *  are reached by durable evidence rather than by a stub. */
export function plantStepEvent(
  store: SqliteEventStore, activationDigest: string, body: unknown, expectedVersion: number,
  eventType: string = STEP_STARTED_EVENT_TYPE,
): void {
  const encoded = encodeFoundationPayload(body);
  if (!encoded.ok) throw new Error(`planted body refused by the codec: ${encoded.code}`);
  const slug = `${activationDigest.slice(0, 8)}-${expectedVersion}`;
  const committed = store.commitExpectedVersionDecision({
    commandKind: "step.start", committedResultBytes: encoded.bytes,
    correlationId: `corr-plant-step-${slug}`, decidedAt: PLANT_DECIDED_AT,
    events: [{ eventId: `planted-step-${slug}`, eventType, payload: encoded.bytes }],
    expectedVersion,
    key: {
      commandId: `cmd-plant-step-${slug}`, principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    },
    requestBytes: encoded.bytes,
    targetAggregateId: deriveAttemptStepAggregateId(activationDigest),
  });
  if (committed.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    throw new Error(`planting refused: ${committed.decision.effectDisposition}`);
  }
}

/** Raw durable rows on the step aggregate, read OUT of the store: "it did not throw
 *  the second time" is also exactly what a double write looks like. */
export function stepEventCount(store: SqliteEventStore, activationDigest: string): number {
  return store.readEvents(deriveAttemptStepAggregateId(activationDigest)).length;
}
