/**
 * The six activation receipts a real project has to show before `project.activate`
 * can be minted, and the stable refusal one per member carries when it cannot be
 * measured. This module is PURE: it names the vocabulary and assembles core's
 * witness/observation shapes from an already-measured receipt set. The measuring
 * lives in `activation-receipts-measure.ts`; nothing here touches a node API
 * beyond hashing.
 *
 * The layer constant is deliberately module-private: an exported `*_LAYER` costs a
 * BOUNDARY_ROSTER entry plus arm sets, while a private one costs one allowlist line
 * in `tests/security/layer-visibility-cases.ts`. Its VALUE is pinned by every
 * refusal test; its TYPE is exported so consumers can name it.
 */

import { createHash } from "node:crypto";

import type { ProjectActivationWitness, RepositoryObservation } from "@moe/core";

const ACTIVATION_RECEIPTS_LAYER = "DAEMON_ACTIVATION_RECEIPTS" as const;

/** The boundary that refused; the value is private, the name is the contract. */
export type ActivationReceiptsLayer = typeof ACTIVATION_RECEIPTS_LAYER;

/**
 * The measured members, in card order. `signing` is NOT one of them: it is minted
 * (see `SIGNING_UNSIGNED_REF`) and must never be presented as measured.
 */
export const ACTIVATION_RECEIPT_MEMBERS = Object.freeze([
  "repository", "provider", "store", "backup", "distribution", "policy",
] as const);

export type ActivationReceiptMember = (typeof ACTIVATION_RECEIPT_MEMBERS)[number];

/** One stable code per member, so a card can say WHICH receipt is missing. */
export const ACTIVATION_RECEIPT_CODES = Object.freeze({
  backup: "ACTIVATION_BACKUP_FAILED",
  distribution: "ACTIVATION_DISTRIBUTION_UNMEASURED",
  policy: "ACTIVATION_POLICY_UNMEASURED",
  provider: "ACTIVATION_PROVIDER_UNMEASURED",
  repository: "ACTIVATION_REPOSITORY_UNMEASURED",
  store: "ACTIVATION_STORE_UNMEASURED",
} as const);

export type ActivationReceiptCode =
  (typeof ACTIVATION_RECEIPT_CODES)[ActivationReceiptMember];

/**
 * Signing is required by core's exact nine-key roster but is out of scope for
 * v0.1 (owner decision, 2026-09-04). The ref is fixed and self-describing so a
 * reader can never mistake it for a measured key.
 */
export const SIGNING_UNSIGNED_REF = "signing/unsigned-source-checkout";
export const SIGNING_UNSIGNED_REASON = "not a trust boundary in v0.1";

export interface MeasuredReceipt {
  readonly detail: string;
  /** Present only for the two members core validates as a 64-hex digest. */
  readonly hash?: string;
  readonly measured: true;
  readonly member: ActivationReceiptMember;
  readonly ref: string;
}

export interface UnmeasuredReceipt {
  readonly code: ActivationReceiptCode;
  readonly detail: string;
  readonly layer: ActivationReceiptsLayer;
  readonly measured: false;
  readonly member: ActivationReceiptMember;
}

export interface SigningReceipt {
  readonly measured: false;
  readonly member: "signing";
  readonly minted: true;
  readonly reason: typeof SIGNING_UNSIGNED_REASON;
  readonly ref: typeof SIGNING_UNSIGNED_REF;
}

export type ActivationReceipt = MeasuredReceipt | UnmeasuredReceipt;

export type DistributionKind = "ARTIFACT" | "SOURCE_CHECKOUT";

/** JSON-serialisable end to end: the Activate card renders this verbatim. */
export interface ActivationReceipts {
  readonly distribution: { readonly kind: DistributionKind; readonly root: string } | null;
  readonly measuredAt: string;
  readonly members: readonly ActivationReceipt[];
  readonly repository: { readonly headSha: string; readonly toplevel: string } | null;
  readonly schemaVersion: "moe-activation-receipts/1";
  readonly signing: SigningReceipt;
  readonly store: { readonly storePath: string } | null;
}

export type WitnessAssembly =
  | { readonly ok: true; readonly witness: ProjectActivationWitness }
  | { readonly ok: false; readonly refusals: readonly UnmeasuredReceipt[] };

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The minted signing receipt. Frozen, and the only receipt that is not measured. */
export function signingReceipt(): SigningReceipt {
  return Object.freeze({
    measured: false as const,
    member: "signing" as const,
    minted: true as const,
    reason: SIGNING_UNSIGNED_REASON,
    ref: SIGNING_UNSIGNED_REF,
  });
}

export function unmeasuredReceipt(
  member: ActivationReceiptMember, detail: string,
): UnmeasuredReceipt {
  return Object.freeze({
    code: ACTIVATION_RECEIPT_CODES[member],
    detail,
    layer: ACTIVATION_RECEIPTS_LAYER,
    measured: false as const,
    member,
  });
}

export function measuredReceipt(
  member: ActivationReceiptMember, ref: string, detail: string, hash?: string,
): MeasuredReceipt {
  return Object.freeze(
    hash === undefined
      ? { detail, measured: true as const, member, ref }
      : { detail, hash, measured: true as const, member, ref },
  );
}

function indexed(
  receipts: ActivationReceipts,
): ReadonlyMap<ActivationReceiptMember, ActivationReceipt> {
  return new Map(receipts.members.map((receipt) => [receipt.member, receipt]));
}

/**
 * A member is usable only when it is measured AND carries every field the witness
 * reads from it. A measured member that lost its digest is reported as that
 * member's own refusal rather than padded into a value core would then accept.
 */
function usable(
  found: ActivationReceipt | undefined, member: ActivationReceiptMember, needsHash: boolean,
): MeasuredReceipt | UnmeasuredReceipt {
  if (found === undefined) return unmeasuredReceipt(member, `no ${member} receipt`);
  if (!found.measured) return found;
  if (needsHash && (found.hash === undefined || found.hash === "")) {
    return unmeasuredReceipt(member, `${member} receipt carries no digest`);
  }
  return found;
}

/**
 * Core's exact nine keys, or EVERY unmeasured member. Never the first refusal
 * only: the Activate card has to show all the gaps at once.
 */
export function activationWitnessOf(receipts: ActivationReceipts): WitnessAssembly {
  const found = indexed(receipts);
  const resolved = ACTIVATION_RECEIPT_MEMBERS.map((member) =>
    usable(found.get(member), member, member === "distribution" || member === "policy"));
  const refusals = resolved.filter((receipt): receipt is UnmeasuredReceipt => !receipt.measured);
  if (refusals.length > 0) return Object.freeze({ ok: false as const, refusals: Object.freeze(refusals) });
  const measured = new Map(resolved.map((receipt) => [receipt.member, receipt as MeasuredReceipt]));
  const distribution = measured.get("distribution") as MeasuredReceipt;
  const policy = measured.get("policy") as MeasuredReceipt;
  const provider = measured.get("provider") as MeasuredReceipt;
  return Object.freeze({
    ok: true as const,
    witness: Object.freeze({
      artifactPathRef: distribution.ref,
      backupPathRef: (measured.get("backup") as MeasuredReceipt).ref,
      // Presence only: the provider receipt's detail is the credential REF, never a value.
      credentialRef: provider.detail,
      distributionManifestHash: distribution.hash ?? "",
      policyRevisionHash: policy.hash ?? "",
      providerMinimumProfileRef: provider.ref,
      signingKeyRef: SIGNING_UNSIGNED_REF,
      storeDriverRef: (measured.get("store") as MeasuredReceipt).ref,
      truthClass: "DAEMON_VERIFIED" as const,
    }),
  });
}

/**
 * Core's `validHash` demands 64 hex and a git object name is 40, so the base
 * revision travels as the sha256 of a canonical line. The raw sha stays readable
 * at `receipts.repository.headSha`.
 */
export function repositoryObservationOf(
  receipts: ActivationReceipts,
): RepositoryObservation | null {
  const repository = receipts.repository;
  const found = indexed(receipts).get("repository");
  if (repository === null || found === undefined || !found.measured) return null;
  return Object.freeze({
    baseRevisionHash: sha256Hex(`git-sha1:${repository.headSha}\n`),
    repositoryRef: `repository/${repository.toplevel}`,
    scopeRef: `scope/${repository.toplevel}`,
    truthClass: "DAEMON_VERIFIED" as const,
  });
}
