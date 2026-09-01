import { createHash } from "node:crypto";
import { types } from "node:util";

import {
  encodeAcceptanceCriteriaContent,
  encodePlanExecutionContent,
  type AcceptanceContractCode,
  type AcceptanceCriteriaContent,
  type PlanRevisionCode,
  type PlanExecutionContent,
} from "@moe/core";
import { decodeBoundedJsonBytes } from "@moe/contracts";

import type { MonotonicPredicateRegistryEntry }
  from "../dependencies/dependency-contract.js";
import {
  hasOnlyOwnStringKeys, isPlainRecord, readOwnDataProperty,
} from "../runtime-shape.js";
import {
  NODE_AUTHORITY_LIMITS, canonicalText,
  type NodeAuthorityEdgeInput, type NodeAuthorityIssueCode, type NodeDependencyEntry,
} from "./node-authority-contract.js";

export const NODE_PLANNING_SOURCE_SCHEMA_VERSION = 1 as const;
const NODE_PLANNING_SOURCE_SCHEMA_TAG = "MOE-NODE-PLANNING-SOURCE/1" as const;
export const NODE_PLANNING_SOURCE_DIGEST_DOMAIN =
  "MOE-NODE-PLANNING-SOURCE-CONTENT-HASH/1" as const;
export const NODE_PLANNING_SOURCE_CODES = Object.freeze([
  "NODE_PLANNING_SOURCE_MALFORMED",
  "NODE_PLANNING_SOURCE_LIMIT_EXCEEDED",
  "NODE_PLANNING_SOURCE_NODE_ROSTER_INVALID",
  "NODE_PLANNING_SOURCE_CRITERIA_MISMATCH",
  "NODE_PLANNING_SOURCE_RECIPE_MISMATCH",
  "NODE_PLANNING_SOURCE_DEPENDENCY_CONSUMER_MISMATCH",
  "NODE_PLANNING_SOURCE_DEPENDENCY_CRITERIA_MISMATCH",
  "NODE_PLANNING_SOURCE_PROOF_ROSTER_INVALID",
  "NODE_PLANNING_SOURCE_NOT_BYTES",
  "NODE_PLANNING_SOURCE_UNREADABLE",
  "NODE_PLANNING_SOURCE_NONCANONICAL",
  "NODE_PLANNING_SOURCE_UNSUPPORTED_SCHEMA",
] as const);
export type NodePlanningSourceCode = (typeof NODE_PLANNING_SOURCE_CODES)[number];
export type NodePlanningSourceIssueCode = NodePlanningSourceCode | AcceptanceContractCode
  | NodeAuthorityIssueCode | PlanRevisionCode;
const LAYER_NAMES = Object.freeze([
  "ACCEPTANCE_CRITERIA_CONTENT",
  "NODE_AUTHORITY",
  "NODE_PLANNING_SOURCE_ADMISSION",
  "NODE_PLANNING_SOURCE_CODEC",
  "NODE_PLANNING_SOURCE_DEPENDENCIES",
  "NODE_PLANNING_SOURCE_IDENTITY",
  "NODE_PLANNING_SOURCE_LIMITS",
  "NODE_PLANNING_SOURCE_PROOFS",
  "NODE_PLANNING_SOURCE_SCHEMA",
  "PLAN_EXECUTION_CONTENT",
] as const);
export type NodePlanningSourceLayer = (typeof LAYER_NAMES)[number];

export interface NodePlanningSourceDependency extends NodeAuthorityEdgeInput {
  readonly requirement: Readonly<{
    readonly contract: NodeDependencyEntry["contract"];
    readonly edgeKind: NodeDependencyEntry["contract"]["edgeKind"];
  }>;
}
export interface NodePlanningSourceContent {
  readonly acceptanceCriterionContent: AcceptanceCriteriaContent;
  readonly directHardDependencies: readonly NodePlanningSourceDependency[];
  readonly planExecutionContent: PlanExecutionContent;
  readonly predicateRegistry: readonly MonotonicPredicateRegistryEntry[];
  readonly version: typeof NODE_PLANNING_SOURCE_SCHEMA_VERSION;
}
export interface NodePlanningSourceIssue {
  readonly code: NodePlanningSourceIssueCode;
  readonly layer: NodePlanningSourceLayer;
  readonly message: string;
}
export type NodePlanningSourceResult = Readonly<{
  readonly content: NodePlanningSourceContent;
  readonly ok: true;
  readonly sourceDigest: string;
}> | NodePlanningSourceRefusal;
export type NodePlanningSourceRefusal = Readonly<{
  readonly issues: readonly NodePlanningSourceIssue[];
  readonly ok: false;
}>;
export type NodePlanningSourceBytesResult = Readonly<{
  readonly bytes: Uint8Array;
  readonly ok: true;
}> | NodePlanningSourceRefusal;

const DEPENDENCY_KEYS = Object.freeze(["directHardDependencies", "predicateRegistry"]);
const ENVELOPE_KEYS = Object.freeze([
  "acceptanceCriterionContentBytesBase64", "dependencyContentBytesBase64",
  "planExecutionContentBytesBase64", "schema",
]);
const encoder = new TextEncoder();

export function refuse(
  code: NodePlanningSourceCode, layer: NodePlanningSourceLayer, message: string,
): NodePlanningSourceRefusal {
  return Object.freeze({
    issues: Object.freeze([Object.freeze({ code, layer, message })]), ok: false as const,
  });
}

export function own(value: object, key: string): unknown {
  const read = readOwnDataProperty(value, key);
  return read.ok && read.present ? read.value : undefined;
}

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
  let dependencies: Uint8Array;
  let bytes: Uint8Array;
  try {
    dependencies = encoder.encode(canonicalText({
      directHardDependencies: content.directHardDependencies,
      predicateRegistry: content.predicateRegistry,
    }));
    bytes = encoder.encode(canonicalText({
      acceptanceCriterionContentBytesBase64:
        Buffer.from(acceptance.bytes).toString("base64"),
      dependencyContentBytesBase64: Buffer.from(dependencies).toString("base64"),
      planExecutionContentBytesBase64: Buffer.from(plan.bytes).toString("base64"),
      schema: NODE_PLANNING_SOURCE_SCHEMA_TAG,
    }));
  } catch { return undefined; }
  const hash = createHash("sha256");
  framed(hash, encoder.encode(NODE_PLANNING_SOURCE_DIGEST_DOMAIN));
  framed(hash, plan.bytes);
  framed(hash, acceptance.bytes);
  framed(hash, dependencies);
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
  if (!exactRecord(decoded.value, ENVELOPE_KEYS)) return refuse(
    "NODE_PLANNING_SOURCE_UNREADABLE", "NODE_PLANNING_SOURCE_CODEC",
    "planning source envelope is malformed",
  );
  if (own(decoded.value, "schema") !== NODE_PLANNING_SOURCE_SCHEMA_TAG) return refuse(
    "NODE_PLANNING_SOURCE_UNSUPPORTED_SCHEMA", "NODE_PLANNING_SOURCE_SCHEMA",
    "planning source wire schema is unsupported",
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
  return Object.freeze({
    acceptanceBytes,
    bytes,
    directHardDependencies: own(dependencies.value, "directHardDependencies"),
    ok: true as const,
    planBytes,
    predicateRegistry: own(dependencies.value, "predicateRegistry"),
  });
}

export const sameNodePlanningSourceBytes = (
  left: Uint8Array, right: Uint8Array,
): boolean => left.length === right.length
  && left.every((byte, index) => byte === right[index]);
