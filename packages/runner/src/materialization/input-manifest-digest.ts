import { canonicalDigest, isCommitIdentity, isHex64, isSafeByteCount } from "../canonical.js";
import { exactRecord, isCount, isRef, oneOf } from "../supervisor/effect-shape.js";
import {
  MAX_ENVIRONMENT_REQUIREMENTS,
  MAX_MATERIALIZATION_WITNESSES,
  MAX_SELECTED_INPUTS,
  NODE_INPUT_MANIFEST_VERSION,
  QUALIFYING_MILESTONES,
  isMirroredGraphKey,
  readBoundedList,
  type QualifyingMilestone,
} from "./materialization-kernel.js";
import type { SelectedInput } from "./predecessor-selection.js";

/**
 * What the three sealed digests cover, and the shape they cover it over.
 *
 * Each field is bound in EXACTLY ONE of the three records below and reaches the
 * others through the digest that already covers it — the same transitive
 * embedding `workspace-contract.ts` uses for its result manifest. Binding a
 * field twice would make it impossible to tell, by mutating one record, whether
 * that record still binds anything.
 *
 * Design line 256 lists what `inputBindingHash` must bind. Item by item, and
 * where each is bound:
 *   - exact `nodeAuthorityHash`          -> `inputBindingDigestInput`, directly
 *   - `NodeInputManifest` digest         -> `inputBindingDigestInput`, directly
 *   - resulting input tree               -> `inputBindingDigestInput`, directly
 *   - selected predecessor result and adoption identities
 *                                        -> `inputTreeDigestInput.entries`,
 *                                           via `inputTreeDigest`
 *   - dependency satisfaction-witness IDs/versions/digests
 *                                        -> `nodeInputManifestDigestInput`,
 *                                           via `manifestSha256`
 *   - environment-manifest requirements  -> `inputBindingDigestInput`, directly
 *   - provider-runtime observation       -> `inputBindingDigestInput`, directly
 *   - source graph/binding epoch         -> `inputBindingDigestInput`, directly
 */
export interface SealedWitnessBinding {
  readonly witnessRef: string;
  readonly witnessVersion: number;
  readonly witnessDigest: string;
}

export interface SealedGraphEpoch {
  readonly graphRevisionRef: string;
  readonly graphEpoch: number;
  readonly bindingVersion: number;
}

export interface NodeInputManifest {
  readonly manifestVersion: typeof NODE_INPUT_MANIFEST_VERSION;
  readonly baseIdentity: string;
  readonly requiredMilestone: QualifyingMilestone;
  readonly entries: readonly SelectedInput[];
  readonly witnessBindings: readonly SealedWitnessBinding[];
  readonly environmentRequirements: readonly string[];
  readonly graphEpoch: SealedGraphEpoch;
  readonly nodeAuthorityHash: string;
  readonly providerRuntimeSha256: string | null;
  readonly inputTreeDigest: string;
  readonly manifestSha256: string;
  readonly inputBindingHash: string;
}

export type NodeInputManifestBody = Omit<
  NodeInputManifest,
  "inputTreeDigest" | "manifestSha256" | "inputBindingHash"
>;

/** The resulting input tree: the graph base plus the ordered application sequence. */
export function inputTreeDigestInput(body: NodeInputManifestBody): Record<string, unknown> {
  return {
    manifestVersion: body.manifestVersion,
    baseIdentity: body.baseIdentity,
    requiredMilestone: body.requiredMilestone,
    entries: body.entries.map((entry) => ({
      artifactIdentity: entry.artifactIdentity,
      sha256: entry.sha256,
      byteLength: entry.byteLength,
      producerNodeKey: entry.producerNodeKey,
      producerResultRef: entry.producerResultRef,
      producerAttemptRef: entry.producerAttemptRef,
      producerEpoch: entry.producerEpoch,
      producerAdoptionRef: entry.producerAdoptionRef,
    })),
  };
}

/** Design line 218's `NodeInputManifest`: the sealed tree plus the witnesses it was sealed against. */
export function nodeInputManifestDigestInput(
  body: NodeInputManifestBody,
  inputTreeDigest: string,
): Record<string, unknown> {
  return {
    manifestVersion: body.manifestVersion,
    inputTreeDigest,
    witnessBindings: body.witnessBindings.map((binding) => ({
      witnessRef: binding.witnessRef,
      witnessVersion: binding.witnessVersion,
      witnessDigest: binding.witnessDigest,
    })),
  };
}

/** Design line 256's `inputBindingHash`. Every attempt, candidate, receipt, and result manifest binds it. */
export function inputBindingDigestInput(
  body: NodeInputManifestBody,
  inputTreeDigest: string,
  manifestSha256: string,
): Record<string, unknown> {
  return {
    manifestVersion: body.manifestVersion,
    nodeAuthorityHash: body.nodeAuthorityHash,
    nodeInputManifestSha256: manifestSha256,
    inputTreeDigest,
    environmentRequirements: [...body.environmentRequirements],
    providerRuntimeObservationSha256: body.providerRuntimeSha256,
    sourceGraphEpoch: {
      graphRevisionRef: body.graphEpoch.graphRevisionRef,
      graphEpoch: body.graphEpoch.graphEpoch,
      bindingVersion: body.graphEpoch.bindingVersion,
    },
  };
}

export interface SealedDigests {
  readonly inputTreeDigest: string;
  readonly manifestSha256: string;
  readonly inputBindingHash: string;
}

/** One place computes the chain, so a sealer and a revalidator can never disagree. */
export function sealDigests(body: NodeInputManifestBody): SealedDigests {
  const inputTreeDigest = canonicalDigest(inputTreeDigestInput(body));
  const manifestSha256 = canonicalDigest(nodeInputManifestDigestInput(body, inputTreeDigest));
  return {
    inputTreeDigest,
    manifestSha256,
    inputBindingHash: canonicalDigest(
      inputBindingDigestInput(body, inputTreeDigest, manifestSha256),
    ),
  };
}

const SELECTED_INPUT_KEYS = [
  "artifactIdentity", "sha256", "byteLength", "producerNodeKey",
  "producerResultRef", "producerAttemptRef", "producerEpoch", "producerAdoptionRef",
] as const;

const MANIFEST_KEYS = [
  "manifestVersion", "baseIdentity", "requiredMilestone", "entries", "witnessBindings",
  "environmentRequirements", "graphEpoch", "nodeAuthorityHash", "providerRuntimeSha256",
  "inputTreeDigest", "manifestSha256", "inputBindingHash",
] as const;

/**
 * RE-VALIDATES the selection rather than trusting its type. A caller can hand
 * the sealer a record that never went through `selectPredecessorInputs`, so the
 * "each artifact identity exactly once" rule is enforced HERE too — otherwise a
 * forged selection would seal a manifest binding one identity to two producers,
 * which is exactly the fail-closed refusal the selection step exists to make.
 */
export function parseSelectedInputs(value: unknown): SelectedInput[] | null {
  const read = readBoundedList(value, MAX_SELECTED_INPUTS);
  if (read.kind !== "OK") return null;
  const output: SelectedInput[] = [];
  const seen = new Set<string>();
  for (const entry of read.items) {
    const item = exactRecord(entry, SELECTED_INPUT_KEYS);
    if (item === null || !isRef(item["artifactIdentity"]) || !isHex64(item["sha256"])) return null;
    if (seen.has(item["artifactIdentity"])) return null;
    if (!isSafeByteCount(item["byteLength"]) || !isMirroredGraphKey(item["producerNodeKey"])) {
      return null;
    }
    if (!isRef(item["producerResultRef"]) || !isRef(item["producerAttemptRef"])) return null;
    if (!isCount(item["producerEpoch"]) || !isRef(item["producerAdoptionRef"])) return null;
    seen.add(item["artifactIdentity"]);
    output.push(Object.freeze(item) as unknown as SelectedInput);
  }
  return output;
}

export function parseSealedWitnessBindings(value: unknown): SealedWitnessBinding[] | null {
  const read = readBoundedList(value, MAX_MATERIALIZATION_WITNESSES);
  if (read.kind !== "OK") return null;
  const output: SealedWitnessBinding[] = [];
  for (const entry of read.items) {
    const item = exactRecord(entry, ["witnessRef", "witnessVersion", "witnessDigest"]);
    if (item === null || !isRef(item["witnessRef"]) || !isCount(item["witnessVersion"])) return null;
    if (!isHex64(item["witnessDigest"])) return null;
    output.push(item as unknown as SealedWitnessBinding);
  }
  return output;
}

export function parseGraphEpoch(value: unknown): SealedGraphEpoch | null {
  const item = exactRecord(value, ["graphRevisionRef", "graphEpoch", "bindingVersion"]);
  if (item === null || !isRef(item["graphRevisionRef"])) return null;
  if (!isCount(item["graphEpoch"]) || !isCount(item["bindingVersion"])) return null;
  return item as unknown as SealedGraphEpoch;
}

/** Sorted and duplicate-free, so two callers naming the same closure hash identically. */
export function parseEnvironmentRequirements(value: unknown): string[] | null {
  const read = readBoundedList(value, MAX_ENVIRONMENT_REQUIREMENTS);
  if (read.kind !== "OK") return null;
  const output: string[] = [];
  const seen = new Set<string>();
  for (const entry of read.items) {
    if (!isRef(entry) || seen.has(entry)) return null;
    seen.add(entry);
    output.push(entry);
  }
  return output.sort();
}

export function parseSealedManifest(value: unknown): NodeInputManifest | null {
  const item = exactRecord(value, MANIFEST_KEYS);
  if (item === null || item["manifestVersion"] !== NODE_INPUT_MANIFEST_VERSION) return null;
  const entries = parseSelectedInputs(item["entries"]);
  const witnessBindings = parseSealedWitnessBindings(item["witnessBindings"]);
  const graphEpoch = parseGraphEpoch(item["graphEpoch"]);
  const environmentRequirements = parseEnvironmentRequirements(item["environmentRequirements"]);
  if (entries === null || witnessBindings === null || graphEpoch === null) return null;
  if (environmentRequirements === null || !isCommitIdentity(item["baseIdentity"])) return null;
  if (!oneOf(item["requiredMilestone"], QUALIFYING_MILESTONES)) return null;
  if (!isHex64(item["nodeAuthorityHash"]) || !isHex64(item["inputTreeDigest"])) return null;
  if (!isHex64(item["manifestSha256"]) || !isHex64(item["inputBindingHash"])) return null;
  if (item["providerRuntimeSha256"] !== null && !isHex64(item["providerRuntimeSha256"])) return null;
  return Object.freeze({
    ...(item as unknown as NodeInputManifest),
    entries: Object.freeze(entries),
    witnessBindings: Object.freeze(witnessBindings.map((entry) => Object.freeze(entry))),
    graphEpoch: Object.freeze(graphEpoch),
    environmentRequirements: Object.freeze(environmentRequirements),
  });
}
