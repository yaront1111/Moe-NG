import { createHash } from "node:crypto";
import { types } from "node:util";

import {
  encodeAcceptanceCriteriaContent,
  encodePlanExecutionContent,
  type AcceptanceCriteriaContent,
  type PlanExecutionContent,
} from "@moe/core";
import { decodeBoundedJsonBytes } from "@moe/contracts";

import type { MonotonicPredicateRegistryEntry }
  from "../dependencies/dependency-contract.js";
import { hasOnlyOwnStringKeys, isPlainRecord } from "../runtime-shape.js";
import {
  NODE_AUTHORITY_LIMITS, canonicalText,
  type NodeAuthorityEdgeInput, type NodeDependencyEntry,
} from "./node-authority-contract.js";
import {
  NODE_PLANNING_SOURCE_DECLARED_MIGRATIONS_ENVELOPE_KEY as DECLARED_MIGRATIONS_ENVELOPE_KEY,
  NODE_PLANNING_SOURCE_DECLARED_MIGRATIONS_KEY as DECLARED_MIGRATIONS_KEY,
  NODE_PLANNING_SOURCE_DIGEST_DOMAINS as DIGEST_DOMAINS,
  NODE_PLANNING_SOURCE_SCHEMA_TAGS as SCHEMA_TAGS,
  nodePlanningSourceVersionOf,
  own,
  refuse,
  type NodePlanningSourceRefusal,
  type NodePlanningSourceSchemaVersion,
} from "./node-planning-source-schema.js";

/**
 * The codes, layers, versions, tags, digest domains, refusal constructor and the
 * declaration reader live in `node-planning-source-schema.ts` and are re-exported
 * here so every existing importer of this module keeps its specifier. The split is
 * the 400-line cap, not a new seam: this module owns the WIRE, that one owns the
 * VOCABULARY the wire is spelled in.
 */
export * from "./node-planning-source-schema.js";

export interface NodePlanningSourceDependency extends NodeAuthorityEdgeInput {
  readonly requirement: Readonly<{
    readonly contract: NodeDependencyEntry["contract"];
    readonly edgeKind: NodeDependencyEntry["contract"]["edgeKind"];
  }>;
}
export interface NodePlanningSourceContent {
  readonly acceptanceCriterionContent: AcceptanceCriteriaContent;
  /**
   * OPTIONAL, and the absence is load-bearing: ABSENT means the source predates the
   * member or its author stated nothing knowable, `[]` means the author stated that
   * this node declares NO migration. Defaulting absent to `[]` would mint a
   * declaration nobody authored. `authority-contracts.ts:74` derives
   * `V2CompilerNodePlanningAuthority = Omit<NodePlanningSourceContent, "version">`
   * from this type, so the compiler reads exactly this shape and inherits the
   * optionality rather than restating it.
   */
  readonly declaredMigrations?: readonly string[];
  readonly directHardDependencies: readonly NodePlanningSourceDependency[];
  readonly planExecutionContent: PlanExecutionContent;
  readonly predicateRegistry: readonly MonotonicPredicateRegistryEntry[];
  readonly version: NodePlanningSourceSchemaVersion;
}
export type NodePlanningSourceResult = Readonly<{
  readonly content: NodePlanningSourceContent;
  readonly ok: true;
  readonly sourceDigest: string;
}> | NodePlanningSourceRefusal;
export type NodePlanningSourceBytesResult = Readonly<{
  readonly bytes: Uint8Array;
  readonly ok: true;
}> | NodePlanningSourceRefusal;

const DEPENDENCY_KEYS = Object.freeze(["directHardDependencies", "predicateRegistry"]);
const ENVELOPE_KEYS = Object.freeze([
  "acceptanceCriterionContentBytesBase64", "dependencyContentBytesBase64",
  "planExecutionContentBytesBase64", "schema",
]);
const DECLARING_ENVELOPE_KEYS = Object.freeze([
  ...ENVELOPE_KEYS, DECLARED_MIGRATIONS_ENVELOPE_KEY,
]);
const encoder = new TextEncoder();

function framed(hash: ReturnType<typeof createHash>, bytes: Uint8Array): void {
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  hash.update(length).update(bytes);
}

export interface NodePlanningSourceWire {
  readonly bytes: Uint8Array;
  readonly sourceDigest: string;
}

/** Core owns its two byte streams; this format owns only the dependency stream and framing. */
export function nodePlanningSourceWireOf(
  content: NodePlanningSourceContent,
): NodePlanningSourceWire | undefined {
  const plan = encodePlanExecutionContent(content.planExecutionContent);
  const acceptance = encodeAcceptanceCriteriaContent(content.acceptanceCriterionContent);
  if (!plan.ok || !acceptance.ok) return undefined;
  // Not `content.version`: the version rides the CONTENT, so a caller that supplied
  // a version could frame a declaring source with the version-1 tag and domain.
  const declared = content.declaredMigrations;
  const version = nodePlanningSourceVersionOf(declared);
  let dependencies: Uint8Array;
  let migrations: Uint8Array | undefined;
  let bytes: Uint8Array;
  try {
    dependencies = encoder.encode(canonicalText({
      directHardDependencies: content.directHardDependencies,
      predicateRegistry: content.predicateRegistry,
    }));
    migrations = declared === undefined
      ? undefined
      : encoder.encode(canonicalText({ [DECLARED_MIGRATIONS_KEY]: declared }));
    bytes = encoder.encode(canonicalText({
      acceptanceCriterionContentBytesBase64:
        Buffer.from(acceptance.bytes).toString("base64"),
      // Spread, never an assigned `undefined`: `canonicalText` throws on undefined
      // and an own key holding it is not an absent key to `Object.keys`.
      ...(migrations === undefined ? {} : {
        [DECLARED_MIGRATIONS_ENVELOPE_KEY]: Buffer.from(migrations).toString("base64"),
      }),
      dependencyContentBytesBase64: Buffer.from(dependencies).toString("base64"),
      planExecutionContentBytesBase64: Buffer.from(plan.bytes).toString("base64"),
      schema: SCHEMA_TAGS[version],
    }));
  } catch { return undefined; }
  const hash = createHash("sha256");
  framed(hash, encoder.encode(DIGEST_DOMAINS[version]));
  framed(hash, plan.bytes);
  framed(hash, acceptance.bytes);
  framed(hash, dependencies);
  // Framed LAST and only when stated, so a source that declares nothing hashes over
  // exactly the three segments it always did, under exactly the domain it always did.
  if (migrations !== undefined) framed(hash, migrations);
  return Object.freeze({ bytes, sourceDigest: hash.digest("hex") });
}

function copyBytes(value: unknown): Uint8Array | undefined {
  try {
    return typeof value === "object" && value !== null && !types.isProxy(value)
      && types.isUint8Array(value) ? new Uint8Array(value as Uint8Array) : undefined;
  } catch { return undefined; }
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isPlainRecord(value) && hasOnlyOwnStringKeys(value, keys)
    && keys.every((key) => own(value, key) !== undefined);
}

function base64Bytes(value: unknown): Uint8Array | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    const bytes = new Uint8Array(Buffer.from(value, "base64"));
    return Buffer.from(bytes).toString("base64") === value ? bytes : undefined;
  } catch { return undefined; }
}

export interface NodePlanningSourceWireContent {
  readonly acceptanceBytes: Uint8Array;
  readonly bytes: Uint8Array;
  /** ABSENT when the wire states none; the codec must not turn that into `[]`. */
  readonly declaredMigrations?: unknown;
  readonly directHardDependencies: unknown;
  readonly ok: true;
  readonly planBytes: Uint8Array;
  readonly predicateRegistry: unknown;
}
export type NodePlanningSourceWireReadResult =
  | NodePlanningSourceWireContent
  | NodePlanningSourceRefusal;

export function readNodePlanningSourceWire(value: unknown): NodePlanningSourceWireReadResult {
  const bytes = copyBytes(value);
  if (bytes === undefined) return refuse(
    "NODE_PLANNING_SOURCE_NOT_BYTES", "NODE_PLANNING_SOURCE_CODEC", "input is not bytes",
  );
  if (bytes.length > NODE_AUTHORITY_LIMITS.maxBytes) return refuse(
    "NODE_PLANNING_SOURCE_LIMIT_EXCEEDED", "NODE_PLANNING_SOURCE_LIMITS",
    "planning source bytes exceed their ceiling",
  );
  const decoded = decodeBoundedJsonBytes(bytes);
  if (!decoded.ok) return refuse(
    "NODE_PLANNING_SOURCE_UNREADABLE", "NODE_PLANNING_SOURCE_CODEC", decoded.code,
  );
  const declaring = exactRecord(decoded.value, DECLARING_ENVELOPE_KEYS);
  if (!declaring && !exactRecord(decoded.value, ENVELOPE_KEYS)) return refuse(
    "NODE_PLANNING_SOURCE_UNREADABLE", "NODE_PLANNING_SOURCE_CODEC",
    "planning source envelope is malformed",
  );
  const tag = own(decoded.value, "schema");
  if (tag !== SCHEMA_TAGS[1] && tag !== SCHEMA_TAGS[2]) return refuse(
    "NODE_PLANNING_SOURCE_UNSUPPORTED_SCHEMA", "NODE_PLANNING_SOURCE_SCHEMA",
    "planning source wire schema is unsupported",
  );
  // The tag and the envelope roster must agree, and the disagreement is NOT merely
  // noncanonical: the declaration key is the whole reason the version moved, so a
  // v2 tag over a v1 envelope is a schema the reader has to be able to name.
  if (declaring !== (tag === SCHEMA_TAGS[2])) return refuse(
    "NODE_PLANNING_SOURCE_SCHEMA_MISMATCH", "NODE_PLANNING_SOURCE_SCHEMA",
    "planning source wire schema disagrees with its envelope",
  );
  const planBytes = base64Bytes(own(decoded.value, "planExecutionContentBytesBase64"));
  const acceptanceBytes = base64Bytes(
    own(decoded.value, "acceptanceCriterionContentBytesBase64"),
  );
  const dependencyBytes = base64Bytes(own(decoded.value, "dependencyContentBytesBase64"));
  if (planBytes === undefined || acceptanceBytes === undefined || dependencyBytes === undefined) {
    return refuse("NODE_PLANNING_SOURCE_UNREADABLE", "NODE_PLANNING_SOURCE_CODEC",
      "planning source components are not canonical base64");
  }
  const dependencies = decodeBoundedJsonBytes(dependencyBytes);
  if (!dependencies.ok || !exactRecord(dependencies.value, DEPENDENCY_KEYS)) return refuse(
    "NODE_PLANNING_SOURCE_UNREADABLE", "NODE_PLANNING_SOURCE_CODEC",
    "planning source dependency component is malformed",
  );
  const declared = declaring
    ? readDeclaredComponent(own(decoded.value, DECLARED_MIGRATIONS_ENVELOPE_KEY))
    : undefined;
  if (declared !== undefined && !declared.ok) return declared;
  return Object.freeze({
    acceptanceBytes,
    bytes,
    // Spread: a wire that states none must not arrive carrying an own key holding
    // `undefined`, which the codec's re-encode would treat as a stated declaration.
    ...(declared === undefined ? {} : { declaredMigrations: declared.value }),
    directHardDependencies: own(dependencies.value, "directHardDependencies"),
    ok: true as const,
    planBytes,
    predicateRegistry: own(dependencies.value, "predicateRegistry"),
  });
}

function readDeclaredComponent(
  value: unknown,
): Readonly<{ ok: true; value: unknown }> | NodePlanningSourceRefusal {
  const bytes = base64Bytes(value);
  const decoded = bytes === undefined ? undefined : decodeBoundedJsonBytes(bytes);
  if (decoded === undefined || !decoded.ok
    || !exactRecord(decoded.value, [DECLARED_MIGRATIONS_KEY])) {
    return refuse("NODE_PLANNING_SOURCE_UNREADABLE", "NODE_PLANNING_SOURCE_CODEC",
      "planning source declared-migration component is malformed");
  }
  return Object.freeze({ ok: true as const, value: own(decoded.value, DECLARED_MIGRATIONS_KEY) });
}

export const sameNodePlanningSourceBytes = (
  left: Uint8Array, right: Uint8Array,
): boolean => left.length === right.length
  && left.every((byte, index) => byte === right[index]);
