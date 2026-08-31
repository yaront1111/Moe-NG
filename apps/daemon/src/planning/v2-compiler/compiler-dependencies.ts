import { isProxy } from "node:util/types";
import type { DeliveryProfileQualificationAuthorityPort } from "@moe/core";

import type {
  V2CompilerGraphAuthorityReader, V2CompilerNodeAdmissionAuthorityReader,
  V2CompilerNodeDefinitionReader,
} from "./authority-contracts.js";

export interface V2CompilerFactoryDependencies {
  readonly clock: () => number;
  readonly qualificationAuthority: DeliveryProfileQualificationAuthorityPort;
  readonly readGraphAuthority: V2CompilerGraphAuthorityReader;
  readonly readNodeAdmissionAuthority: V2CompilerNodeAdmissionAuthorityReader;
  readonly readNodeDefinition: V2CompilerNodeDefinitionReader;
}

const DEPENDENCY_KEYS = Object.freeze([
  "clock", "qualificationAuthority", "readGraphAuthority", "readNodeAdmissionAuthority",
  "readNodeDefinition",
]);
const AUTHORITY_KEYS = Object.freeze([
  "readDurableQualificationStatus", "verifyDurableBuilderIdentity",
  "verifyDurableOperatorApproval", "verifyDurableProviderProfile",
  "verifyDurableVerifierReceipt",
]);

function ownFunctions(value: unknown, keys: readonly string[]): Record<string, Function> | undefined {
  if (value === null || typeof value !== "object" || isProxy(value)) return undefined;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length || own.some((key) =>
      typeof key !== "string" || !keys.includes(key))) return undefined;
    const result: Record<string, Function> = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)
        || typeof descriptor.value !== "function") return undefined;
      result[key] = descriptor.value;
    }
    return result;
  } catch { return undefined; }
}

export function captureCompilerDependencies(value: unknown):
V2CompilerFactoryDependencies | undefined {
  if (value === null || typeof value !== "object" || isProxy(value)) return undefined;
  let authorityValue: unknown; let dependencies: Record<string, Function>;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype
      || Reflect.ownKeys(value).length !== DEPENDENCY_KEYS.length
      || Reflect.ownKeys(value).some((key) =>
        typeof key !== "string" || !DEPENDENCY_KEYS.includes(key))) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, "qualificationAuthority");
    if (descriptor === undefined || !("value" in descriptor)) return undefined;
    authorityValue = descriptor.value;
    dependencies = Object.create(null) as Record<string, Function>;
    for (const key of [
      "clock", "readGraphAuthority", "readNodeAdmissionAuthority", "readNodeDefinition",
    ]) {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (property === undefined || !("value" in property)
        || typeof property.value !== "function") return undefined;
      dependencies[key] = property.value;
    }
  } catch { return undefined; }
  const authority = ownFunctions(authorityValue, AUTHORITY_KEYS);
  if (authority === undefined) return undefined;
  return Object.freeze({ clock: dependencies["clock"] as () => number,
    qualificationAuthority: Object.freeze({
      readDurableQualificationStatus: authority["readDurableQualificationStatus"],
      verifyDurableBuilderIdentity: authority["verifyDurableBuilderIdentity"],
      verifyDurableOperatorApproval: authority["verifyDurableOperatorApproval"],
      verifyDurableProviderProfile: authority["verifyDurableProviderProfile"],
      verifyDurableVerifierReceipt: authority["verifyDurableVerifierReceipt"],
    }) as DeliveryProfileQualificationAuthorityPort,
    readGraphAuthority: dependencies["readGraphAuthority"] as V2CompilerGraphAuthorityReader,
    readNodeAdmissionAuthority: dependencies["readNodeAdmissionAuthority"] as
      V2CompilerNodeAdmissionAuthorityReader,
    readNodeDefinition: dependencies["readNodeDefinition"] as V2CompilerNodeDefinitionReader,
  });
}
