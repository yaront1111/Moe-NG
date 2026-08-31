import {
  deepFreeze, exact, snapshotDataBounded, validHex64, validRef,
} from "../planning/planning-snapshot.js";
import {
  DELIVERY_PROFILE_FAMILY_IDS,
  DELIVERY_PROFILE_BENCHMARK_VERDICTS,
  DELIVERY_PROFILE_LIMITS,
  DELIVERY_PROFILE_OPERATOR_DECISIONS,
  DELIVERY_PROFILE_QUALIFICATION_VALIDITIES,
  deliveryProfileRefusal,
  type DeliveryProfileFamilyId,
  type DeliveryProfileBenchmarkVerdict,
  type DeliveryProfileImmutableArtifactRef,
  type DeliveryProfileImmutableImageRef,
  type DeliveryProfileOperatorDecision,
  type DeliveryProfileQualificationValidity,
  type DeliveryProfileRefusal,
} from "./delivery-profile-contract.js";

export { deepFreeze, exact, validHex64 };
export type ReadResult<T> = Readonly<{ ok: true; value: T }> | DeliveryProfileRefusal;

const encoder = new TextEncoder();
const ARTIFACT_KEYS = Object.freeze(["artifactDigest", "artifactRef"]);
const IMAGE_KEYS = Object.freeze(["imageDigest", "imageRef"]);
const OCI_DIGEST = /^sha256:[a-f0-9]{64}$/u;

export const malformed = (): DeliveryProfileRefusal => deliveryProfileRefusal(
  "DELIVERY_PROFILE_MALFORMED", "DELIVERY_PROFILE_ADMISSION",
);
export const unsupportedFamily = (): DeliveryProfileRefusal => deliveryProfileRefusal(
  "DELIVERY_PROFILE_FAMILY_UNSUPPORTED", "DELIVERY_PROFILE_FAMILY",
);
export const familyGrammarMismatch = (): DeliveryProfileRefusal => deliveryProfileRefusal(
  "DELIVERY_PROFILE_FAMILY_GRAMMAR_MISMATCH", "DELIVERY_PROFILE_FAMILY",
);
export const shellExecution = (): DeliveryProfileRefusal => deliveryProfileRefusal(
  "DELIVERY_PROFILE_SHELL_EXECUTION_FORBIDDEN", "DELIVERY_PROFILE_ADMISSION",
);
export const badReference = (): DeliveryProfileRefusal => deliveryProfileRefusal(
  "DELIVERY_PROFILE_REFERENCE_INVALID", "DELIVERY_PROFILE_REFERENCES",
);
export const exceeded = (): DeliveryProfileRefusal => deliveryProfileRefusal(
  "DELIVERY_PROFILE_LIMIT_EXCEEDED", "DELIVERY_PROFILE_LIMITS",
);
export const recipeDigestMismatch = (): DeliveryProfileRefusal => deliveryProfileRefusal(
  "DELIVERY_PROFILE_RECIPE_DIGEST_MISMATCH", "DELIVERY_PROFILE_DIGEST",
);
export const success = <T>(value: T): Readonly<{ ok: true; value: T }> =>
  Object.freeze({ ok: true as const, value });

export function readText(
  value: unknown,
  maximum: number = DELIVERY_PROFILE_LIMITS.maxIdBytes,
): ReadResult<string> {
  if (!validRef(value) || value.includes("\0") || !value.isWellFormed()
    || value.normalize("NFC") !== value) return malformed();
  if (value.length > maximum) return exceeded();
  return encoder.encode(value).byteLength <= maximum ? success(value) : exceeded();
}

export function readNullableRef(value: unknown): ReadResult<string | null> {
  return value === null ? success(null) : readText(value);
}

export function readSortedRefs(
  value: unknown,
  maximum: number,
  allowEmpty = true,
): ReadResult<readonly string[]> {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) return malformed();
  if (value.length > maximum) return exceeded();
  const refs: string[] = [];
  for (const candidate of value) {
    const item = readText(candidate); if (!item.ok) return item;
    const previous = refs.at(-1);
    if (previous !== undefined && previous >= item.value) return malformed();
    refs.push(item.value);
  }
  return success(Object.freeze(refs));
}

export function readSortedItems<T>(
  value: unknown,
  maximum: number,
  allowEmpty: boolean,
  read: (candidate: unknown) => ReadResult<T>,
  idOf: (item: T) => string,
): ReadResult<readonly T[]> {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) return malformed();
  if (value.length > maximum) return exceeded();
  const items: T[] = [];
  for (const candidate of value) {
    const item = read(candidate); if (!item.ok) return item;
    const previous = items.at(-1);
    if (previous !== undefined && idOf(previous) >= idOf(item.value)) return malformed();
    items.push(item.value);
  }
  return success(Object.freeze(items));
}

export function readArtifact(value: unknown): ReadResult<DeliveryProfileImmutableArtifactRef> {
  if (!exact(value, ARTIFACT_KEYS) || !validHex64(value["artifactDigest"])) return malformed();
  const ref = readText(value["artifactRef"]); if (!ref.ok) return ref;
  return success(Object.freeze({
    artifactDigest: value["artifactDigest"], artifactRef: ref.value,
  }));
}

export function readDeliveryProfileSnapshot(value: unknown): ReadResult<unknown> {
  const snapshot = snapshotDataBounded(value, {
    maxArrayLength: DELIVERY_PROFILE_LIMITS.maxSnapshotArrayLength,
    maxDepth: DELIVERY_PROFILE_LIMITS.maxSnapshotDepth,
    maxNodes: DELIVERY_PROFILE_LIMITS.maxSnapshotNodes,
  });
  if (!snapshot.ok) return snapshot.limitExceeded ? exceeded() : malformed();
  return success(snapshot.value);
}

export function readArtifacts(
  value: unknown,
): ReadResult<readonly DeliveryProfileImmutableArtifactRef[]> {
  return readSortedItems(
    value, DELIVERY_PROFILE_LIMITS.maxRefsPerKind, false, readArtifact,
    (item) => item.artifactRef,
  );
}

function readImage(value: unknown): ReadResult<DeliveryProfileImmutableImageRef> {
  if (!exact(value, IMAGE_KEYS) || typeof value["imageDigest"] !== "string"
    || !OCI_DIGEST.test(value["imageDigest"])) return malformed();
  const ref = readText(value["imageRef"]); if (!ref.ok) return ref;
  return success(Object.freeze({ imageDigest: value["imageDigest"], imageRef: ref.value }));
}

export function readImages(value: unknown): ReadResult<readonly DeliveryProfileImmutableImageRef[]> {
  return readSortedItems(
    value, DELIVERY_PROFILE_LIMITS.maxRefsPerKind, false, readImage,
    (item) => item.imageRef,
  );
}

export function hasDirectedCycle(
  ids: readonly string[],
  edges: readonly Readonly<{ consumer: string; provider: string }>[],
): boolean {
  const adjacency = new Map(ids.map((id) => [id, [] as string[]]));
  for (const edge of edges) adjacency.get(edge.consumer)?.push(edge.provider);
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true; if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of adjacency.get(id) ?? []) if (visit(dependency)) return true;
    visiting.delete(id); visited.add(id); return false;
  };
  return ids.some(visit);
}

export const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

export function isFamily(value: unknown): value is DeliveryProfileFamilyId {
  return DELIVERY_PROFILE_FAMILY_IDS.some((candidate) => candidate === value);
}

export function isOperatorDecision(
  value: unknown,
): value is DeliveryProfileOperatorDecision {
  return DELIVERY_PROFILE_OPERATOR_DECISIONS.some((candidate) => candidate === value);
}

export function isBenchmarkVerdict(value: unknown): value is DeliveryProfileBenchmarkVerdict {
  return DELIVERY_PROFILE_BENCHMARK_VERDICTS.some((candidate) => candidate === value);
}

export function isQualificationValidity(
  value: unknown,
): value is DeliveryProfileQualificationValidity {
  return DELIVERY_PROFILE_QUALIFICATION_VALIDITIES.some((candidate) => candidate === value);
}
