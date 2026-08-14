import { RECOVERY_BINDING_CODEC_VERSION, RECOVERY_BINDING_SLOTS } from "@moe/store";
import type {
  RecoveryBindingReadResult,
  RecoveryInstallResult,
  SqliteEventStore,
} from "@moe/store";
import type { RecoveryAuthenticationBinding } from "@moe/core";

import { hasAnchoredIncarnation } from "../recovery/recovery-incarnation-anchor.js";
import { mintGenesisIncarnation } from "../recovery/recovery-incarnation-genesis.js";
import {
  isRecoveryAuthenticationRef,
  projectRecoveryAuthenticationBinding,
} from "./recovery-authentication-binding.js";

/**
 * Breaks the first-boot deadlock: every authentication requires an ACTIVE
 * recovery binding, but the only other installer is the disaster-restore path,
 * so a fresh store that never restored could not authenticate anyone — the
 * operator included.
 *
 * Minted here is a GENESIS fencing identity for a store with no recovery
 * history: fresh CSPRNG entropy and a fresh Ed25519 key epoch, derived through
 * the same domain-separated `digestOf` framing the restore mint uses, under a
 * `genesis:` context no restore command produces. The private key dies with
 * this call by design, exactly as the restore key dies with its process.
 *
 * What it deliberately does NOT do: overwrite. A FOUND slot — restore-installed
 * or a prior genesis — is returned as PRESENT untouched, because re-minting on
 * reboot would silently revoke every outstanding session. A slot that exists
 * but refuses to decode is corruption, not absence, and minting over it would
 * convert an integrity fault into authority: it refuses instead.
 */
export const GENESIS_RECOVERY_ERROR_CODES = Object.freeze([
  "GENESIS_INSTALL_REFUSED",
  "GENESIS_INSTALL_UNVERIFIED",
  "GENESIS_MINT_FAILED",
  "GENESIS_SLOT_UNREADABLE",
] as const);

export type GenesisRecoveryErrorCode = (typeof GENESIS_RECOVERY_ERROR_CODES)[number];

/** The three store capabilities genesis needs, so refusal paths stay testable. */
export interface GenesisBindingStore
  extends Pick<SqliteEventStore, "readCommandDecisionsAfter"> {
  installRecoveryBinding(input: unknown): RecoveryInstallResult;
  readRecoveryBinding(slot: unknown): RecoveryBindingReadResult;
}

export interface GenesisRecoveryConfig {
  readonly clock: () => string;
  readonly projectId: string;
}

export type GenesisRecoveryResult =
  | {
      readonly binding: RecoveryAuthenticationBinding;
      readonly ok: true;
      readonly outcome: "INSTALLED" | "PRESENT";
    }
  | { readonly ok: true; readonly outcome: "DEFERRED" }
  | { readonly code: GenesisRecoveryErrorCode; readonly ok: false; readonly storeCode: string };

const ACTIVE_SLOT = RECOVERY_BINDING_SLOTS[0];
const encoder = new TextEncoder();

const refuse = (code: GenesisRecoveryErrorCode, storeCode: string): GenesisRecoveryResult =>
  Object.freeze({ code, ok: false, storeCode });

const present = (
  outcome: "INSTALLED" | "PRESENT",
  binding: RecoveryAuthenticationBinding,
): GenesisRecoveryResult =>
  Object.freeze({ binding: projectRecoveryAuthenticationBinding(binding), ok: true, outcome });

/** FOUND with well-formed refs, or null. Malformed refs are corruption, never absence. */
const bindingFrom = (read: RecoveryBindingReadResult): RecoveryAuthenticationBinding | null => {
  if (!read.ok || read.outcome !== "FOUND") return null;
  const { incarnationRef, keyEpochRef } = read.binding;
  if (!isRecoveryAuthenticationRef(incarnationRef)) return null;
  if (!isRecoveryAuthenticationRef(keyEpochRef)) return null;
  return Object.freeze({ keyEpochRef, recoveryIncarnationRef: incarnationRef });
};

export function ensureGenesisRecoveryBinding(
  store: GenesisBindingStore,
  config: GenesisRecoveryConfig,
): GenesisRecoveryResult {
  const read = store.readRecoveryBinding(ACTIVE_SLOT);
  const existing = bindingFrom(read);
  if (existing !== null) return present("PRESENT", existing);
  if (!read.ok || read.outcome !== "ABSENT") {
    return refuse("GENESIS_SLOT_UNREADABLE", read.ok ? read.outcome : read.code);
  }

  // An empty slot with an anchored incarnation is a restore waiting to quiesce,
  // not a fresh store: the restore controller owns that install. Genesis stands
  // aside and authentication stays refused until the quiesce lands the binding.
  if (hasAnchoredIncarnation(store, config.projectId)) {
    return Object.freeze({ ok: true, outcome: "DEFERRED" } as const);
  }

  // ONE mint implementation, shared with the restore path: the fence a fresh
  // store runs under is derived, self-proven and tagged by the same code.
  const minted = mintGenesisIncarnation(config.projectId);
  if (!minted.ok) return refuse("GENESIS_MINT_FAILED", minted.code);
  const { binding } = minted;

  // The installed payload keeps its existing shape on purpose: persisting the
  // full public proof is the consuming task's edge, not this one's. The binding
  // now HAS that proof, and `encodeBinding` is the codec that will carry it.
  const installed = store.installRecoveryBinding({
    bindingCodecVersion: RECOVERY_BINDING_CODEC_VERSION,
    incarnationRef: binding.incarnationRef,
    installedAt: config.clock(),
    keyEpochRef: binding.keyEpochRef,
    payload: encoder.encode(binding.storeContextDigest),
    slot: ACTIVE_SLOT,
  });
  if (!installed.ok) return refuse("GENESIS_INSTALL_REFUSED", installed.code);

  // Judged on the read-back, not the install result: if a concurrent installer
  // raced this one, the slot's CURRENT content is the authority, not ours.
  const current = bindingFrom(store.readRecoveryBinding(ACTIVE_SLOT));
  if (current === null) return refuse("GENESIS_INSTALL_UNVERIFIED", "READ_BACK_FAILED");
  const ours = current.recoveryIncarnationRef === binding.incarnationRef
    && current.keyEpochRef === binding.keyEpochRef;
  return present(ours ? "INSTALLED" : "PRESENT", current);
}
