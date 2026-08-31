import { createHash } from "node:crypto";

import {
  V2_COMPILED_DAG_DIGEST_DOMAIN,
  V2_COMPILED_DAG_VERSION,
  type V2CompiledDag,
  type V2CompiledCriterionBinding,
  type V2CompiledMaterialDigest,
  type V2CompiledNode,
  type V2CompileResult,
} from "./contracts.js";

const encoder = new TextEncoder();

function canonicalText(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalText).join(",")}]`;
  if (typeof value === "object") {
    const source = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(source).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalText(source[key])}`,
    ).join(",")}}`;
  }
  throw new TypeError("v2 compiler canonicalization received unadmitted data");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    }
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}

export interface CanonicalDagInput {
  readonly contractBinding: V2CompiledDag["contractBinding"];
  readonly criteria: readonly V2CompiledCriterionBinding[];
  readonly graphId: string;
  readonly materialDigests: readonly V2CompiledMaterialDigest[];
  readonly nodes: readonly V2CompiledNode[];
  readonly qualificationFences: V2CompiledDag["qualificationFences"];
  readonly schedulerAuthority: V2CompiledDag["schedulerAuthority"];
}

export function sealCanonicalDag(input: CanonicalDagInput): V2CompileResult {
  const body = {
    contractBinding: input.contractBinding,
    criteria: input.criteria,
    graphId: input.graphId,
    materialDigests: input.materialDigests,
    nodes: input.nodes,
    qualificationFences: input.qualificationFences,
    schedulerAuthority: input.schedulerAuthority,
    version: V2_COMPILED_DAG_VERSION,
  };
  const graphDigest = createHash("sha256")
    .update(V2_COMPILED_DAG_DIGEST_DOMAIN, "utf8")
    .update(Uint8Array.of(0))
    .update(encoder.encode(canonicalText(body)))
    .digest("hex");
  const dag = deepFreeze({ ...body, graphDigest }) as V2CompiledDag;
  const bytes = encoder.encode(canonicalText(dag));
  return Object.freeze({
    canonicalBytesBase64: Buffer.from(bytes).toString("base64"),
    dag,
    graphDigest,
    ok: true as const,
  });
}
