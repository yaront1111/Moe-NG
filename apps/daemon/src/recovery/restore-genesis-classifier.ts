import { Buffer } from "node:buffer";

import { readAnchoredGenesisIncarnation } from "./recovery-incarnation-anchor.js";
import type { AnchorDecisionReader } from "./recovery-incarnation-anchor.js";
import { decodeBinding, encodeBinding } from "./recovery-incarnation-binding-codec.js";
import { digestOf } from "./recovery-incarnation-contract.js";
import type { GenesisIncarnationBinding } from "./recovery-incarnation-contract.js";
import { deriveIncarnation, snapshotGenesisContext } from "./recovery-incarnation-context.js";
import { nodeGenesisCryptoShell } from "./recovery-incarnation-genesis.js";
import { controllerRefusal } from "./restore-controller-contract.js";
import type { RestoreInspection } from "./restore-controller-contract.js";

/**
 * Tells a GENESIS fence apart from a disaster-restore record in the ACTIVE
 * recovery binding slot.
 *
 * A never-restored store installs an ACTIVE binding so the operator can
 * authenticate at all. That row is not a restore, and reading it as one made
 * every fresh daemon answer `RESTORE_RECORD_UNREADABLE` — but the fix must not
 * become the far worse defect of treating "this did not decode as a restore" as
 * "a genesis fence holds the slot". Absence of one proof is not the presence of
 * another. Genesis is recognised ONLY on positive exact proof of every conjunct
 * below, and any shortfall is a refusal that the caller reports as unreadable.
 *
 * The strongest conjunct is the last: the ANCHOR. Every other check is
 * computable by anyone holding the project id, because a genesis binding proves
 * itself with a key it minted for itself — so a forger can produce a
 * self-consistent one at will. What a forger cannot produce is a durable
 * command-decision row this daemon committed. The anchor is what makes the
 * fence a fact the daemon observed rather than a claim the payload makes.
 *
 * NOT checked here, deliberately: the store's own `bindingDigest`. It is a
 * digest of the ROW — slot, refs, installedAt and payload framed together — and
 * not the binding's internal `bindingDigest`, which covers the derivation
 * inputs. Requiring the two to be equal would refuse every valid genesis. The
 * row digest is already enforced upstream: the store refuses the read with
 * RECOVERY_BINDING_DIGEST_MISMATCH before these bytes are ever handed over.
 */
export const GENESIS_FENCE_REJECTIONS = Object.freeze([
  "ANCHOR_ABSENT",
  "ANCHOR_BYTES_DIVERGE",
  "DERIVATION_MISMATCH",
  "ORIGIN_NOT_GENESIS",
  "PAYLOAD_UNDECODABLE",
  "PROJECT_CONTEXT_MISMATCH",
  "PROOF_UNVERIFIED",
  "ROW_REFS_DIVERGE",
] as const);

export type GenesisFenceRejection = (typeof GENESIS_FENCE_REJECTIONS)[number];

/** The three ACTIVE-row facts classification is entitled to read. */
export interface GenesisFenceRow {
  readonly incarnationRef: string;
  readonly keyEpochRef: string;
  readonly payload: Uint8Array;
}

export type GenesisFenceVerdict =
  | { readonly binding: GenesisIncarnationBinding; readonly verified: true }
  | { readonly reason: GenesisFenceRejection; readonly verified: false };

const reject = (reason: GenesisFenceRejection): GenesisFenceVerdict =>
  Object.freeze({ reason, verified: false as const });

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/**
 * Verified through the PUBLISHED SPKI, exactly as the mint verified it before
 * publishing — what a later reader can check is what was checked at mint time.
 * A malformed key throws inside the shell; a throw is a failed proof, never an
 * escaping fault, because this runs on a read path that must fail closed.
 */
function proves(binding: GenesisIncarnationBinding): boolean {
  try {
    return nodeGenesisCryptoShell.verify(
      Buffer.from(binding.publicKeySpkiHex, "hex"),
      Buffer.from(binding.proof.challengeDigest, "hex"),
      Buffer.from(binding.proof.signatureHex, "hex"),
    );
  } catch {
    return false;
  }
}

export function classifyGenesisFence(
  store: AnchorDecisionReader,
  projectId: string,
  row: GenesisFenceRow,
): GenesisFenceVerdict {
  // (1) A payload that does not decode is CORRUPTION. Never genesis, never an
  // absence — the whole boundary turns on this line staying a refusal.
  const binding = decodeBinding(row.payload);
  if (binding === null) return reject("PAYLOAD_UNDECODABLE");
  if (binding.origin !== "GENESIS") return reject("ORIGIN_NOT_GENESIS");

  // (2) The payload must describe the row it is stored in, not another one.
  if (binding.incarnationRef !== row.incarnationRef) return reject("ROW_REFS_DIVERGE");
  if (binding.keyEpochRef !== row.keyEpochRef) return reject("ROW_REFS_DIVERGE");

  // (3) The store context is RECOMPUTED from the daemon's asserted project
  // identity, never trusted from the payload: a binding that names its own
  // context could otherwise vouch for whatever project it liked.
  const context = snapshotGenesisContext({ projectId });
  if (context === null) return reject("PROJECT_CONTEXT_MISMATCH");
  if (binding.projectId !== context.projectId) return reject("PROJECT_CONTEXT_MISMATCH");
  if (binding.storeContextDigest !== context.storeContextDigest) {
    return reject("PROJECT_CONTEXT_MISMATCH");
  }

  // (4) Every derived reference recomputes from the binding's own contents
  // through the SHARED derivation, so a field cannot be moved without moving
  // the digest the proof signs. The fingerprint is re-derived from the
  // published key too, which is the one derivation input nothing else pins.
  if (digestOf("key", Buffer.from(binding.publicKeySpkiHex, "hex"))
    !== binding.verificationKeyFingerprint) {
    return reject("DERIVATION_MISMATCH");
  }
  const derived = deriveIncarnation({
    context,
    incarnationDigest: binding.incarnationDigest,
    publicKeySpkiHex: binding.publicKeySpkiHex,
    verificationKeyFingerprint: binding.verificationKeyFingerprint,
  });
  if (
    derived.incarnationRef !== binding.incarnationRef
    || derived.keyEpochRef !== binding.keyEpochRef
    || derived.bindingDigest !== binding.bindingDigest
    || derived.challengeDigest !== binding.proof.challengeDigest
  ) {
    return reject("DERIVATION_MISMATCH");
  }

  // (5) The signature itself, not merely a `verified: true` field the codec
  // checked structurally. A flag is a claim; the signature is the proof.
  if (!proves(binding)) return reject("PROOF_UNVERIFIED");

  // (6) And finally the durable evidence, compared byte-for-byte the same way
  // `anchorIncarnation` compares a repeat anchor against its predecessor.
  const anchored = readAnchoredGenesisIncarnation(store, projectId, binding.incarnationRef);
  if (anchored === null) return reject("ANCHOR_ABSENT");
  if (!sameBytes(encodeBinding(anchored), row.payload)) return reject("ANCHOR_BYTES_DIVERGE");

  return Object.freeze({ binding, verified: true as const });
}

/**
 * The controller-facing adapter, kept HERE rather than inlined into
 * `restore-controller.ts` so that file stays focused and does not grow.
 *
 * Anything short of a verified fence is the controller's own
 * RESTORE_RECORD_UNREADABLE at DAEMON_RESTORE_CONTROLLER — the exact code and
 * layer this slot produced before genesis existed. A row this module cannot
 * vouch for is therefore refused precisely as it always was, and never
 * downgraded to an absence.
 */
export function inspectGenesisFence(
  store: AnchorDecisionReader,
  projectId: string,
  row: GenesisFenceRow,
): RestoreInspection {
  const verdict = classifyGenesisFence(store, projectId, row);
  if (!verdict.verified) return controllerRefusal("RESTORE_RECORD_UNREADABLE");
  return Object.freeze({
    incarnationRef: verdict.binding.incarnationRef,
    keyEpochRef: verdict.binding.keyEpochRef,
    ok: true as const,
    outcome: "GENESIS_FENCED" as const,
  });
}
