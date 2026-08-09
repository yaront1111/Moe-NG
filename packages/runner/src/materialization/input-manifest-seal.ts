import { isCommitIdentity, isHex64 } from "../canonical.js";
import { exactRecord, oneOf } from "../supervisor/effect-shape.js";
import { parseMirroredDependencyContract } from "./dependency-witness-mirror.js";
import {
  parseEnvironmentRequirements,
  parseGraphEpoch,
  parseSelectedInputs,
  sealDigests,
  type NodeInputManifest,
  type NodeInputManifestBody,
  type SealedWitnessBinding,
} from "./input-manifest-digest.js";
export type {
  NodeInputManifest,
  SealedGraphEpoch,
  SealedWitnessBinding,
} from "./input-manifest-digest.js";
import {
  MAX_MATERIALIZATION_CONTRACTS,
  NODE_INPUT_MANIFEST_VERSION,
  QUALIFYING_MILESTONES,
  materializationFailure,
  readBoundedList,
  type MaterializationFailure,
} from "./materialization-kernel.js";
import type { PredecessorSelection } from "./predecessor-selection.js";
import { recheckMaterializationSealWitnesses } from "./witness-recheck.js";

/**
 * The second transaction of design line 380: revalidate every producer, adoption
 * and dependency satisfaction witness, then seal the `NodeInputManifest`.
 *
 * A refused seal returns ONLY a failure. There is no manifest, no binding hash,
 * and no field a caller could mistake for one — stale input quarantines the
 * effect and triggers no worker claim (design line 799), so the refusal shape
 * itself has to be undispatchable rather than merely flagged.
 */
export interface SealNodeInputManifestInput {
  readonly selection: PredecessorSelection;
  readonly contracts: unknown;
  readonly monotonicRegistry: unknown;
  readonly currentWitnessFacts: unknown;
  readonly environmentRequirements: unknown;
  readonly nodeAuthorityHash: unknown;
  readonly providerRuntimeSha256: unknown;
  readonly graphEpoch: unknown;
}

export type SealNodeInputManifestResult =
  | { readonly ok: true; readonly manifest: NodeInputManifest }
  | MaterializationFailure;

function sealRefusal(
  code: Parameters<typeof materializationFailure>[0],
  message: string,
): MaterializationFailure {
  return materializationFailure(code, "SEAL", message);
}

function parseSelection(value: unknown): PredecessorSelection | null {
  const item = exactRecord(value, ["baseIdentity", "requiredMilestone", "entries"]);
  if (item === null || !isCommitIdentity(item["baseIdentity"])) return null;
  if (!oneOf(item["requiredMilestone"], QUALIFYING_MILESTONES)) return null;
  const entries = parseSelectedInputs(item["entries"]);
  return entries === null
    ? null
    : { baseIdentity: item["baseIdentity"], requiredMilestone: item["requiredMilestone"], entries };
}

/**
 * The sealed witness values come from the contracts themselves, not from the
 * recheck verdict: the manifest must record what it was sealed AGAINST, which is
 * the contract's declared version and digest.
 */
function collectWitnessBindings(value: unknown): SealedWitnessBinding[] | null {
  const read = readBoundedList(value, MAX_MATERIALIZATION_CONTRACTS);
  if (read.kind !== "OK") return null;
  const bindings = new Map<string, SealedWitnessBinding>();
  for (const entry of read.items) {
    const contract = parseMirroredDependencyContract(entry);
    if (contract === null) return null;
    for (const witness of contract.satisfactionWitnesses) {
      bindings.set(witness.witnessRef, {
        witnessRef: witness.witnessRef,
        witnessVersion: witness.witnessVersion,
        witnessDigest: witness.witnessDigest,
      });
    }
  }
  return [...bindings.values()].sort((left, right) =>
    left.witnessRef < right.witnessRef ? -1 : left.witnessRef > right.witnessRef ? 1 : 0,
  );
}

function freezeManifest(body: NodeInputManifestBody): NodeInputManifest {
  const digests = sealDigests(body);
  return Object.freeze({
    manifestVersion: body.manifestVersion,
    baseIdentity: body.baseIdentity,
    requiredMilestone: body.requiredMilestone,
    entries: Object.freeze(body.entries.map((entry) => Object.freeze(entry))),
    witnessBindings: Object.freeze(body.witnessBindings.map((entry) => Object.freeze(entry))),
    environmentRequirements: Object.freeze([...body.environmentRequirements]),
    graphEpoch: Object.freeze(body.graphEpoch),
    nodeAuthorityHash: body.nodeAuthorityHash,
    providerRuntimeSha256: body.providerRuntimeSha256,
    ...digests,
  });
}

export function sealNodeInputManifest(
  input: SealNodeInputManifestInput,
): SealNodeInputManifestResult {
  const selection = parseSelection(input.selection);
  if (selection === null) {
    return sealRefusal("RUNNER_MATERIALIZATION_SELECTION_INVALID", "selection is not a sealed predecessor selection");
  }
  if (!isHex64(input.nodeAuthorityHash)) {
    return sealRefusal("RUNNER_MATERIALIZATION_AUTHORITY_INVALID", "nodeAuthorityHash must be lowercase 64-hex");
  }
  if (input.providerRuntimeSha256 !== null && !isHex64(input.providerRuntimeSha256)) {
    return sealRefusal("RUNNER_MATERIALIZATION_PROVIDER_RUNTIME_INVALID", "provider runtime observation must be 64-hex or absent");
  }
  const environmentRequirements = parseEnvironmentRequirements(input.environmentRequirements);
  if (environmentRequirements === null) {
    return sealRefusal("RUNNER_MATERIALIZATION_ENVIRONMENT_INVALID", "environment-manifest requirements are malformed");
  }
  const graphEpoch = parseGraphEpoch(input.graphEpoch);
  if (graphEpoch === null) {
    return sealRefusal("RUNNER_MATERIALIZATION_EPOCH_INVALID", "source graph/binding epoch is malformed");
  }
  // The recheck runs BEFORE anything is bound, so a flipped witness produces a
  // refusal rather than a manifest that merely records the flip.
  const verdict = recheckMaterializationSealWitnesses({
    contracts: input.contracts,
    monotonicRegistry: input.monotonicRegistry,
    currentWitnessFacts: input.currentWitnessFacts,
  });
  if (verdict.ok !== true) return verdict;
  const witnessBindings = collectWitnessBindings(input.contracts);
  if (witnessBindings === null) {
    return sealRefusal("RUNNER_MATERIALIZATION_SELECTION_INVALID", "dependency contracts changed shape during the seal");
  }
  return Object.freeze({
    ok: true as const,
    manifest: freezeManifest({
      manifestVersion: NODE_INPUT_MANIFEST_VERSION,
      baseIdentity: selection.baseIdentity,
      requiredMilestone: selection.requiredMilestone,
      entries: selection.entries,
      witnessBindings,
      environmentRequirements,
      graphEpoch,
      nodeAuthorityHash: input.nodeAuthorityHash,
      providerRuntimeSha256: input.providerRuntimeSha256 as string | null,
    }),
  });
}
