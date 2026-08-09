import {
  MAX_MATERIALIZATION_CONTRACTS,
  materializationFailure,
  readBoundedList,
  type MaterializationFailure,
} from "./materialization-kernel.js";
import {
  byWitnessText,
  parseCurrentWitnessFacts,
  parseMirroredDependencyContract,
  parseMonotonicRegistry,
  type CurrentWitnessFact,
  type MirroredDependencyContract,
  type MirroredMonotonicProof,
  type MirroredStability,
  type MirroredWitnessBinding,
} from "./dependency-witness-mirror.js";

/**
 * The `MATERIALIZATION_SEAL` gate — `DEPENDENCY_GATES[0]`, so it precedes every
 * declared consumption horizon and no contract can be exempt from it by horizon.
 *
 * Split out of `dependency-witness-mirror.ts` to keep each file inside the
 * per-file ceiling: that module owns the mirrored SHAPE, this one owns the
 * verdict derived from it.
 */
export type EffectiveStabilityResult =
  | { readonly ok: true; readonly stability: MirroredStability }
  | MaterializationFailure;

function resolveStability(
  contract: MirroredDependencyContract,
  registry: readonly MirroredMonotonicProof[],
): EffectiveStabilityResult {
  const predicate = contract.satisfactionPredicate;
  const proof = registry.find(
    (entry) =>
      entry.predicateRef === predicate.predicateRef &&
      entry.schemaId === predicate.schemaId &&
      entry.schemaVersion === predicate.schemaVersion,
  );
  if (contract.stability !== "MONOTONIC" || proof === undefined) {
    // dependency-contract.ts:248. A MONOTONIC claim with no registered proof is
    // normalized DOWN, so it stays subject to recheck. Skipping this would exempt
    // a witness the authority itself treats as revocable — a divergence in the
    // unsafe direction, and a silent one.
    return Object.freeze({ ok: true as const, stability: "REVOCABLE" as const });
  }
  const mismatch = contract.satisfactionWitnesses.find(
    (entry) => entry.sourceOperationClass !== proof.sourceOperationClass,
  );
  if (mismatch !== undefined) {
    // dependency-contract.ts:245. The authority refuses this outright; a mirror
    // that accepted it would be strictly more permissive than what it mirrors.
    return materializationFailure(
      "RUNNER_MATERIALIZATION_MONOTONIC_OPERATION_MISMATCH",
      "WITNESS",
      "witness source operation does not match the registered predicate",
      mismatch.witnessRef,
    );
  }
  return Object.freeze({ ok: true as const, stability: "MONOTONIC" as const });
}

/** Public wrapper that parses its own registry, so a caller never has to pre-parse one. */
export function effectiveStability(
  contract: MirroredDependencyContract,
  registryInput: unknown,
): EffectiveStabilityResult {
  const registry = parseMonotonicRegistry(registryInput);
  return registry === null ? registryRefusal() : resolveStability(contract, registry);
}

function registryRefusal(): MaterializationFailure {
  return materializationFailure(
    "RUNNER_MATERIALIZATION_REGISTRY_MALFORMED",
    "WITNESS",
    "monotonic predicate registry is malformed",
  );
}

export interface RecheckWitnessesInput {
  readonly contracts: unknown;
  readonly monotonicRegistry: unknown;
  readonly currentWitnessFacts: unknown;
}

export type WitnessRecheckResult =
  | { readonly ok: true; readonly rechecked: readonly string[]; readonly exempt: readonly string[] }
  | MaterializationFailure;

function parseContracts(value: unknown): MirroredDependencyContract[] | MaterializationFailure {
  const read = readBoundedList(value, MAX_MATERIALIZATION_CONTRACTS);
  if (read.kind === "LIMIT") {
    return materializationFailure(
      "RUNNER_MATERIALIZATION_CONTRACT_LIMIT",
      "WITNESS",
      "dependency contract closure exceeds its ceiling",
    );
  }
  const malformed = materializationFailure(
    "RUNNER_MATERIALIZATION_CONTRACT_MALFORMED",
    "WITNESS",
    "dependency contract is malformed or incomplete",
  );
  if (read.kind !== "OK") return malformed;
  const output: MirroredDependencyContract[] = [];
  for (const entry of read.items) {
    const contract = parseMirroredDependencyContract(entry);
    if (contract === null) return malformed;
    output.push(contract);
  }
  return output.sort(
    (left, right) =>
      byWitnessText(left.producerNodeKey, right.producerNodeKey) ||
      byWitnessText(left.consumerNodeKey, right.consumerNodeKey),
  );
}

function compareWitness(
  witness: MirroredWitnessBinding,
  fact: CurrentWitnessFact | undefined,
): MaterializationFailure | null {
  if (fact === undefined) {
    return materializationFailure(
      "RUNNER_MATERIALIZATION_WITNESS_MISSING",
      "WITNESS",
      "revocable witness has no current fact",
      witness.witnessRef,
    );
  }
  if (fact.witnessVersion !== witness.witnessVersion) {
    return materializationFailure(
      "RUNNER_MATERIALIZATION_WITNESS_VERSION_CHANGED",
      "WITNESS",
      "revocable witness version is not the sealed version",
      witness.witnessRef,
    );
  }
  if (fact.witnessDigest !== witness.witnessDigest) {
    return materializationFailure(
      "RUNNER_MATERIALIZATION_WITNESS_DIGEST_CHANGED",
      "WITNESS",
      "revocable witness digest is not the sealed digest",
      witness.witnessRef,
    );
  }
  return null;
}

/**
 * Contract-level validity is resolved for EVERY contract before any fact is
 * compared, and both passes walk a sorted list, so the witness named in a
 * refusal never depends on the order the caller happened to build the closure in.
 */
export function recheckMaterializationSealWitnesses(
  input: RecheckWitnessesInput,
): WitnessRecheckResult {
  const registry = parseMonotonicRegistry(input.monotonicRegistry);
  if (registry === null) return registryRefusal();
  const contracts = parseContracts(input.contracts);
  if (!Array.isArray(contracts)) return contracts;
  const facts = parseCurrentWitnessFacts(input.currentWitnessFacts);
  if (facts === null) {
    return materializationFailure(
      "RUNNER_MATERIALIZATION_WITNESS_FACTS_MALFORMED",
      "WITNESS",
      "current witness facts are malformed",
    );
  }
  const revocable = new Map<string, MirroredWitnessBinding>();
  const exempt = new Set<string>();
  const declared = new Map<string, MirroredWitnessBinding>();
  for (const contract of contracts) {
    const stability = resolveStability(contract, registry);
    if (stability.ok !== true) return stability;
    for (const witness of contract.satisfactionWitnesses) {
      // Two contracts naming one witnessRef at DIFFERENT versions or digests is
      // a genuine conflict. Keeping the last one seen would resolve it silently
      // by contract order and seal a manifest against a value the other contract
      // never agreed to.
      const previous = declared.get(witness.witnessRef);
      if (
        previous !== undefined &&
        (previous.witnessVersion !== witness.witnessVersion ||
          previous.witnessDigest !== witness.witnessDigest)
      ) {
        return materializationFailure(
          "RUNNER_MATERIALIZATION_CONTRACT_MALFORMED",
          "WITNESS",
          "one witness is declared with disagreeing versions or digests",
          witness.witnessRef,
        );
      }
      declared.set(witness.witnessRef, witness);
      if (stability.stability === "MONOTONIC") exempt.add(witness.witnessRef);
      else revocable.set(witness.witnessRef, witness);
    }
  }
  const sealed = [...revocable.values()].sort((left, right) =>
    byWitnessText(left.witnessRef, right.witnessRef),
  );
  const current = new Map(facts.map((fact) => [fact.witnessRef, fact] as const));
  for (const witness of sealed) {
    const failure = compareWitness(witness, current.get(witness.witnessRef));
    if (failure !== null) return failure;
  }
  return Object.freeze({
    ok: true as const,
    rechecked: Object.freeze(sealed.map((witness) => witness.witnessRef)),
    // A ref that is revocable under ANY contract is never reported exempt: the
    // strictest contract naming it decides, which is the fail-closed direction.
    exempt: Object.freeze(
      [...exempt]
        .filter((ref) => !revocable.has(ref))
        .sort((left, right) => byWitnessText(left, right)),
    ),
  });
}
