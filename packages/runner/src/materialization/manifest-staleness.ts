import { isHex64 } from "../canonical.js";
import { exactRecord, isRef } from "../supervisor/effect-shape.js";
import { parseCurrentWitnessFacts, type CurrentWitnessFact } from "./dependency-witness-mirror.js";
import {
  parseGraphEpoch,
  parseSealedManifest,
  sealDigests,
  type SealedGraphEpoch,
} from "./input-manifest-digest.js";
import {
  MAX_SELECTED_INPUTS,
  materializationFailure,
  readBoundedList,
  type MaterializationFailure,
} from "./materialization-kernel.js";

/**
 * Staleness revalidation for an ALREADY-sealed manifest.
 *
 * Split out of `input-manifest-seal.ts` to keep each file inside the per-file
 * ceiling, and separate for a second reason: a caller holding a sealed manifest
 * must be able to re-ask "may this still dispatch" WITHOUT re-sealing, because
 * re-sealing would happily produce a fresh manifest over the moved facts and
 * hide exactly the movement this check exists to catch.
 */
export interface CurrentPredecessorFact {
  readonly artifactIdentity: string;
  readonly sha256: string;
  readonly producerAdoptionRef: string;
}

export interface RevalidateSealedManifestInput {
  readonly manifest: unknown;
  readonly currentWitnessFacts: unknown;
  readonly currentPredecessors: unknown;
  readonly currentGraphEpoch: unknown;
}

function stale(
  code: Parameters<typeof materializationFailure>[0],
  message: string,
  detail: string | null = null,
): MaterializationFailure {
  return materializationFailure(code, "STALENESS", message, detail);
}

function parseCurrentPredecessors(value: unknown): CurrentPredecessorFact[] | null {
  const read = readBoundedList(value, MAX_SELECTED_INPUTS);
  if (read.kind !== "OK") return null;
  const output: CurrentPredecessorFact[] = [];
  const seen = new Set<string>();
  for (const entry of read.items) {
    const item = exactRecord(entry, ["artifactIdentity", "sha256", "producerAdoptionRef"]);
    // A feed naming one identity twice is refused, never resolved by position:
    // the verdict below is keyed by identity, and keeping whichever fact came
    // last would let a superseded predecessor dispatch in one list order and
    // refuse in the other.
    if (item === null || !isRef(item["artifactIdentity"]) || seen.has(item["artifactIdentity"])) return null;
    if (!isHex64(item["sha256"]) || !isRef(item["producerAdoptionRef"])) return null;
    seen.add(item["artifactIdentity"]);
    output.push(item as unknown as CurrentPredecessorFact);
  }
  return output;
}

function epochMoved(sealed: SealedGraphEpoch, current: SealedGraphEpoch): boolean {
  return (
    sealed.graphRevisionRef !== current.graphRevisionRef ||
    sealed.graphEpoch !== current.graphEpoch ||
    sealed.bindingVersion !== current.bindingVersion
  );
}

/**
 * Revalidates an ALREADY-sealed manifest without re-sealing it. Returns `null`
 * when the manifest may still dispatch and exactly one coded refusal otherwise.
 *
 * Any witness movement refuses, monotonic or not. Design line 382 is explicit
 * that "a current or accepted attempt cannot adopt a changed witness in place":
 * the `MONOTONIC` exemption applies to the recheck AT SEAL, which is where this
 * area implements it, not to a manifest that has already been sealed against a
 * specific version and digest.
 */
export function revalidateSealedManifest(
  input: RevalidateSealedManifestInput,
): MaterializationFailure | null {
  const manifest = parseSealedManifest(input.manifest);
  if (manifest === null) {
    return stale("RUNNER_MATERIALIZATION_MANIFEST_TAMPERED", "sealed manifest is malformed");
  }
  const digests = sealDigests(manifest);
  if (
    digests.inputTreeDigest !== manifest.inputTreeDigest ||
    digests.manifestSha256 !== manifest.manifestSha256 ||
    digests.inputBindingHash !== manifest.inputBindingHash
  ) {
    return stale("RUNNER_MATERIALIZATION_MANIFEST_TAMPERED", "sealed digests no longer cover the manifest body");
  }
  const facts = parseSealedWitnessFacts(input.currentWitnessFacts);
  if (facts === null) {
    return stale("RUNNER_MATERIALIZATION_WITNESS_FACTS_MALFORMED", "current witness facts are malformed");
  }
  for (const binding of manifest.witnessBindings) {
    const fact = facts.get(binding.witnessRef);
    if (
      fact === undefined ||
      fact.witnessVersion !== binding.witnessVersion ||
      fact.witnessDigest !== binding.witnessDigest
    ) {
      return stale("RUNNER_MATERIALIZATION_WITNESS_STALE", "sealed witness is no longer current", binding.witnessRef);
    }
  }
  const predecessors = parseCurrentPredecessors(input.currentPredecessors);
  if (predecessors === null) {
    return stale("RUNNER_MATERIALIZATION_CANDIDATE_MALFORMED", "current predecessor facts are malformed");
  }
  const current = new Map(predecessors.map((fact) => [fact.artifactIdentity, fact] as const));
  for (const entry of manifest.entries) {
    const fact = current.get(entry.artifactIdentity);
    if (
      fact === undefined ||
      fact.sha256 !== entry.sha256 ||
      fact.producerAdoptionRef !== entry.producerAdoptionRef
    ) {
      return stale("RUNNER_MATERIALIZATION_PREDECESSOR_STALE", "selected predecessor is no longer current", entry.artifactIdentity);
    }
  }
  const currentEpoch = parseGraphEpoch(input.currentGraphEpoch);
  if (currentEpoch === null) {
    return stale("RUNNER_MATERIALIZATION_EPOCH_INVALID", "current graph/binding epoch is malformed");
  }
  return epochMoved(manifest.graphEpoch, currentEpoch)
    ? stale("RUNNER_MATERIALIZATION_EPOCH_STALE", "graph/binding epoch moved after the seal")
    : null;
}

/**
 * The same parser the seal-time recheck runs, so the two gates cannot disagree
 * on one fact list. A re-implementation here once dropped the mirror's duplicate
 * refusal, and a feed naming a witness twice then resolved by whichever entry
 * came last: the sealed fact could outrank the moved one and dispatch.
 */
function parseSealedWitnessFacts(value: unknown): Map<string, CurrentWitnessFact> | null {
  const facts = parseCurrentWitnessFacts(value);
  return facts === null ? null : new Map(facts.map((fact) => [fact.witnessRef, fact] as const));
}
