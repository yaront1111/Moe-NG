import { isProxy } from "node:util/types";

import { SqliteEventStore } from "@moe/store";

export interface ProductContractV2PendingConfigMintInput {
  readonly commandKind: string;
  readonly targetAggregateId: string;
}

export interface ProductContractV2PendingConfig {
  readonly mintCommandId:
    (input: ProductContractV2PendingConfigMintInput) => string;
  readonly mintCorrelationId:
    (input: ProductContractV2PendingConfigMintInput & { readonly commandId: string }) => string;
  readonly projectId: string;
  readonly store: SqliteEventStore;
}

const CONFIG_KEYS = Object.freeze([
  "mintCommandId", "mintCorrelationId", "projectId", "store",
] as const);

function validProjectId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    && Buffer.byteLength(value, "utf8") <= 512 && value.trim() === value
    && !value.includes("\0") && value.isWellFormed() && value.normalize("NFC") === value;
}

/** Captures the composition-root authority without reading accessors or retaining its record. */
export function captureProductContractV2PendingConfig(
  value: unknown,
): ProductContractV2PendingConfig | undefined {
  if (value === null || typeof value !== "object" || isProxy(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== CONFIG_KEYS.length || ownKeys.some(
      (key) => typeof key !== "string"
        || !(CONFIG_KEYS as readonly PropertyKey[]).includes(key),
    )) return undefined;
    const captured: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of CONFIG_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        return undefined;
      }
      captured[key] = descriptor.value;
    }
    if (typeof captured["mintCommandId"] !== "function" || isProxy(captured["mintCommandId"])
      || typeof captured["mintCorrelationId"] !== "function"
      || isProxy(captured["mintCorrelationId"]) || isProxy(captured["store"])
      || !validProjectId(captured["projectId"])
      || !(captured["store"] instanceof SqliteEventStore)) return undefined;
    return Object.freeze({
      mintCommandId: captured["mintCommandId"] as ProductContractV2PendingConfig["mintCommandId"],
      mintCorrelationId:
        captured["mintCorrelationId"] as ProductContractV2PendingConfig["mintCorrelationId"],
      projectId: captured["projectId"], store: captured["store"],
    });
  } catch { return undefined; }
}
