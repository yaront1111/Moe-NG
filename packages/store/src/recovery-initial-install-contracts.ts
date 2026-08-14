/**
 * Vocabulary for the GENESIS recovery-binding install: the initial, non-replacing
 * install a store may accept exactly once, while it is still pristine.
 *
 * This registry is deliberately its OWN closed set rather than an extension of
 * RECOVERY_INSTALL_REASON_CODES. The replacement installer's registry is a
 * published, pinned surface; genesis refusals answer a different question ("may
 * this store be bound for the first time?") and must never be confusable with a
 * replacement refusal. The two sets are asserted disjoint.
 */
import { RECOVERY_INSTALL_TRANSACTION_LAYER } from "./recovery-install-contracts.js";
import type {
  RecoveryBindingRecord,
  RecoveryInstallCommitted,
  RecoveryInstallRefused,
} from "./recovery-install-contracts.js";

export const RECOVERY_INITIAL_INSTALL_REASON_CODES = Object.freeze([
  "RECOVERY_INITIAL_INSTALL_SLOT_UNSUPPORTED",
  "RECOVERY_INITIAL_INSTALL_PENDING_PRESENT",
  "RECOVERY_INITIAL_INSTALL_HISTORY_PRESENT",
  "RECOVERY_INITIAL_INSTALL_ALREADY_BOUND",
] as const);
export type RecoveryInitialInstallReasonCode =
  (typeof RECOVERY_INITIAL_INSTALL_REASON_CODES)[number];

/**
 * No third layer is introduced. Every genesis-specific guard reads durable rows
 * under the write lock, so the transaction layer is the only one that can
 * answer them; codec refusals are returned verbatim from the shared codec and
 * still name RECOVERY_BINDING_CODEC.
 */
export interface RecoveryInitialInstallRefused {
  readonly ok: false;
  readonly outcome: "REFUSED";
  readonly authority: "NONE";
  readonly code: RecoveryInitialInstallReasonCode;
  readonly layer: typeof RECOVERY_INSTALL_TRANSACTION_LAYER;
  readonly reason: string;
  readonly truth: "UNKNOWN";
}

/**
 * The loser's answer, and NOT authority. `ok` is true because nothing went
 * wrong — the store is validly bound already — but `outcome` is CURRENT rather
 * than INSTALLED and `authority` is NONE, so a caller that gates genesis on
 * `outcome === "INSTALLED"` can never mistake it for having minted anything. It
 * carries the exact valid winner so the caller can adopt it, plus a stable
 * code+layer so it is still identifiable without inspecting the binding.
 */
export interface RecoveryInitialInstallCurrent {
  readonly ok: true;
  readonly outcome: "CURRENT";
  readonly authority: "NONE";
  readonly binding: RecoveryBindingRecord;
  readonly bindingDigest: string;
  readonly code: "RECOVERY_INITIAL_INSTALL_ALREADY_BOUND";
  readonly layer: typeof RECOVERY_INSTALL_TRANSACTION_LAYER;
}

/**
 * A committed genesis binding REUSES RecoveryInstallCommitted unchanged, so a
 * durable row installed by genesis is byte-for-byte the same shape as one
 * installed by restore. Nothing downstream may branch on how a binding arrived.
 */
export type RecoveryInitialInstallResult =
  | RecoveryInstallCommitted
  | RecoveryInitialInstallCurrent
  | RecoveryInstallRefused
  | RecoveryInitialInstallRefused;

/**
 * Refusals are FIXED module constants, matching the replacement installer's
 * rule: nothing observed at the failure site — a stored byte, a row count, a
 * SQLite message — has any path into the returned evidence, even by accident.
 */
const refusal = (
  code: RecoveryInitialInstallReasonCode,
  reason: string,
): RecoveryInitialInstallRefused =>
  Object.freeze({
    authority: "NONE" as const,
    code,
    layer: RECOVERY_INSTALL_TRANSACTION_LAYER,
    ok: false as const,
    outcome: "REFUSED" as const,
    reason,
    truth: "UNKNOWN" as const,
  });

export const RECOVERY_INITIAL_INSTALL_SLOT_UNSUPPORTED = refusal(
  "RECOVERY_INITIAL_INSTALL_SLOT_UNSUPPORTED",
  "A genesis recovery binding may only be installed into the ACTIVE slot.",
);
export const RECOVERY_INITIAL_INSTALL_PENDING_PRESENT = refusal(
  "RECOVERY_INITIAL_INSTALL_PENDING_PRESENT",
  "A pending recovery binding is already staged; the store is not pristine.",
);
export const RECOVERY_INITIAL_INSTALL_HISTORY_PRESENT = refusal(
  "RECOVERY_INITIAL_INSTALL_HISTORY_PRESENT",
  "The store already carries authoritative history; genesis identity is no longer installable.",
);
