import type { RuntimeCommandKind } from "@moe/contracts";
import { deepFreeze } from "../canonical.js";
import type { ClaudeProcessExit } from "../providers/claude/claude-cancel-reconcile.js";
import type { MirroredLeaseRecord } from "../supervisor/effect-shape.js";
import { exactRecord, isCount, parseMirroredProof } from "../supervisor/effect-shape.js";
import { parseProcessExit } from "../supervisor/process-observation.js";
import { parseRestartRecords, type RestartRecords } from "../supervisor/restart-records.js";
import {
  reconstructAfterRestart,
  type RestartPostState,
} from "../supervisor/restart-reconstruction.js";
import {
  isEffectRef,
  isJournalDigest,
  isRecoveryEffectStatus,
  isReviewPackageDigest,
  recoveryFailure,
  CRASH_OBSERVATION_KEYS,
  type CrashObservation,
  type RecoveryFailure,
} from "./recovery-contract.js";

/**
 * Classifies one crash from durable records plus one caller-supplied
 * observation, into exactly one member of the closed recovery vocabulary.
 *
 * The five outcome kinds are the whole answer, and there is no sixth. There is
 * in particular no resume arm, so "nothing silently resumes" is a fact about
 * what this function CAN return rather than a check somebody must remember to
 * run. Where no local decision is safe the answer is an exact reconciliation
 * command drawn from the runtime command vocabulary — a named operation an
 * operator or adapter can actually perform, never invented prose and never a
 * guess dressed as a conclusion.
 *
 * Re-derives nothing the supervisor already decides: the durable record set is
 * reconstructed by `reconstructAfterRestart`, which owns the 786/787 table and
 * the ambiguity rules. This layer adds only what recovery itself must answer —
 * whether ownership may move, and whether a late observation may speak.
 *
 * No clock, no randomness, no process. Ownership moves only on a proven fence
 * advance, so elapsed quiet is not expressible as authority here.
 */
export type CrashClassification =
  | {
      readonly kind: "ADOPTED";
      readonly ok: true;
      readonly effectRef: string;
      readonly postState: RestartPostState;
    }
  | { readonly kind: "ABSENT"; readonly ok: true; readonly effectRef: string }
  | {
      readonly kind: "SUSPECT";
      readonly ok: true;
      readonly effectRef: string;
      readonly postState: RestartPostState;
    }
  | {
      readonly kind: "QUARANTINED";
      readonly ok: true;
      readonly effectRef: string;
      readonly held: readonly string[];
    }
  | {
      readonly kind: "RECONCILIATION_COMMAND";
      readonly ok: true;
      readonly effectRef: string;
      readonly command: RuntimeCommandKind;
      readonly detail: string;
    }
  | { readonly kind: "REFUSED"; readonly failure: RecoveryFailure };

const SITUATION_KEYS = ["records", "observation", "claimedAuthority"] as const;

/** Named from the runtime vocabulary, so a typo is a type error, not a bad instruction. */
const INSPECT_EXTERNAL: RuntimeCommandKind = "recovery.inspect_external";
const RECONCILE_EXTERNAL: RuntimeCommandKind = "recovery.reconcile_external";

/** Only a terminalized or tombstoned attempt can carry a proven-absent process. */
const ABSENT_POST_STATES: readonly RestartPostState[] = ["TERMINAL_PROVEN", "TOMBSTONED"];

function refused(code: Parameters<typeof recoveryFailure>[0], message: string): CrashClassification {
  return Object.freeze({
    kind: "REFUSED" as const,
    failure: recoveryFailure(code, "CLASSIFICATION", message),
  });
}

function malformed(message: string): CrashClassification {
  return refused("RECOVERY_OBSERVATION_MALFORMED", message);
}

function parseObservation(value: unknown): CrashObservation | null {
  const parsed = exactRecord(value, CRASH_OBSERVATION_KEYS);
  if (parsed === null) return null;
  const processExit = parseProcessExit(parsed["processExit"]);
  if (processExit === null || !isEffectRef(parsed["effectRef"])) return null;
  if (!isRecoveryEffectStatus(parsed["effectStatus"]) || !isCount(parsed["observedEpoch"])) {
    return null;
  }
  if (typeof parsed["presenceLooksLive"] !== "boolean") return null;
  if (parsed["journalDigest"] !== null && !isJournalDigest(parsed["journalDigest"])) return null;
  const review = parsed["reviewPackageDigest"];
  if (review !== null && !isReviewPackageDigest(review)) return null;
  return { ...parsed, processExit } as unknown as CrashObservation;
}

/**
 * DoD 3. Ownership moves only when the lease core has PROVABLY advanced the
 * fence: a strictly higher epoch AND the new token that advance mints. A proof
 * at the held epoch is the crashed process's own authority replayed, and a
 * replayed token is exactly the theft this refuses. `presenceLooksLive` is
 * never read — an appearance of life is not a fact about authority, and the
 * only way to keep that true is to give it nowhere to be consulted.
 */
function ownershipProven(held: MirroredLeaseRecord, claimedValue: unknown): boolean {
  const claimed = parseMirroredProof(claimedValue);
  if (claimed === null) return false;
  return claimed.epoch > held.epoch && claimed.leaseToken !== held.leaseToken;
}

/** Everything still held, named explicitly rather than counted. */
function heldResources(
  records: RestartRecords,
  observation: CrashObservation,
): readonly string[] {
  const held: string[] = [];
  if (records.resourceFact !== "PROVEN_RELEASED") {
    held.push(`resource:${records.resourceFact}`);
  }
  if (observation.effectStatus === "PROVEN_ACTIVE") {
    held.push(`effect:${observation.effectRef}`);
  }
  return held;
}

/** Absence is a POSITIVE observation: not seeing life is not seeing death. */
function provenAbsent(postState: RestartPostState, exit: ClaudeProcessExit): boolean {
  return ABSENT_POST_STATES.includes(postState) && exit.kind !== "UNOBSERVED";
}

function command(effectRef: string, kind: RuntimeCommandKind, detail: string): CrashClassification {
  return deepFreeze({
    kind: "RECONCILIATION_COMMAND" as const,
    ok: true as const,
    effectRef,
    command: kind,
    detail,
  });
}

/**
 * The classification order is the safety order. SUSPECT is answered before
 * adoption so an effect nobody could establish is never optimistically adopted
 * and never auto-resumed; quarantine is answered before absence so a run that
 * still holds something can never be reported as gone.
 */
function fromPostState(
  postState: RestartPostState,
  records: RestartRecords,
  observation: CrashObservation,
  claimedAuthority: unknown,
): CrashClassification {
  const effectRef = observation.effectRef;
  if (postState === "SUSPECT" || observation.effectStatus === "UNESTABLISHED") {
    return deepFreeze({ kind: "SUSPECT" as const, ok: true as const, effectRef, postState });
  }
  if (postState === "ACTIVE_ADOPTED") {
    return ownershipProven(records.intent.leaseBinding, claimedAuthority)
      ? deepFreeze({ kind: "ADOPTED" as const, ok: true as const, effectRef, postState })
      : refused(
          "RECOVERY_OWNERSHIP_TRANSFER_UNPROVEN",
          "adoption requires a proven lease fence advance, which quiescence never supplies",
        );
  }
  const held = heldResources(records, observation);
  if (held.length > 0) {
    return deepFreeze({ kind: "QUARANTINED" as const, ok: true as const, effectRef, held });
  }
  if (observation.effectStatus === "PROVEN_ABSENT" && provenAbsent(postState, observation.processExit)) {
    return deepFreeze({ kind: "ABSENT" as const, ok: true as const, effectRef });
  }
  return command(
    effectRef,
    RECONCILE_EXTERNAL,
    `no local decision settles ${postState} with an unproven process exit`,
  );
}

export function classifyCrash(inputValue: unknown): CrashClassification {
  const input = exactRecord(inputValue, SITUATION_KEYS);
  if (input === null) {
    return malformed("the crash situation does not carry exactly records, observation and authority");
  }
  const records = parseRestartRecords(input["records"]);
  if (records === null) return malformed("the durable record set does not parse");
  const observation = parseObservation(input["observation"]);
  if (observation === null) return malformed("the crash observation does not parse");
  if (observation.observedEpoch < records.intent.leaseBinding.epoch) {
    return refused(
      "RECOVERY_STALE_OBSERVATION_REFUSED",
      "the observation carries an older epoch than the durable record it would speak about",
    );
  }
  // Reconstructed from the PARSED record set, not from the raw value a second
  // time. One parse is the authority: two independent parses of one caller
  // object would let the epoch this refusal is measured against come from a
  // record set the reconstruction did not accept.
  const reconstructed = reconstructAfterRestart(records);
  if (reconstructed.kind === "REFUSED") {
    return command(observation.effectRef, INSPECT_EXTERNAL, reconstructed.failure.message);
  }
  return fromPostState(reconstructed.postState, records, observation, input["claimedAuthority"]);
}
