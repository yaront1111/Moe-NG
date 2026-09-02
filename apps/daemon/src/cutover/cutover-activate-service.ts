/**
 * The `cutover.activate` handler (design section 21.12-13, design :1284-1287): it consumes an
 * already-admitted GO_ACTIVATE binding and, in ONE store decision, moves the CutoverAttempt
 * ACTIVATE_APPROVED -> ACTIVE while writing the v2 activation marker. Only then may the first
 * v2 authoritative command run, so the transition and the marker cannot survive one another.
 *
 * THIS MODULE OWNS AUTHORITY AND DURABILITY, AND NOTHING ELSE. It composes, never reimplements:
 *   - `admitActivationBinding` (@moe/benchmark) is the SOLE admission. Its refusals - and the
 *     human-gate refusals core returns THROUGH it - pass through with their own code and layer.
 *     There is no second `decideApprovalAuthority` call here: the admission verdict IS the
 *     receipt, and a second consult could only disagree with the one that already answered.
 *   - `readCutoverAttemptState` is the only fold. Its ABSENT and UNREADABLE verdicts are
 *     forwarded verbatim rather than restamped.
 *   - `reduceCutover` owns the edge table. This module never re-encodes which states admit
 *     `cutover.activate`; a non-ACTIVATE_APPROVED attempt is refused BY THE REDUCER, at layer
 *     CUTOVER. `composeCutoverActivationMarker` guards the same edge for its own callers, but
 *     runs after the reducer here, so the reducer is the layer that answers.
 *   - `readCutoverGenerationSnapshot` is the only source of live generations, and it takes a
 *     project id and no digest, so no caller can present the value it will be compared against.
 *   - `readCutoverActivationMarker` (cutover-v2-authority.ts) is the marker reader, and the same
 *     module carries the gate every v2 authoritative command must pass once this row's marker
 *     exists. Reading and writing the marker stay in separate modules so the writer cannot be
 *     mistaken for the authority.
 *
 * WHY THE PUBLIC STORE SEAM RATHER THAN `commitAcceptedLegs`. That wrapper narrows `kind` to
 * `BOOTSTRAP_COMMAND_KINDS` - an eleven-kind roster measured at HEAD 55dc0a43 that does not
 * contain `cutover.activate` - so reaching it would need a cast, exactly as
 * expansion-request-commit.ts:9-13 measured for `graph.request_expansion`. It wraps
 * `commitExpectedVersionDecisionLegs`, which is used directly here with `legs[0]` as the
 * primary attempt leg, the same discipline approval-activation.ts:200 states.
 *
 * NOTHING HERE IS REGISTERED. Wiring `cutover.activate` into the command tables is
 * task-b8272ee020a940009a11c6eb6355d578; an unregistered handler module is inert, while a
 * registered kind with no handler is a decode path that accepts a command nothing serves.
 */
import { admitActivationBinding } from "@moe/benchmark";
import { reduceCutover } from "@moe/core";
import type { CutoverAttemptState } from "@moe/core";
import type { CommandDecisionKey, CommandDecisionRecord, CommandDecisionResponse } from "@moe/store";

import {
  CUTOVER_ACTIVATION_MARKER_EVENT_TYPE,
  composeCutoverActivationMarker,
  deriveCutoverActivationMarkerAggregateId,
  encodeCutoverActivationMarker,
} from "./cutover-activation-marker.js";
import type { CutoverActivationMarker } from "./cutover-activation-marker.js";
import {
  cutoverMarkerBindsReadiness,
  readCutoverActivationMarker,
} from "./cutover-v2-authority.js";
import {
  CUTOVER_ACTIVATE_COMMAND_KIND,
  bindingMatches,
  deriveCutoverActivateCommandId,
  driftedFact,
  forwarded,
  readinessDriftedFact,
  refuse,
  replayMatches,
  storeRefusal,
} from "./cutover-activate-contracts.js";
import type {
  ActivateCutoverInput,
  CutoverActivateResult,
  CutoverActivateStore,
} from "./cutover-activate-contracts.js";
import {
  CUTOVER_ATTEMPT_EVENT_TYPE,
  deriveCutoverAttemptAggregateId,
  deriveCutoverDecisionId,
  encodeCutoverAttemptEvent,
} from "./cutover-attempt-contracts.js";
import { readCutoverAttemptState } from "./cutover-attempt-reader.js";
import type { CutoverAttemptPresent } from "./cutover-attempt-reader.js";
import { readCutoverGenerationSnapshot } from "./cutover-generation-snapshot.js";
import type { CutoverGenerationPorts } from "./cutover-generation-snapshot.js";
import {
  deriveV2ReadinessManifestAggregateId,
  readV2ReadinessManifest,
} from "./v2-readiness-manifest.js";
import type { V2ReadinessManifestPresent } from "./v2-readiness-manifest.js";

interface PreparedActivation {
  readonly aggregateId: string;
  readonly commandId: string;
  readonly expectedVersion: number;
  readonly key: CommandDecisionKey;
  readonly marker: CutoverActivationMarker;
  readonly nextState: CutoverAttemptState;
  readonly projectId: string;
  readonly readiness: V2ReadinessManifestPresent;
}

/**
 * ONE decision, three legs: ACTIVE + marker are writes, while the already-read readiness
 * aggregate is an empty-event fence. `legs[0]` stays the attempt, and readiness drift aborts
 * both writes inside the same SQLite transaction.
 */
function commitActivation(
  store: CutoverActivateStore,
  input: ActivateCutoverInput,
  prepared: PreparedActivation,
): CutoverActivateResult {
  const attemptBytes = encodeCutoverAttemptEvent({
    admitted: null,
    command: {
      commandId: prepared.commandId,
      expectedVersion: prepared.expectedVersion,
      kind: CUTOVER_ACTIVATE_COMMAND_KIND,
    },
  });
  const markerBytes = encodeCutoverActivationMarker(prepared.marker);
  let response: CommandDecisionResponse;
  try {
    response = store.commitExpectedVersionDecisionLegs({
      commandKind: CUTOVER_ACTIVATE_COMMAND_KIND,
      committedResultBytes: markerBytes,
      correlationId: input.correlationId,
      decidedAt: input.decidedAt,
      key: prepared.key,
      legs: [
        {
          aggregateId: prepared.aggregateId,
          events: [{
            eventId: prepared.commandId,
            eventType: CUTOVER_ATTEMPT_EVENT_TYPE,
            payload: attemptBytes,
          }],
          expectedVersion: prepared.expectedVersion,
        },
        {
          aggregateId: deriveCutoverActivationMarkerAggregateId(prepared.projectId),
          events: [{
            eventId: `${prepared.commandId}-marker`,
            eventType: CUTOVER_ACTIVATION_MARKER_EVENT_TYPE,
            payload: markerBytes,
          }],
          expectedVersion: 0,
        },
        {
          aggregateId: deriveV2ReadinessManifestAggregateId(prepared.projectId),
          events: [],
          expectedVersion: prepared.readiness.version,
        },
      ],
      requestBytes: attemptBytes,
    });
  } catch (error) {
    return storeRefusal(error);
  }
  if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    return refuse("CUTOVER_ACTIVATE_EXPECTED_VERSION_CONFLICT", null, response.decision.resultCode);
  }
  return Object.freeze({
    aggregateId: prepared.aggregateId,
    commandId: prepared.commandId,
    disposition: response.disposition === "REPLAYED" ? "REPLAYED" as const : "COMMITTED" as const,
    marker: prepared.marker,
    ok: true as const,
    state: prepared.nextState,
  });
}

/**
 * The idempotent replay answer, taken BEFORE the reducer: ACTIVE is terminal, so a genuine
 * second submission of the same activation would otherwise be refused ILLEGAL_TRANSITION and
 * could never be recognised as the replay it is. It reads and writes nothing.
 */
function answerReplay(
  store: CutoverActivateStore,
  fold: CutoverAttemptPresent,
  prepared: Readonly<{ aggregateId: string; commandId: string; key: CommandDecisionKey; projectId: string }>,
): CutoverActivateResult {
  if (fold.state.lifecycle !== "ACTIVE") return refuse("CUTOVER_ACTIVATE_REPLAY_DIVERGED");
  const marker = readCutoverActivationMarker(store, { projectId: prepared.projectId });
  if (marker === null) return refuse("CUTOVER_ACTIVATE_REPLAY_DIVERGED");
  const readiness = readV2ReadinessManifest(store, { projectId: prepared.projectId });
  if (!readiness.ok || !cutoverMarkerBindsReadiness(marker, readiness)) {
    return refuse("CUTOVER_ACTIVATE_REPLAY_DIVERGED");
  }
  return Object.freeze({
    aggregateId: prepared.aggregateId,
    commandId: prepared.commandId,
    disposition: "REPLAYED" as const,
    marker,
    ok: true as const,
    state: fold.state,
  });
}

/** Consumes an admitted GO_ACTIVATE binding and makes v2 authoritative, or refuses closed. */
export function activateCutover(
  store: CutoverActivateStore,
  ports: CutoverGenerationPorts,
  input: ActivateCutoverInput,
): CutoverActivateResult {
  const admission = admitActivationBinding(input.record);
  if (!admission.ok) return admission;
  const fold = readCutoverAttemptState(store, { projectId: input.projectId });
  if (fold.status !== "PRESENT") return forwarded(fold);
  if (fold.state.version !== fold.version) return refuse("CUTOVER_ACTIVATE_VERSION_DESYNC");

  const decisionId = deriveCutoverDecisionId(admission.binding);
  const commandId = deriveCutoverActivateCommandId(decisionId);
  const grant = admission.binding.authority.grant;
  if (grant === null) return refuse("CUTOVER_ACTIVATE_FIELD_INVALID");
  const aggregateId = deriveCutoverAttemptAggregateId(input.projectId);
  const key = { commandId, principalId: grant.principalId, projectId: input.projectId };
  let prior: CommandDecisionRecord | null;
  try {
    prior = store.getCommandDecision(key);
  } catch (error) {
    return storeRefusal(error);
  }
  if (prior !== null) {
    if (!replayMatches(prior, key, aggregateId)) return refuse("CUTOVER_ACTIVATE_REPLAY_DIVERGED");
    return answerReplay(store, fold, { aggregateId, commandId, key, projectId: input.projectId });
  }

  // THE REDUCER ANSWERS FIRST on lifecycle. An attempt that never reached ACTIVATE_APPROVED has
  // no admitted binding to compare against, so checking the binding first would diagnose a
  // BINDING_DRIFT for a state whose real defect is that no activation was ever approved.
  const reduced = reduceCutover(fold.state, {
    commandId, expectedVersion: fold.version, kind: CUTOVER_ACTIVATE_COMMAND_KIND,
  });
  if (!reduced.ok) return reduced;
  if (fold.state.activateApprovalRef !== decisionId || !bindingMatches(fold.admitted, admission.binding)) {
    return refuse("CUTOVER_ACTIVATE_BINDING_DRIFT");
  }

  const snapshot = readCutoverGenerationSnapshot(ports, { projectId: input.projectId });
  if (!snapshot.ok) return snapshot;
  const drifted = driftedFact(admission.binding, snapshot.generations);
  if (drifted !== null) return refuse("CUTOVER_ACTIVATE_GENERATION_DRIFT", drifted);

  // Read ONCE before composition, then carry this exact version into commitActivation's empty
  // leg. No request field can name or replace the readiness aggregate or any evidence pin.
  const readiness = readV2ReadinessManifest(store, { projectId: input.projectId });
  if (!readiness.ok) return readiness;
  const readinessDrift = readinessDriftedFact(admission.binding, readiness.manifest);
  if (readinessDrift !== null) {
    return refuse("CUTOVER_ACTIVATE_READINESS_DRIFT", readinessDrift);
  }

  const composed = composeCutoverActivationMarker({
    activatedAtEpochMs: input.activatedAtEpochMs,
    generations: admission.binding.generations,
    readinessManifestSha256: readiness.digest,
    readinessManifestVersion: readiness.version,
    sourceCommit: admission.binding.sourceCommit,
    sourceState: fold.state.lifecycle,
  });
  if (!composed.ok) return composed;
  return commitActivation(store, input, {
    aggregateId, commandId, expectedVersion: fold.version, key, marker: composed.marker,
    nextState: reduced.state, projectId: input.projectId, readiness,
  });
}
