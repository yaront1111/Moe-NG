/**
 * The descriptor-safe field reader for the node authority body and its scope
 * normalizer: the one place a caller-stated draft is judged.
 *
 * Split from the contract vocabulary and from the codec only to keep each
 * production source inside the per-file line cap; the same reason the
 * graph-content family in this package is several files.
 */
import { isGraphKey } from "../graph-key.js";
import {
  hasExactDenseArrayShape, hasOnlyOwnStringKeys, isPlainArray, isPlainRecord,
  readOwnArrayElement, readOwnDataProperty, readPlainArrayLength,
} from "../runtime-shape.js";
import { forbiddenBudgetKeyRefusal, readNodeAuthorityBudget } from "./node-authority-budget.js";
import {
  NODE_AUTHORITY_DRAFT_KEYS, NODE_AUTHORITY_EXCLUDED_STATE_KEYS,
  NODE_AUTHORITY_FORBIDDEN_IDENTITY_KEYS, NODE_AUTHORITY_LIMITS, NODE_JOIN_ROLES,
  compareStrings, deepFreeze, ok, refuse,
} from "./node-authority-contract.js";
import type {
  NodeAuthorityCode, NodeAuthorityDraft, NodeAuthorityDraftResult, NodeAuthorityEdgeInput,
  NodeAuthorityLayer, NodeAuthorityRefusal, NodeJoinRole, Read,
} from "./node-authority-contract.js";

const HEX_64 = /^[0-9a-f]{64}$/u;
const HEX_TREE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SAFE_SCOPE_SEGMENT = /^[A-Za-z0-9_][\w.@+~-]*$/u;
const encoder = new TextEncoder();

export function readText(value: unknown, maximum: number, field: string): Read<string> {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")
    || !value.isWellFormed() || value.normalize("NFC") !== value) {
    return refuse("NODE_AUTHORITY_FIELD_INVALID", "NODE_AUTHORITY_ADMISSION",
      `${field} is not admissible text`);
  }
  return encoder.encode(value).byteLength > maximum
    ? refuse("NODE_AUTHORITY_LIMIT_EXCEEDED", "NODE_AUTHORITY_LIMITS", `${field} exceeds its bound`)
    : ok(value);
}

/**
 * Separator normalization only. Case is PRESERVED: folding it is the
 * locale-dependent operation, and on a case-sensitive tree it would merge two
 * genuinely different scopes into one authority. Absolute, drive-qualified,
 * relative and traversal spellings are refused rather than rewritten.
 */
export function normalizeScope(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")
    || !value.isWellFormed() || value.normalize("NFC") !== value
    || encoder.encode(value).byteLength > NODE_AUTHORITY_LIMITS.maxScopeBytes
    || /^[A-Za-z]:/u.test(value) || value.startsWith("/") || value.startsWith("\\")) return null;
  const segments = value.replaceAll("\\", "/").split("/").filter((part) => part.length > 0);
  return segments.length > 0
    && segments.every((part) => part !== ".." && part !== "." && SAFE_SCOPE_SEGMENT.test(part))
    ? segments.join("/") : null;
}

/** The raw ceiling precedes every element read, so an over-limit list refuses in
 * constant time instead of being traversed by an attacker-chosen length. */
function readList(
  value: unknown, field: string, maximum: number, project: (entry: unknown) => string | null,
  code: NodeAuthorityCode, layer: NodeAuthorityLayer,
): Read<readonly string[]> {
  if (!isPlainArray(value)) {
    return refuse("NODE_AUTHORITY_FIELD_INVALID", "NODE_AUTHORITY_ADMISSION",
      `${field} is not a list`);
  }
  if (value.length > maximum) {
    return refuse("NODE_AUTHORITY_LIMIT_EXCEEDED", "NODE_AUTHORITY_LIMITS",
      `${field} exceeds its bound`);
  }
  const items: string[] = [];
  for (const entry of value) {
    const projected = project(entry);
    if (projected === null) return refuse(code, layer, `${field} holds an inadmissible entry`);
    if (!items.includes(projected)) items.push(projected);
  }
  return ok(Object.freeze(items.sort(compareStrings)));
}

const asId = (entry: unknown): string | null =>
  isGraphKey(entry) && readText(entry, NODE_AUTHORITY_LIMITS.maxIdBytes, "id").ok ? entry : null;
const idList = (value: unknown, field: string): Read<readonly string[]> => readList(
  value, field, NODE_AUTHORITY_LIMITS.maxListEntries, asId,
  "NODE_AUTHORITY_FIELD_INVALID", "NODE_AUTHORITY_ADMISSION");
const scopeList = (value: unknown, field: string): Read<readonly string[]> => readList(
  value, field, NODE_AUTHORITY_LIMITS.maxScopeEntries, normalizeScope,
  "NODE_AUTHORITY_SCOPE_INVALID", "NODE_AUTHORITY_SCOPES");

/**
 * Edge order is normative and is REFUSED rather than repaired: the recursive-hash
 * consumer binds the order this list states, so silently accepting two spellings
 * of one edge set would make that binding ambiguous.
 */
export function readDirectHardDependencies(
  value: unknown,
): Read<readonly NodeAuthorityEdgeInput[]> {
  if (!isPlainArray(value)) {
    return refuse("NODE_AUTHORITY_FIELD_INVALID", "NODE_AUTHORITY_ADMISSION",
      "directHardDependencies is not a list");
  }
  const length = readPlainArrayLength(value);
  if (length === null) {
    return refuse("NODE_AUTHORITY_MALFORMED", "NODE_AUTHORITY_ADMISSION",
      "directHardDependencies has no admissible length");
  }
  if (length > NODE_AUTHORITY_LIMITS.maxDependencyEntries) {
    return refuse("NODE_AUTHORITY_LIMIT_EXCEEDED", "NODE_AUTHORITY_LIMITS",
      "directHardDependencies exceeds its bound");
  }
  if (!hasExactDenseArrayShape(value, length)) {
    return refuse("NODE_AUTHORITY_MALFORMED", "NODE_AUTHORITY_ADMISSION",
      "directHardDependencies is not a dense data-property list");
  }
  const entries: NodeAuthorityEdgeInput[] = [];
  for (let index = 0; index < length; index += 1) {
    const read = readOwnArrayElement(value, index);
    if (!read.ok || !read.present) {
      return refuse("NODE_AUTHORITY_MALFORMED", "NODE_AUTHORITY_ADMISSION",
        "a direct-hard entry is not an own data property");
    }
    const entry = read.value;
    if (!isPlainRecord(entry) || !hasOnlyOwnStringKeys(entry, ["edgeKey", "requirement"])) {
      return refuse("NODE_AUTHORITY_MALFORMED", "NODE_AUTHORITY_ADMISSION",
        "a direct-hard entry is not an exact record");
    }
    const edgeKey = readOwnDataProperty(entry, "edgeKey");
    const requirement = readOwnDataProperty(entry, "requirement");
    if (!edgeKey.ok || !edgeKey.present || !isGraphKey(edgeKey.value)
      || !requirement.ok || !requirement.present) {
      return refuse("NODE_AUTHORITY_FIELD_INVALID", "NODE_AUTHORITY_ADMISSION",
        "a direct-hard entry is invalid");
    }
    const previous = entries.at(-1);
    if (entries.some((held) => held.edgeKey === edgeKey.value)) {
      return refuse("NODE_AUTHORITY_DUPLICATE_EDGE", "NODE_AUTHORITY_DEPENDENCIES",
        "duplicate direct-hard edge key");
    }
    if (previous !== undefined && compareStrings(previous.edgeKey, edgeKey.value) > 0) {
      return refuse("NODE_AUTHORITY_EDGE_ORDER", "NODE_AUTHORITY_DEPENDENCIES",
        "direct-hard entries are not sorted by edge key");
    }
    entries.push({ edgeKey: edgeKey.value, requirement: requirement.value });
  }
  return ok(Object.freeze(entries));
}

export function forbiddenKeyRefusal(value: object): NodeAuthorityRefusal | null {
  for (const key of NODE_AUTHORITY_FORBIDDEN_IDENTITY_KEYS) {
    if (Object.hasOwn(value, key)) {
      return refuse("NODE_AUTHORITY_CALLER_DIGEST_FORBIDDEN", "NODE_AUTHORITY_ADMISSION",
        `caller-stated ${key} is derived authority and is never accepted`);
    }
  }
  for (const key of NODE_AUTHORITY_EXCLUDED_STATE_KEYS) {
    if (Object.hasOwn(value, key)) {
      return refuse("NODE_AUTHORITY_EXCLUDED_FIELD", "NODE_AUTHORITY_ADMISSION",
        `${key} is excluded from the execution contract`);
    }
  }
  return forbiddenBudgetKeyRefusal(value);
}

/**
 * Every field is read exactly once through a descriptor read that refuses
 * accessors: a getter answering differently between admission and hashing would
 * let hostile input be judged as one value and digested as another.
 */
export function readDraftFields(
  value: unknown, allowed: readonly string[] = NODE_AUTHORITY_DRAFT_KEYS,
): NodeAuthorityDraftResult {
  if (!isPlainRecord(value)) {
    return refuse("NODE_AUTHORITY_MALFORMED", "NODE_AUTHORITY_ADMISSION",
      "draft is not a plain record");
  }
  const forbidden = forbiddenKeyRefusal(value);
  if (forbidden !== null) return forbidden;
  if (!hasOnlyOwnStringKeys(value, allowed)) {
    return refuse("NODE_AUTHORITY_MALFORMED", "NODE_AUTHORITY_ADMISSION",
      "draft carries an unrecognised field");
  }
  const read = new Map<string, unknown>();
  for (const key of NODE_AUTHORITY_DRAFT_KEYS) {
    const property = readOwnDataProperty(value, key);
    if (!property.ok || !property.present) {
      return refuse("NODE_AUTHORITY_MALFORMED", "NODE_AUTHORITY_ADMISSION",
        `${key} is absent or not a data property`);
    }
    read.set(key, property.value);
  }
  return assembleDraft(read);
}

function assembleDraft(read: ReadonlyMap<string, unknown>): NodeAuthorityDraftResult {
  const objective = readText(
    read.get("objective"), NODE_AUTHORITY_LIMITS.maxObjectiveBytes, "objective",
  );
  const constraints = idList(read.get("constraints"), "constraints");
  const resources = idList(read.get("resources"), "resources");
  const recipes = idList(read.get("verificationRecipeRevisions"), "verificationRecipeRevisions");
  const readScopes = scopeList(read.get("readScopes"), "readScopes");
  const writeScopes = scopeList(read.get("writeScopes"), "writeScopes");
  const edges = readDirectHardDependencies(read.get("directHardDependencies"));
  if (!objective.ok) return objective;
  if (!constraints.ok) return constraints;
  if (!resources.ok) return resources;
  if (!recipes.ok) return recipes;
  if (!readScopes.ok) return readScopes;
  if (!writeScopes.ok) return writeScopes;
  if (!edges.ok) return edges;
  const budget = readNodeAuthorityBudget(
    read.get("admissionAmounts"), read.get("admissionGatePolicy"),
  );
  if (!budget.ok) return budget;
  const linkage = read.get("completionLinkage");
  const role = read.get("joinRole");
  const nodeKey = read.get("nodeKey");
  const policySliceHash = read.get("policySliceHash");
  const repositoryBaseTree = read.get("repositoryBaseTree");
  if (!isGraphKey(nodeKey) || !isGraphKey(read.get("capability"))
    || typeof policySliceHash !== "string" || !HEX_64.test(policySliceHash)
    || typeof repositoryBaseTree !== "string" || !HEX_TREE.test(repositoryBaseTree)
    || !(NODE_JOIN_ROLES as readonly unknown[]).includes(role)
    || (linkage !== null && !isGraphKey(linkage))) {
    return refuse("NODE_AUTHORITY_FIELD_INVALID", "NODE_AUTHORITY_ADMISSION",
      "a stated field is absent, malformed or out of vocabulary");
  }
  const linkageOk = role === "NONE" ? linkage === null
    : role === "COMPLETION" ? linkage === nodeKey : linkage !== null;
  if (!linkageOk) {
    return refuse("NODE_AUTHORITY_JOIN_LINKAGE_INVALID", "NODE_AUTHORITY_ADMISSION",
      "completion linkage does not match the join role");
  }
  return {
    ok: true as const,
    draft: deepFreeze<NodeAuthorityDraft>({
      admissionAmounts: budget.value.admissionAmounts,
      admissionGatePolicy: budget.value.admissionGatePolicy,
      capability: read.get("capability") as string,
      completionLinkage: linkage as string | null, constraints: constraints.value,
      directHardDependencies: edges.value, joinRole: role as NodeJoinRole, nodeKey,
      objective: objective.value, policySliceHash, readScopes: readScopes.value,
      repositoryBaseTree, resources: resources.value, verificationRecipeRevisions: recipes.value,
      writeScopes: writeScopes.value,
    }),
  };
}
