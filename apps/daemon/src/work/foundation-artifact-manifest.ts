import { encodeFoundationPayload } from "./foundation-attempt-codec.js";

/**
 * THE CANONICAL ARTIFACT-ROSTER MANIFEST of a Foundation attempt — the producer
 * behind the scheduler's `artifactDigest` (`lease-drain.ts:48`), which has a
 * field, a key roster and a parse loop and NO producer anywhere in the tree.
 *
 * WHAT THIS DIGEST SEALS, AND WHAT IT MUST NEVER BE. It seals the ARTIFACT
 * ROSTER and nothing else: the preimage is the roster, its stated cardinality
 * and this manifest's version. `receiptSha256`, `resultTreeSha256`,
 * `inputDigest` and `worktreeDigest` seal DIFFERENT facts and are never aliased
 * to it. That trap is not hypothetical here — `evidence-receipt.ts:202` sets
 * `resultTreeSha256: input.resultManifest.sha256`, so the result manifest's own
 * sha256 IS the result-tree digest on this lane, and returning it from here
 * would be the substitution rail 1 forbids wearing a plausible name.
 *
 * THE CROSS-BINDINGS ARE ON THE RECORD, NOT IN THE PREIMAGE. `projectId`,
 * `attemptRef`, `inputManifestSha256` and `resultManifestSha256` ride beside the
 * digest so the reader can refuse a roster sealed for another attempt or
 * project. Folding them into the preimage would make the digest a compound
 * identity rather than a roster seal, and "the artifact digest" would then
 * change when nothing about the artifacts did.
 *
 * AN OBSERVED-EMPTY ROSTER IS A FACT AND CARRIES ITS OWN PROOF. Under the human
 * option-A ruling (task-4a318d03, comment-a662f748) the closed-M1 empty roster
 * is authorized truth, so this module must be able to seal zero refs WITHOUT the
 * result reading like "nobody ever looked". Two things make that distinction
 * durable, and both are required:
 *   (a) THE BINDING — `resultManifestSha256` exists if and only if the capture
 *       answered and `buildResultManifest` succeeded. A roster nobody enumerated
 *       has no such value to bind to, so `FOUNDATION_ARTIFACT_BINDING_INCOMPLETE`
 *       is the honest answer rather than a bare `[]`.
 *   (b) THE OBSERVATION — `artifactRefCount` is STATED, not inferred from an
 *       array's length when someone reads the row later. A count that is only
 *       ever recomputed from the array cannot testify that the scan ran.
 * The denominator deliberately is NOT a count of enumerated result-tree entries
 * or authored paths: those are legitimately zero for an attempt that changed
 * nothing, so zero would mean both "observed nothing" and "never ran" and the
 * distinction this module exists to draw would collapse.
 *
 * NO LANE POLICY LIVES HERE. Whether a given lane may seal a NONEMPTY roster is
 * the lane's question, and the Foundation lane's answer (it may not — the
 * runner pins `declaredArtifactRefs` empty at
 * `foundation-workspace-capture.ts:221` precisely so no scanner seals a claim it
 * never observed) is enforced one layer up, in the ledger. This module stays
 * total over any bounded roster so its ORDERING STABILITY is testable against a
 * real nonempty roster instead of being unreachable defensive code.
 */

const LAYER = "DAEMON_FOUNDATION_ARTIFACT";
/** MODULE-PRIVATE: a runtime column-zero `*_LAYER` export is a declared boundary
 *  the security roster then polices. Only the TYPE escapes. */
export type FoundationArtifactLayer = typeof LAYER;

export const FOUNDATION_ARTIFACT_MANIFEST_CODES = Object.freeze([
  "FOUNDATION_ARTIFACT_BINDING_INCOMPLETE", "FOUNDATION_ARTIFACT_ROSTER_MALFORMED",
  "FOUNDATION_ARTIFACT_ROSTER_OVERSIZE", "FOUNDATION_ARTIFACT_MANIFEST_UNSEALABLE",
] as const);
export type FoundationArtifactManifestCode =
  (typeof FOUNDATION_ARTIFACT_MANIFEST_CODES)[number];

export const FOUNDATION_ARTIFACT_MANIFEST_VERSION = "moe-foundation-artifact-manifest/1";

/** Bounded so a hostile or drifted roster cannot make the preimage unbounded;
 *  the runner's own workspace roster cap is the sibling of this number. */
export const MAX_FOUNDATION_ARTIFACT_REFS = 512;

/** Structurally the runner's `ArtifactRef` (`artifact-contract.ts:130`), re-stated
 *  here because this module must validate the shape rather than trust a cast. */
export interface FoundationArtifactRef {
  readonly byteLength: number;
  readonly sha256: string;
}

/** Exactly the keys the durable body carries; the ledger's reader pins this set. */
export interface FoundationArtifactManifest {
  /** 64-hex over the ROSTER preimage alone. Never a receipt or tree digest. */
  readonly artifactDigest: string;
  /** STATED, not recomputed: this is the observation half of the denominator. */
  readonly artifactRefCount: number;
  readonly artifactRefs: readonly FoundationArtifactRef[];
  readonly attemptRef: string;
  readonly inputManifestSha256: string;
  readonly manifestVersion: typeof FOUNDATION_ARTIFACT_MANIFEST_VERSION;
  readonly projectId: string;
  /** THE BINDING half: present if and only if the capture answered and the
   *  result manifest built, which is what proves the roster was enumerated. */
  readonly resultManifestSha256: string;
}

export interface FoundationArtifactRefused {
  readonly code: FoundationArtifactManifestCode;
  readonly layer: FoundationArtifactLayer;
  readonly ok: false;
}
export interface FoundationArtifactSealed {
  readonly manifest: FoundationArtifactManifest;
  readonly ok: true;
}
export type FoundationArtifactSealOutcome =
  FoundationArtifactSealed | FoundationArtifactRefused;

export interface FoundationArtifactSealInput {
  readonly attemptRef: string;
  /** `unknown` on purpose: it arrives forwarded from the capture answer and is
   *  validated here, never cast. */
  readonly declaredArtifactRefs: unknown;
  readonly inputManifestSha256: string;
  readonly projectId: string;
  readonly resultManifestSha256: string;
}

const refuse = (code: FoundationArtifactManifestCode): FoundationArtifactRefused =>
  Object.freeze({ code, layer: LAYER, ok: false as const });

const HEX64 = /^[0-9a-f]{64}$/u;
const isHex64 = (value: unknown): value is string =>
  typeof value === "string" && HEX64.test(value);
const isText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const REF_KEYS: readonly string[] = Object.freeze(["byteLength", "sha256"]);

/**
 * EXACT KEYS, not a subset. A ref carrying an extra member would ride into the
 * preimage unvalidated and change the digest, so the roster's canonical form has
 * to be a closed shape rather than "at least these two fields".
 */
function readRef(value: unknown): FoundationArtifactRef | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== REF_KEYS.length || !keys.every((key) => REF_KEYS.includes(key))) {
    return null;
  }
  const { byteLength, sha256 } = value as Record<string, unknown>;
  if (!isHex64(sha256)) return null;
  if (typeof byteLength !== "number" || !Number.isSafeInteger(byteLength) || byteLength < 0) {
    return null;
  }
  return Object.freeze({ byteLength, sha256 });
}

export type FoundationArtifactRoster =
  | { readonly ok: true; readonly refs: readonly FoundationArtifactRef[] }
  | FoundationArtifactRefused;

/**
 * THE CANONICAL ORDER, and it is a production surface on purpose: the digest is
 * only reproducible if two callers holding the same set of refs in different
 * orders derive the same bytes. Sorted by `sha256` then `byteLength`; DUPLICATES
 * REFUSE rather than dedupe, because two identical refs in one roster is a
 * caller that lost count, and silently collapsing them would seal a cardinality
 * nobody declared.
 */
export function canonicalArtifactRoster(value: unknown): FoundationArtifactRoster {
  if (!Array.isArray(value)) return refuse("FOUNDATION_ARTIFACT_ROSTER_MALFORMED");
  if (value.length > MAX_FOUNDATION_ARTIFACT_REFS) {
    return refuse("FOUNDATION_ARTIFACT_ROSTER_OVERSIZE");
  }
  const refs: FoundationArtifactRef[] = [];
  for (const entry of value) {
    const ref = readRef(entry);
    if (ref === null) return refuse("FOUNDATION_ARTIFACT_ROSTER_MALFORMED");
    refs.push(ref);
  }
  refs.sort((left, right) => (left.sha256 === right.sha256
    ? left.byteLength - right.byteLength
    : (left.sha256 < right.sha256 ? -1 : 1)));
  for (let index = 1; index < refs.length; index += 1) {
    const previous = refs[index - 1] as FoundationArtifactRef;
    const current = refs[index] as FoundationArtifactRef;
    if (previous.sha256 === current.sha256 && previous.byteLength === current.byteLength) {
      return refuse("FOUNDATION_ARTIFACT_ROSTER_MALFORMED");
    }
  }
  return Object.freeze({ ok: true as const, refs: Object.freeze(refs) });
}

/**
 * THE PREIMAGE IS THE ROSTER, and the cardinality travels inside it so a digest
 * cannot be reproduced from a roster of a different size. `manifestVersion` is
 * in the preimage so a later encoding change cannot silently collide with a
 * digest sealed under this one.
 */
export type FoundationArtifactDigestOutcome =
  | { readonly digest: string; readonly ok: true }
  | FoundationArtifactRefused;

export function deriveFoundationArtifactDigest(
  refs: readonly FoundationArtifactRef[],
): FoundationArtifactDigestOutcome {
  const encoded = encodeFoundationPayload({
    artifactRefCount: refs.length, artifactRefs: refs,
    manifestVersion: FOUNDATION_ARTIFACT_MANIFEST_VERSION,
  });
  return encoded.ok
    ? Object.freeze({ digest: encoded.digest, ok: true as const })
    : refuse("FOUNDATION_ARTIFACT_MANIFEST_UNSEALABLE");
}

/**
 * Seal a roster into a cross-bound manifest. Refuses before deriving anything
 * when a binding is missing: a digest computed over a roster we cannot tie to an
 * enumeration is exactly the manufactured durable fact condition 1 forbids.
 */
export function sealFoundationArtifactManifest(
  input: FoundationArtifactSealInput,
): FoundationArtifactSealOutcome {
  if (!isText(input.attemptRef) || !isText(input.projectId)) {
    return refuse("FOUNDATION_ARTIFACT_BINDING_INCOMPLETE");
  }
  if (!isHex64(input.resultManifestSha256) || !isHex64(input.inputManifestSha256)) {
    return refuse("FOUNDATION_ARTIFACT_BINDING_INCOMPLETE");
  }
  const roster = canonicalArtifactRoster(input.declaredArtifactRefs);
  if (!roster.ok) return roster;
  const derived = deriveFoundationArtifactDigest(roster.refs);
  if (!derived.ok) return derived;
  return Object.freeze({
    manifest: Object.freeze({
      artifactDigest: derived.digest,
      artifactRefCount: roster.refs.length, artifactRefs: roster.refs,
      attemptRef: input.attemptRef, inputManifestSha256: input.inputManifestSha256,
      manifestVersion: FOUNDATION_ARTIFACT_MANIFEST_VERSION, projectId: input.projectId,
      resultManifestSha256: input.resultManifestSha256,
    }),
    ok: true as const,
  });
}
