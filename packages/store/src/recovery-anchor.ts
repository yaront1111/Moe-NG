/**
 * The crash-safe two-slot recovery anchor installer.
 *
 * The whole guarantee rests on one discipline: NOTHING in the current slot is
 * touched before the atomic switch. Every restored byte lands in the inactive
 * slot, is stamped, persisted and read back there, and only then does one
 * atomic anchor rewrite move the pointer. A failure anywhere earlier leaves the
 * prior slot intact BY CONSTRUCTION rather than by cleanup — which is what lets
 * the failure-injection matrix pass without a single compensating action.
 *
 * taskRail 2: this module records selection metadata. It never enacts
 * revocation or lifecycle, never imports the reducer package, and never reaches
 * toward the daemon application. Composing the reducer with this surface
 * belongs to task-2ff368fe.
 */
import {
  RECOVERY_ANCHOR_ALLOWED_OPERATIONS,
  RECOVERY_ANCHOR_COMMAND_MISMATCH,
  RECOVERY_ANCHOR_INCARNATION_REUSED,
  RECOVERY_ANCHOR_RECOVERY_REQUIRED,
  RECOVERY_ANCHOR_REQUEST_INVALID,
} from "./recovery-anchor-contracts.js";
import type {
  RecoveryAnchorDiscardResult,
  RecoveryAnchorInspectResult,
  RecoveryAnchorInstallResult,
  RecoveryAnchorPrepareResult,
  RecoveryAnchorRecord,
  RecoveryAnchorRefused,
  RecoveryBindingSlotName,
} from "./recovery-anchor-contracts.js";
import { publishFileAtomically, removeDirectory } from "./recovery-anchor-fs.js";
import {
  anchorPath,
  readStoredAnchor,
  runInstall,
  slotDirectory,
  verifySlot,
} from "./recovery-anchor-install.js";
import { markInstalled } from "./recovery-anchor-marker.js";
import {
  buildAnchorRecord,
  computePreparedIdentity,
  encodeAnchorRecord,
  readAnchorRequest,
} from "./recovery-anchor-record.js";
import type { RecoveryAnchorRequest } from "./recovery-anchor-record.js";
import { RECOVERY_BINDING_SLOTS } from "./recovery-install-contracts.js";

/** The two slots alternate, so the inactive one is simply the other one. */
export function selectInactiveSlot(slot: RecoveryBindingSlotName): RecoveryBindingSlotName {
  return slot === RECOVERY_BINDING_SLOTS[0] ? RECOVERY_BINDING_SLOTS[1] : RECOVERY_BINDING_SLOTS[0];
}

/**
 * DoD 5's fence. A NEW restore command may not present an incarnation or key
 * epoch that an earlier command already consumed, or a replayed restore could
 * spend a fence the first attempt had already used.
 */
function detectFenceReuse(
  stored: RecoveryAnchorRecord | null,
  request: RecoveryAnchorRequest,
): RecoveryAnchorRefused | null {
  if (stored === null || stored.restoreCommandId === request.restoreCommandId) return null;
  const reused =
    stored.incarnationRef === request.incarnationRef || stored.keyEpochRef === request.keyEpochRef;
  return reused ? RECOVERY_ANCHOR_INCARNATION_REUSED : null;
}

export async function prepareRecoveryAnchor(input: unknown): Promise<RecoveryAnchorPrepareResult> {
  const request = readAnchorRequest(input);
  if ("ok" in request) return request;

  const stored = await readStoredAnchor(request.anchorRoot);
  if (stored !== null && "ok" in stored) return stored;

  const reuse = detectFenceReuse(stored, request);
  if (reuse !== null) return reuse;

  // Repeated prepare of the SAME command returns the stored record verbatim, so
  // the prepared identity is reused rather than minted a second time.
  if (stored !== null && stored.preparedIdentity === computePreparedIdentity(request)) {
    request.injectFault?.("PREPARE");
    return Object.freeze({ anchor: stored, ok: true as const, outcome: "PREPARED" as const });
  }

  // The new record keeps naming the LIVE slot as current. Overwriting that
  // pointer here would orphan a good slot if the process died immediately after.
  const current = stored?.currentSlot ?? RECOVERY_BINDING_SLOTS[0];
  const record = buildAnchorRecord(
    request,
    { current, target: selectInactiveSlot(current) },
    "PREPARED",
  );
  request.injectFault?.("PREPARE");
  await publishFileAtomically(anchorPath(request.anchorRoot), encodeAnchorRecord(record));
  return Object.freeze({ anchor: record, ok: true as const, outcome: "PREPARED" as const });
}

/**
 * An install that already completed is NOT re-run.
 *
 * After the switch `currentSlot === targetSlot`, so re-entering the protocol
 * would write the restored payload into the slot that is now LIVE — the one
 * thing this module exists to never do. Completion is therefore idempotent on
 * the prepared identity: the same fence answers with the same record.
 */
async function settledInstall(
  request: RecoveryAnchorRequest,
): Promise<RecoveryAnchorInstallResult | null> {
  const stored = await readStoredAnchor(request.anchorRoot);
  if (stored === null || "ok" in stored) return null;
  // Identity FIRST, on every arm: an anchor belonging to a different command is
  // never adopted, however settled it looks.
  if (stored.preparedIdentity !== computePreparedIdentity(request)) return null;
  if (stored.state === "INSTALLED") {
    return Object.freeze({ anchor: stored, ok: true as const, outcome: "INSTALLED" as const });
  }
  // The switch landed but the marker did not. `currentSlot === targetSlot` is
  // an unambiguous signature of that window: preparation always targets the
  // INACTIVE slot, so the pair is unreachable until runInstall publishes the
  // switch, and it is the only durable evidence the switch is durable.
  if (stored.currentSlot !== stored.targetSlot) return null;
  // Marker only. Re-running the protocol would write into a slot readers now
  // resolve, which is precisely what this function's comment forbids.
  return markInstalled(anchorPath(request.anchorRoot), stored);
}

export async function installRecoveryAnchor(input: unknown): Promise<RecoveryAnchorInstallResult> {
  const request = readAnchorRequest(input);
  if ("ok" in request) return request;
  const settled = await settledInstall(request);
  if (settled !== null) return settled;
  const prepared = await prepareRecoveryAnchor(input);
  if (!prepared.ok) return prepared;
  return runInstall(request, prepared.anchor);
}

/**
 * Carry an already-prepared restore through to INSTALLED. Resuming is
 * idempotent on the prepared identity: it never mints a second fence, and it
 * refuses outright if the stored anchor belongs to a different command, so a
 * replayed restore cannot ride another attempt's preparation.
 */
export async function resumeRecoveryAnchor(input: unknown): Promise<RecoveryAnchorInstallResult> {
  const request = readAnchorRequest(input);
  if ("ok" in request) return request;

  const stored = await readStoredAnchor(request.anchorRoot);
  if (stored !== null && "ok" in stored) return stored;
  if (stored !== null && stored.restoreCommandId !== request.restoreCommandId) {
    return RECOVERY_ANCHOR_COMMAND_MISMATCH;
  }
  return installRecoveryAnchor(input);
}

/**
 * Abandon the restore staged in the slot that is NOT current.
 *
 * The non-current slot is the safe one to clear in BOTH states: while PREPARED
 * it holds the half-built restore, and once INSTALLED it holds the superseded
 * one. Deriving the target from `currentSlot` rather than from `targetSlot` is
 * what stops a discard after a completed install from deleting the live slot.
 */
export async function discardRecoveryAnchor(input: unknown): Promise<RecoveryAnchorDiscardResult> {
  if (typeof input !== "string" || input.length === 0) return RECOVERY_ANCHOR_REQUEST_INVALID;
  const stored = await readStoredAnchor(input);
  if (stored === null) {
    return Object.freeze({ anchorRoot: input, ok: true as const, outcome: "ABSENT" as const });
  }
  if ("ok" in stored) return stored;

  const discardedSlot = selectInactiveSlot(stored.currentSlot);
  await removeDirectory(slotDirectory(input, discardedSlot));
  return Object.freeze({ discardedSlot, ok: true as const, outcome: "DISCARDED" as const });
}

/**
 * The only reading a half-finished restore permits. Mutating open is never
 * granted here: an INSTALLED anchor has SELECTED a database, which is not the
 * same as recovery having finished — the record still says RECOVERY_REQUIRED
 * and only the reducer may clear that.
 */
export async function inspectRecoveryAnchor(input: unknown): Promise<RecoveryAnchorInspectResult> {
  if (typeof input !== "string" || input.length === 0) return RECOVERY_ANCHOR_REQUEST_INVALID;
  const stored = await readStoredAnchor(input);
  if (stored === null) {
    return Object.freeze({ anchorRoot: input, ok: true as const, outcome: "ABSENT" as const });
  }
  if ("ok" in stored) return stored;

  // Once INSTALLED, the anchor asserts WHICH generation its current slot holds,
  // so the slot is graded against it too — an internally consistent slot can
  // still be the wrong one.
  const unverifiable = await verifySlot(
    slotDirectory(input, stored.currentSlot),
    stored.projectId,
    stored.state === "INSTALLED" ? stored : null,
  );
  return Object.freeze({
    allowedOperations: RECOVERY_ANCHOR_ALLOWED_OPERATIONS,
    anchor: stored,
    currentSlot: stored.currentSlot,
    mutatingOpenAllowed: false as const,
    mutatingOpenRefusal: unverifiable ?? RECOVERY_ANCHOR_RECOVERY_REQUIRED,
    ok: true as const,
    outcome: "INSPECTED" as const,
    slotVerified: unverifiable === null,
  });
}
