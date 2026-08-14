import type { SqliteEventStore } from "@moe/store";

import { readAnchoredIncarnation } from "./recovery-incarnation-anchor.js";
import {
  controllerRefusal,
  preparedRestoreIdentity,
  snapshotRestoreRequest,
} from "./restore-controller-contract.js";
import type {
  RestoreControllerRequest,
  RestoreDiscardResult,
  RestoreInspection,
  RestoreResult,
} from "./restore-controller-contract.js";
import {
  readInstalledRestore,
  runRestoreQuiesce,
  runSnapshottedRestoreQuiesce,
  verifyRestoreGeneration,
} from "./restore-controller.js";

/**
 * The operator-facing trio over the restore composition.
 *
 * Named with a `Restore` suffix on purpose. `resume` already means "resume an
 * in-flight ATTEMPT's work" in `continuation-service.ts`, and `discard` already
 * means "destroy key material" inside `recovery-incarnation.ts` and
 * `recovery-key-provider.ts`. Two meanings sharing one name in one directory is
 * a trap for every later reader, so these three never shorten to those.
 *
 * None of them decides anything: `resumeRestore` re-drives the composition,
 * `inspectRestore` reads, `discardRestore` refuses the one case that is
 * dangerous. Preparing a restore has no durable footprint of its own — the
 * install is the first and only write — so discarding an unsettled one removes
 * nothing, and inventing durable prepare state here would be the two-slot
 * installer protocol that belongs to the anchor installer.
 */

export interface RestorePort {
  discard(request: unknown): RestoreDiscardResult;
  inspect(): RestoreInspection;
  resume(request: unknown): RestoreResult;
}

/**
 * Idempotent re-drive. The prepared identity is DERIVED from the command, so
 * resuming the same prepared restore reuses it and settles on the outcome
 * already installed rather than committing a second time.
 */
export function resumeRestore(store: SqliteEventStore, request: unknown): RestoreResult {
  return runRestoreQuiesce(store, request);
}

/** Read-only, and read-only on every path: nothing here writes or advances. */
export function inspectRestore(store: SqliteEventStore, projectId: string): RestoreInspection {
  return readInstalledRestore(store, projectId);
}

/**
 * Abandons a restore that never installed. A SETTLED restore is refused: the
 * binding is the live fence a recovered store is running under, and discarding
 * it would leave the project quiesced with nothing naming the incarnation that
 * quiesced it.
 */
export function discardRestore(store: SqliteEventStore, request: unknown): RestoreDiscardResult {
  const snapshot = snapshotRestoreRequest(request);
  if (snapshot === null) return controllerRefusal("RESTORE_REQUEST_SHAPE_INVALID");
  return discardSnapshottedRestore(store, snapshot);
}

function discardSnapshottedRestore(
  store: SqliteEventStore,
  snapshot: RestoreControllerRequest,
): RestoreDiscardResult {
  const installed = readInstalledRestore(store, snapshot.projectId);
  if (!installed.ok) return installed;
  // GENESIS_FENCED deliberately falls through with ABSENT: a genesis fence is
  // not a settled restore, so discarding an unsettled restore stays allowed.
  if (installed.outcome === "INSTALLED") return controllerRefusal("RESTORE_ALREADY_SETTLED");
  const verified = verifyRestoreGeneration(snapshot);
  if (!verified.ok) return verified;
  const anchored = readAnchoredIncarnation(store, snapshot.projectId, snapshot.incarnationRef);
  if (anchored === null) return controllerRefusal("RESTORE_INCARNATION_UNANCHORED");
  if (anchored.backupGenerationDigest !== verified.manifest.generationDigest) {
    return controllerRefusal("RESTORE_GENERATION_NOT_BOUND");
  }
  if (anchored.restoreCommandId !== snapshot.restoreCommandId) {
    return controllerRefusal("RESTORE_COMMAND_NOT_BOUND");
  }
  if (anchored.keyEpochRef !== snapshot.keyEpochRef) {
    return controllerRefusal("RESTORE_KEY_EPOCH_MISMATCH");
  }
  return Object.freeze({
    ok: true as const,
    outcome: "DISCARDED" as const,
    preparedIdentity: preparedRestoreIdentity({
      generationDigest: verified.manifest.generationDigest,
      incarnationRef: snapshot.incarnationRef,
      keyEpochRef: snapshot.keyEpochRef,
      restoreCommandId: snapshot.restoreCommandId,
    }),
  });
}

/**
 * Binds one store and one project. A request naming a different project is
 * refused at the shape layer rather than silently re-scoped.
 */
export function createRestorePort(store: SqliteEventStore, projectId: string): RestorePort {
  const scoped = (request: unknown): RestoreControllerRequest | null => {
    const snapshot = snapshotRestoreRequest(request);
    return snapshot === null || snapshot.projectId !== projectId ? null : snapshot;
  };
  return Object.freeze({
    discard: (request: unknown): RestoreDiscardResult => {
      const inScope = scoped(request);
      return inScope === null
        ? controllerRefusal("RESTORE_REQUEST_SHAPE_INVALID")
        : discardSnapshottedRestore(store, inScope);
    },
    inspect: (): RestoreInspection => inspectRestore(store, projectId),
    resume: (request: unknown): RestoreResult => {
      const inScope = scoped(request);
      return inScope === null
        ? controllerRefusal("RESTORE_REQUEST_SHAPE_INVALID")
        : runSnapshottedRestoreQuiesce(store, inScope);
    },
  });
}
