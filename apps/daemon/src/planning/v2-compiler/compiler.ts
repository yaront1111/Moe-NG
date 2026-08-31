import {
  encodeProductContractRevisionV2, type CapabilityCatalogResolutionMaterials,
  type CapabilityCatalogRevision, type ProductContractRevisionV2,
} from "@moe/core";

import { sealCanonicalDag } from "./canonical.js";
import {
  captureCompilerDependencies, type V2CompilerFactoryDependencies,
} from "./compiler-dependencies.js";
import { v2CompilerRefusal, type V2CompileResult } from "./contracts.js";
import { admitResolutionFact, type AdmittedResolution } from "./resolution.js";
import {
  createResolutionTokenStore, mintResolutionToken, readTokenWitnesses,
  revalidateTokenWitnesses,
  type ResolutionTokenDependencies, type ResolutionTokenStore,
  type V2CompilerResolutionRequest, type V2CompilerResolutionToken,
  type V2CompilerResolutionTokenMintResult,
} from "./resolution-token.js";
import { bindSchedulerAuthority } from "./scheduler-authority.js";
import { exact, snapshotCompilerInput } from "./snapshot.js";
import { prepareDag, resolutionKey, schedulerGraphKey } from "./topology.js";

export type {
  V2CompilerResolutionRequest, V2CompilerResolutionToken,
  V2CompilerResolutionTokenMintResult,
} from "./resolution-token.js";
export type { V2CompilerFactoryDependencies } from "./compiler-dependencies.js";

const INPUT_KEYS = Object.freeze(["contract", "graphId", "nodes"]);

export interface V2Compiler {
  readonly compile: (
    value: unknown, resolutionTokens: readonly V2CompilerResolutionToken[],
  ) => V2CompileResult;
  readonly mintResolutionToken: (
    catalog: CapabilityCatalogRevision,
    request: V2CompilerResolutionRequest,
    materials: CapabilityCatalogResolutionMaterials,
  ) => V2CompilerResolutionTokenMintResult;
}

/** Tierless compiler; policy binds risk only after this exact graph digest exists. */
function compileV2Dag(store: ResolutionTokenStore,
  dependencies: V2CompilerFactoryDependencies, value: unknown,
  resolutionTokens: readonly V2CompilerResolutionToken[]): V2CompileResult {
  const snapshot = snapshotCompilerInput(value);
  if (!snapshot.ok || !exact(snapshot.value, INPUT_KEYS)
    || !schedulerGraphKey(snapshot.value["graphId"])) {
    return v2CompilerRefusal("V2_COMPILER_INPUT_MALFORMED", "V2_COMPILER_INPUT");
  }
  const contractResult = encodeProductContractRevisionV2(snapshot.value["contract"]);
  if (!contractResult.ok) {
    return v2CompilerRefusal("V2_COMPILER_CONTRACT_INVALID", "V2_COMPILER_CONTRACT");
  }
  const resolutionValues = readTokenWitnesses(store, resolutionTokens);
  if (!resolutionValues.ok) return resolutionValues;
  const resolutions = new Map<string, AdmittedResolution>();
  for (const candidate of resolutionValues.witnesses) {
    const admitted = admitResolutionFact(candidate);
    if (!admitted.ok) return admitted;
    const key = resolutionKey(
      admitted.fact.catalogRevisionDigest, admitted.fact.builder.capabilityId,
    );
    if (resolutions.has(key)) return v2CompilerRefusal(
      "V2_COMPILER_MATERIAL_DIGEST_UNBOUND", "V2_COMPILER_MATERIAL_BINDING",
    );
    resolutions.set(key, admitted.fact);
  }
  const contract = snapshot.value["contract"] as unknown as ProductContractRevisionV2;
  const prepared = prepareDag(contract, snapshot.value["nodes"], resolutions);
  if (!prepared.ok) return prepared;
  if (prepared.prepared.qualificationFences.length !== 1) return v2CompilerRefusal(
    "V2_COMPILER_QUALIFICATION_AUTHORITY_MISMATCH", "V2_COMPILER_MATERIAL_BINDING",
  );
  const contractBinding = Object.freeze({ contractId: contract.contractId,
    revisionDigest: contract.revisionDigest, revisionId: contract.revisionId });
  const scheduler = bindSchedulerAuthority(dependencies, snapshot.value["graphId"],
    contractBinding, prepared.facts, prepared.prepared.nodes, prepared.prepared.criteria);
  if (!scheduler.ok) return scheduler;
  const current = revalidateTokenWitnesses(dependencies, resolutionValues.records);
  if (!current.ok) return current;
  return sealCanonicalDag({ contractBinding, criteria: prepared.prepared.criteria,
    graphId: snapshot.value["graphId"], materialDigests: prepared.prepared.materialDigests,
    nodes: prepared.prepared.nodes,
    qualificationFences: prepared.prepared.qualificationFences,
    schedulerAuthority: scheduler.binding });
}

const INVALID_DEPENDENCIES: V2CompilerFactoryDependencies = Object.freeze({
  clock: () => Number.NaN,
  qualificationAuthority: Object.freeze({
    readDurableQualificationStatus: () => undefined,
    verifyDurableBuilderIdentity: () => false, verifyDurableOperatorApproval: () => false,
    verifyDurableProviderProfile: () => false, verifyDurableVerifierReceipt: () => false,
  }),
  readGraphAuthority: () => undefined, readNodeAdmissionAuthority: () => undefined,
  readNodeDefinition: () => undefined,
});

/** Server composition boundary: every authority function is descriptor-captured exactly once. */
export function createV2Compiler(dependencies: V2CompilerFactoryDependencies): V2Compiler {
  const captured = captureCompilerDependencies(dependencies) ?? INVALID_DEPENDENCIES;
  const store = createResolutionTokenStore();
  return Object.freeze({
    compile: (value: unknown, tokens: readonly V2CompilerResolutionToken[]) =>
      compileV2Dag(store, captured, value, tokens),
    mintResolutionToken: (catalog: CapabilityCatalogRevision,
      request: V2CompilerResolutionRequest, materials: CapabilityCatalogResolutionMaterials) =>
      mintResolutionToken(store, captured as ResolutionTokenDependencies,
        catalog, request, materials),
  });
}
