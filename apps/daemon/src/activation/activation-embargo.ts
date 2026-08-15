import { RUNTIME_LIFECYCLES } from "@moe/contracts";
import { DurableStoreError } from "@moe/store";
import type { SqliteEventStore } from "@moe/store";

import { readDurableLedger, stateOf } from "../bootstrap/bootstrap-ledger.js";
import { RECOVERY_INVENTORY_LAYER } from "../recovery/recovery-inventory-contract.js";
import { readInstalledRestore } from "../recovery/restore-controller.js";

/**
 * The persisted recovery embargo: may this daemon allocate NEW execution
 * authority for a project yet?
 *
 * Read, never asked. Both facts come off the durable store — the selected
 * restore binding and the project's own recovery lifecycle — because a caller
 * that could declare "recovery is done" would be declaring away the fence built
 * to survive its crash.
 *
 * AN INSTALLED RESTORE BINDING IS NOT RECONCILIATION COMPLETE. Installing one is
 * how a restore STARTS; the project is quiesced in the same transaction. What
 * clears the embargo is the project's own lifecycle leaving QUIESCED, so a
 * reader that stopped at "a binding is ACTIVE" would open the gate at exactly
 * the moment it must stay shut.
 *
 * Every refusal shares ONE code and ONE layer and is separated by `cause`, so a
 * caller can fail closed on the code while a test can still pin which branch
 * answered. An upstream refusal is carried verbatim in `upstream` rather than
 * flattened: the restore controller's own layer and code are evidence, and
 * folding them into this module's vocabulary would destroy the only trace of
 * which boundary actually refused.
 */

export const ACTIVATION_EMBARGO_CODE = "RECOVERY_RECONCILIATION_REQUIRED" as const;

/**
 * Closed. Nothing outside this module may add a cause, so a refusal cannot be
 * invented at a call site. Deliberately NOT added to
 * `RECOVERY_INVENTORY_UPSTREAM_CODES`: that array is a closed enum swept by the
 * inventory suites, and inventory vocabulary is outside this module's scope —
 * only the LAYER constant is shared.
 */
export const ACTIVATION_EMBARGO_CAUSES = Object.freeze([
  "PROJECT_RECOVERY_REQUIRED",
  "PROJECT_STATE_ABSENT",
  "PROJECT_STATE_MISMATCHED",
  "PROJECT_STATE_UNREADABLE",
  "RESTORE_UNREADABLE",
] as const);

export type ActivationEmbargoCause = (typeof ACTIVATION_EMBARGO_CAUSES)[number];

export interface ActivationEmbargoUpstream {
  readonly code: string;
  readonly layer: string;
}

export interface ActivationEmbargoClear {
  readonly ok: true;
}

export interface ActivationEmbargoHeld {
  readonly cause: ActivationEmbargoCause;
  readonly code: typeof ACTIVATION_EMBARGO_CODE;
  readonly layer: typeof RECOVERY_INVENTORY_LAYER;
  readonly ok: false;
  /** The boundary that actually refused, verbatim; `null` when this one did. */
  readonly upstream: ActivationEmbargoUpstream | null;
}

export type ActivationEmbargo = ActivationEmbargoClear | ActivationEmbargoHeld;

const PROJECT_LIFECYCLES: readonly string[] = RUNTIME_LIFECYCLES.PROJECT;
const QUIESCED = "QUIESCED";

function held(
  cause: ActivationEmbargoCause,
  upstream: ActivationEmbargoUpstream | null = null,
): ActivationEmbargoHeld {
  return Object.freeze({
    cause,
    code: ACTIVATION_EMBARGO_CODE,
    layer: RECOVERY_INVENTORY_LAYER,
    ok: false as const,
    upstream: upstream === null ? null : Object.freeze({ ...upstream }),
  });
}

/**
 * A store that cannot be read is never clear. `DurableStoreError` carries its
 * own code; anything else is an unclassified failure of the same read, and
 * reporting it as "no embargo" would let a broken handle authorise execution.
 */
function unreadableStore(error: unknown): ActivationEmbargoHeld {
  return held("RESTORE_UNREADABLE", {
    code: error instanceof DurableStoreError ? error.code : "STORE_UNAVAILABLE",
    layer: "DURABLE_STORE",
  });
}

/**
 * ABSENT, GENESIS_FENCED and INSTALLED all fall through to the project check.
 * None of the three is by itself proof that reconciliation finished, and none is
 * by itself proof that it did not.
 */
function checkRestore(store: SqliteEventStore, projectId: string): ActivationEmbargoHeld | null {
  let inspection: ReturnType<typeof readInstalledRestore>;
  try {
    inspection = readInstalledRestore(store, projectId);
  } catch (error) {
    return unreadableStore(error);
  }
  if (inspection.ok) return null;
  return held("RESTORE_UNREADABLE", { code: inspection.code, layer: inspection.layer });
}

interface ProjectRecoveryState {
  readonly lifecycle: string;
  readonly projectId: string;
  readonly recoveryRequired: boolean;
}

function readProjectState(value: unknown): ProjectRecoveryState | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const lifecycle = record["lifecycle"];
  const projectId = record["projectId"];
  const recoveryRequired = record["recoveryRequired"];
  if (
    typeof lifecycle !== "string" || !PROJECT_LIFECYCLES.includes(lifecycle)
    || typeof projectId !== "string" || typeof recoveryRequired !== "boolean"
  ) {
    return null;
  }
  return { lifecycle, projectId, recoveryRequired };
}

function checkProject(store: SqliteEventStore, projectId: string): ActivationEmbargo {
  let durable: unknown;
  try {
    durable = stateOf(readDurableLedger(store, projectId), projectId);
  } catch (error) {
    return unreadableStore(error);
  }
  if (durable === undefined || durable === null) return held("PROJECT_STATE_ABSENT");
  const state = readProjectState(durable);
  if (state === null) return held("PROJECT_STATE_UNREADABLE");
  // `project-validation.ts` pins `recoveryRequired === (lifecycle === QUIESCED)`
  // as a project invariant. State that breaks it describes no project this
  // daemon can reason about, so it is neither clear nor merely "in recovery".
  if (state.projectId !== projectId) return held("PROJECT_STATE_MISMATCHED");
  if (state.recoveryRequired !== (state.lifecycle === QUIESCED)) {
    return held("PROJECT_STATE_MISMATCHED");
  }
  if (state.lifecycle === QUIESCED || state.recoveryRequired) {
    return held("PROJECT_RECOVERY_REQUIRED");
  }
  return Object.freeze({ ok: true as const });
}

/** The single entry point. Reads only durable state; takes no caller assertion. */
export function readActivationEmbargo(
  store: SqliteEventStore,
  projectId: string,
): ActivationEmbargo {
  const restore = checkRestore(store, projectId);
  if (restore !== null) return restore;
  return checkProject(store, projectId);
}
