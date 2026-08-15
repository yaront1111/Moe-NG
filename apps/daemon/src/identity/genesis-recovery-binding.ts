import { RECOVERY_BINDING_CODEC_VERSION, RECOVERY_BINDING_SLOTS } from "@moe/store";
import type { RecoveryBindingReadResult, RecoveryInitialInstallResult } from "@moe/store";
import type { RecoveryAuthenticationBinding } from "@moe/core";

import type { RecoveryDurableWriteRequest } from "../recovery/recovery-succession-contract.js";

import {
  anchorIncarnation,
  hasAnchoredIncarnation,
  readAnchoredGenesisIncarnation,
} from "../recovery/recovery-incarnation-anchor.js";
import type { AnchorDecisionWriter } from "../recovery/recovery-incarnation-anchor.js";
import { decodeBinding, encodeBinding } from "../recovery/recovery-incarnation-binding-codec.js";
import type { GenesisIncarnationBinding } from "../recovery/recovery-incarnation-contract.js";
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
 * The fencing identity is minted by `mintGenesisIncarnation`, the ONE shared
 * mint, under the explicit `GENESIS` origin — never by a second crypto
 * implementation here, and never by synthesizing a restore command a store that
 * has not restored does not possess. The private key dies with that call by
 * design, exactly as the restore key dies with its process.
 *
 * What it deliberately does NOT do: overwrite. A FOUND slot — restore-installed
 * or a prior genesis — is returned as PRESENT untouched, because re-minting on
 * reboot would silently revoke every outstanding session. A slot that exists
 * but refuses to decode is corruption, not absence, and minting over it would
 * convert an integrity fault into authority: it refuses instead.
 */
export const GENESIS_RECOVERY_ERROR_CODES = Object.freeze([
  "GENESIS_ANCHOR_REFUSED",
  "GENESIS_INSTALL_REFUSED",
  "GENESIS_INSTALL_UNVERIFIED",
  "GENESIS_MINT_FAILED",
  "GENESIS_SLOT_UNREADABLE",
] as const);

export type GenesisRecoveryErrorCode = (typeof GENESIS_RECOVERY_ERROR_CODES)[number];

/**
 * The four store capabilities genesis needs, so refusal paths stay testable.
 *
 * The INITIAL installer, never the replacing one: replacement DELETEs the slot
 * before it INSERTs, so two handles that both observed an absent slot would both
 * commit and the second would destroy the fence the first already reported as
 * INSTALLED, orphaning every credential bound to it. This one proves the store
 * pristine and INSERTs under ONE write lock, so the loser is told it lost by the
 * transaction rather than by a read-back that arrives too late.
 */
export interface GenesisBindingStore extends AnchorDecisionWriter {
  installInitialRecoveryBinding(input: unknown): RecoveryInitialInstallResult;
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

/**
 * DERIVED, never caller-selected. `GenesisRecoveryConfig` deliberately does not
 * grow these two fields: a caller able to choose the correlation or the
 * principal a fence is anchored under could file one store's genesis under
 * another's identity, which is the same discipline `snapshotGenesisContext`
 * enforces on the mint. Both are functions of the incarnation, so a retry after
 * a crash reproduces the exact same command key.
 */
const GENESIS_PRINCIPAL_ID = "daemon-genesis";

const sameEncodedBinding = (
  left: GenesisIncarnationBinding,
  right: GenesisIncarnationBinding,
): boolean => {
  const a = encodeBinding(left);
  const b = encodeBinding(right);
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
};

const anchorRequestFor = (
  binding: GenesisIncarnationBinding,
  config: GenesisRecoveryConfig,
): RecoveryDurableWriteRequest =>
  Object.freeze({
    correlationId: `genesis-recovery:${binding.incarnationRef}`,
    decidedAt: config.clock(),
    principalId: GENESIS_PRINCIPAL_ID,
    projectId: config.projectId,
  });

/**
 * Anchors the fence the ACTIVE slot ACTUALLY holds, then reports it.
 *
 * Driven off the slot's read-back bytes rather than off the mint, so the same
 * path covers a fresh install and a reboot: `anchorIncarnation` recognises the
 * repeat by byte equality and commits nothing. That also HEALS a store whose
 * install landed but whose anchor did not — without it, one failed anchor would
 * strand the fence unanchored forever, because the next boot sees a PRESENT slot
 * and never mints again.
 *
 * A slot this module did not write — a restore record, or a genesis payload
 * whose refs disagree with its row — is reported exactly as before and never
 * anchored. Verifying such a slot is the restore classifier's job, and it fails
 * closed there.
 */
function settle(
  store: GenesisBindingStore,
  config: GenesisRecoveryConfig,
  read: RecoveryBindingReadResult,
  outcome: "INSTALLED" | "PRESENT",
  current: RecoveryAuthenticationBinding,
): GenesisRecoveryResult {
  if (!read.ok || read.outcome !== "FOUND") return present(outcome, current);
  const decoded = decodeBinding(read.binding.payload);
  if (decoded === null || decoded.origin !== "GENESIS") return present(outcome, current);
  if (
    decoded.incarnationRef !== current.recoveryIncarnationRef
    || decoded.keyEpochRef !== current.keyEpochRef
  ) {
    return present(outcome, current);
  }
  if (anchorIncarnation(store, anchorRequestFor(decoded, config), decoded)) {
    return present(outcome, current);
  }
  // `anchorIncarnation` reads-then-writes, so two daemons opening the same store
  // can both see no anchor and both attempt one; the loser is refused by the
  // expectedVersion-0 conflict and would otherwise fail startup even though the
  // anchor it wanted DID land. Re-read and accept only BYTE-IDENTICAL evidence —
  // the same test the idempotent path applies. A conflict that produced
  // different bytes, or none, stays a refusal.
  const landed = readAnchoredGenesisIncarnation(store, config.projectId, decoded.incarnationRef);
  if (landed === null) return refuse("GENESIS_ANCHOR_REFUSED", "ANCHOR_NOT_COMMITTED");
  return sameEncodedBinding(landed, decoded)
    ? present(outcome, current)
    : refuse("GENESIS_ANCHOR_REFUSED", "ANCHOR_BYTES_DIVERGED");
}

/**
 * A refusal is final only while the slot is still unbound.
 *
 * A losing handle can be refused for a reason the WINNER created: the winner
 * anchors its incarnation immediately after installing, that anchor IS
 * authoritative history, and the pristine guard reads history before it reads
 * the slot. Refusing there would fail daemon startup over a store that is
 * perfectly well fenced. Nothing is minted on this path — it reports the fence
 * already on disk, exactly as an entry-time FOUND slot does — so it is not a
 * second way to satisfy the fence, only a second door onto the same one.
 *
 * A slot that is still unbound carries the store's own code through untouched:
 * a store holding real history with no binding must NOT re-fence itself.
 */
function refuseOrAdopt(
  store: GenesisBindingStore,
  config: GenesisRecoveryConfig,
  storeCode: string,
): GenesisRecoveryResult {
  const back = store.readRecoveryBinding(ACTIVE_SLOT);
  const current = bindingFrom(back);
  if (current === null) return refuse("GENESIS_INSTALL_REFUSED", storeCode);
  return settle(store, config, back, "PRESENT", current);
}

export function ensureGenesisRecoveryBinding(
  store: GenesisBindingStore,
  config: GenesisRecoveryConfig,
): GenesisRecoveryResult {
  const read = store.readRecoveryBinding(ACTIVE_SLOT);
  const existing = bindingFrom(read);
  if (existing !== null) return settle(store, config, read, "PRESENT", existing);
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

  // The CANONICAL binding goes on disk, not a bare context digest. 64 hex chars
  // carry no origin tag, no public key and no signature, so a later reader could
  // only take the row's word that a genesis fence holds the slot. The encoded
  // binding is checkable evidence instead, written through the SAME codec the
  // anchor uses, so the row and its anchor agree byte-for-byte.
  const installed = store.installInitialRecoveryBinding({
    bindingCodecVersion: RECOVERY_BINDING_CODEC_VERSION,
    incarnationRef: binding.incarnationRef,
    installedAt: config.clock(),
    keyEpochRef: binding.keyEpochRef,
    payload: encodeBinding(binding),
    slot: ACTIVE_SLOT,
  });
  if (!installed.ok) return refuseOrAdopt(store, config, installed.code);

  // WHO MINTED is the transaction's answer, not a ref comparison: CURRENT means
  // a rival committed first and this handle must adopt that winner, never report
  // itself as the minter. The read-back below is now a SECOND, independent check
  // rather than the only defence, and it still supplies the binding to settle on.
  const back = store.readRecoveryBinding(ACTIVE_SLOT);
  const current = bindingFrom(back);
  if (current === null) return refuse("GENESIS_INSTALL_UNVERIFIED", "READ_BACK_FAILED");
  return settle(store, config, back, installed.outcome === "INSTALLED" ? "INSTALLED" : "PRESENT",
    current);
}
