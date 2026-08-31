import { isProxy } from "node:util/types";
import {
  resolveCapabilityCatalogEntry, type CapabilityCatalogRefusal,
  type CapabilityCatalogResolutionMaterials, type CapabilityCatalogResolutionRequest,
  type CapabilityCatalogResolutionWitness, type CapabilityCatalogRevision,
  type DeliveryProfileQualificationAuthorityPort,
} from "@moe/core";
import { MAX_DECISION_LEGS } from "@moe/store";

import { v2CompilerRefusal, type V2CompilerRefusal } from "./contracts.js";
import { exact, snapshotCompilerInput } from "./snapshot.js";

declare const V2_COMPILER_RESOLUTION_TOKEN: unique symbol;
export interface V2CompilerResolutionToken {
  readonly [V2_COMPILER_RESOLUTION_TOKEN]: "V2_COMPILER_RESOLUTION_TOKEN";
}
export interface V2CompilerResolutionRequest {
  readonly capabilityId: string;
  readonly requiredCriterionCategories:
    CapabilityCatalogResolutionRequest["requiredCriterionCategories"];
}
export type V2CompilerResolutionTokenMintResult =
  | Readonly<{ ok: true; token: V2CompilerResolutionToken }>
  | CapabilityCatalogRefusal | V2CompilerRefusal;
export interface ResolutionTokenDependencies {
  readonly clock: () => number;
  readonly qualificationAuthority: DeliveryProfileQualificationAuthorityPort;
}
export interface TokenRecord {
  readonly catalog: CapabilityCatalogRevision;
  readonly materials: CapabilityCatalogResolutionMaterials;
  readonly request: V2CompilerResolutionRequest;
  readonly witness: CapabilityCatalogResolutionWitness;
}
export interface ResolutionTokenStore {
  readonly records: WeakMap<V2CompilerResolutionToken, TokenRecord>;
}
export type TokenRead =
  | Readonly<{ ok: true; records: readonly TokenRecord[];
    witnesses: readonly CapabilityCatalogResolutionWitness[] }>
  | V2CompilerRefusal;

const unresolved = (): V2CompilerRefusal => v2CompilerRefusal(
  "V2_COMPILER_CAPABILITY_UNRESOLVED", "V2_COMPILER_CAPABILITY_BINDING",
);
const unqualified = (): V2CompilerRefusal => v2CompilerRefusal(
  "V2_COMPILER_DELIVERY_PROFILE_UNQUALIFIED", "V2_COMPILER_CAPABILITY_BINDING",
);
const fenceLimit = (): V2CompilerRefusal => v2CompilerRefusal(
  "V2_COMPILER_QUALIFICATION_FENCE_LIMIT_EXCEEDED", "V2_COMPILER_MATERIAL_BINDING",
);
const now = (dependencies: ResolutionTokenDependencies): number | undefined => {
  let value: number;
  try { value = dependencies.clock(); } catch { return undefined; }
  return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0) ? value : undefined;
};

export function createResolutionTokenStore(): ResolutionTokenStore {
  return Object.freeze({ records: new WeakMap<V2CompilerResolutionToken, TokenRecord>() });
}

export function mintResolutionToken(store: ResolutionTokenStore,
  dependencies: ResolutionTokenDependencies, catalog: CapabilityCatalogRevision,
  request: V2CompilerResolutionRequest,
  materials: CapabilityCatalogResolutionMaterials): V2CompilerResolutionTokenMintResult {
  const atEpochMs = now(dependencies); if (atEpochMs === undefined) return unresolved();
  const snapshot = snapshotCompilerInput({ catalog, materials, request });
  if (!snapshot.ok || !exact(snapshot.value, ["catalog", "materials", "request"])) {
    return unresolved();
  }
  const admittedCatalog = snapshot.value["catalog"] as CapabilityCatalogRevision;
  const admittedMaterials = snapshot.value["materials"] as CapabilityCatalogResolutionMaterials;
  const admittedRequest = snapshot.value["request"] as V2CompilerResolutionRequest;
  const resolved = resolveCapabilityCatalogEntry(admittedCatalog,
    { ...admittedRequest, atEpochMs }, admittedMaterials, dependencies.qualificationAuthority);
  if (!resolved.ok) return resolved;
  const token = Object.freeze(Object.create(null)) as V2CompilerResolutionToken;
  store.records.set(token, Object.freeze({ catalog: admittedCatalog,
    materials: admittedMaterials, request: admittedRequest, witness: resolved.witness }));
  return Object.freeze({ ok: true as const, token });
}

export function readTokenWitnesses(store: ResolutionTokenStore,
  value: unknown): TokenRead {
  try {
    if (isProxy(value) || !Array.isArray(value)
      || Object.getPrototypeOf(value) !== Array.prototype || value.length === 0) return unresolved();
    if (value.length > MAX_DECISION_LEGS) return fenceLimit();
    const own = Reflect.ownKeys(value).filter((key) => key !== "length");
    if (own.length !== value.length) return unresolved();
    const records: TokenRecord[] = []; const tokens: V2CompilerResolutionToken[] = [];
    const seen = new Set<V2CompilerResolutionToken>();
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        return unresolved();
      }
      const token = descriptor.value !== null && typeof descriptor.value === "object"
        ? descriptor.value as V2CompilerResolutionToken : undefined;
      const record = token === undefined ? undefined : store.records.get(token);
      if (token === undefined || record === undefined || seen.has(token)) return unresolved();
      seen.add(token); tokens.push(token); records.push(record);
    }
    for (const token of tokens) store.records.delete(token);
    return Object.freeze({ ok: true as const, records: Object.freeze(records),
      witnesses: Object.freeze(records.map((record) => record.witness)) });
  } catch { return unresolved(); }
}

/** Last synchronous seam before sealing: expiry/revocation cannot hide behind graph assembly. */
export function revalidateTokenWitnesses(dependencies: ResolutionTokenDependencies,
  records: readonly TokenRecord[]): V2CompilerRefusal | Readonly<{ ok: true }> {
  const atEpochMs = now(dependencies); if (atEpochMs === undefined) return unresolved();
  for (const record of records) {
    const resolved = resolveCapabilityCatalogEntry(record.catalog,
      { ...record.request, atEpochMs }, record.materials, dependencies.qualificationAuthority);
    if (!resolved.ok) return unqualified();
    const before = record.witness.deliveryProfileQualificationStatus;
    const current = resolved.witness.deliveryProfileQualificationStatus;
    if (current.qualificationId !== before.qualificationId
      || current.qualificationDigest !== before.qualificationDigest
      || current.statusDigest !== before.statusDigest || current.statusRef !== before.statusRef) {
      return unqualified();
    }
  }
  return Object.freeze({ ok: true as const });
}
