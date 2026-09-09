import type { AcceptanceContractCode, PlanRevisionCode } from "@moe/core";

import { isGraphKey } from "../graph-key.js";
import {
  hasExactDenseArrayShape, isPlainArray, readOwnArrayElement, readOwnDataProperty,
  readPlainArrayLength,
} from "../runtime-shape.js";
import {
  NODE_AUTHORITY_LIMITS, type NodeAuthorityIssueCode,
} from "./node-authority-contract.js";
import { readText } from "./node-authority-fields.js";

/**
 * A SET, not a point, for the same reason the node authority carries one: version 1
 * predates `declaredMigrations` and every source already in the store is spelled at
 * it. The CURRENT version is the highest one that can be minted; the UNDECLARED
 * version is what a source stating nothing keeps forever. Neither is ever supplied
 * by a caller — `nodePlanningSourceVersionOf` chooses by content, which is the
 * pattern node-authority-codec.ts:127 uses one layer down.
 */
export const NODE_PLANNING_SOURCE_UNDECLARED_SCHEMA_VERSION = 1 as const;
export const NODE_PLANNING_SOURCE_SCHEMA_VERSION = 2 as const;
export type NodePlanningSourceSchemaVersion =
  | typeof NODE_PLANNING_SOURCE_UNDECLARED_SCHEMA_VERSION
  | typeof NODE_PLANNING_SOURCE_SCHEMA_VERSION;
export const NODE_PLANNING_SOURCE_SCHEMA_TAGS:
Readonly<Record<NodePlanningSourceSchemaVersion, string>> = Object.freeze({
  1: "MOE-NODE-PLANNING-SOURCE/1", 2: "MOE-NODE-PLANNING-SOURCE/2",
});
export const NODE_PLANNING_SOURCE_DIGEST_DOMAINS:
Readonly<Record<NodePlanningSourceSchemaVersion, string>> = Object.freeze({
  1: "MOE-NODE-PLANNING-SOURCE-CONTENT-HASH/1", 2: "MOE-NODE-PLANNING-SOURCE-CONTENT-HASH/2",
});
/**
 * PUBLISHED AND DELIBERATELY STILL THE VERSION-1 DOMAIN, byte for byte. Its value
 * is what every stored source's digest was computed under, so moving it would make
 * a published constant disagree with every durable identity derived from it. The
 * declaring domain is `NODE_PLANNING_SOURCE_DIGEST_DOMAINS[2]` and the package root
 * withholds it for the reason `NODE_AUTHORITY_UNDECLARED_SCHEMA_VERSION` is
 * withheld: a reader distinguishes a declaring source by the member's PRESENCE,
 * never by re-deriving a domain, and minting happens only inside this package.
 */
export const NODE_PLANNING_SOURCE_DIGEST_DOMAIN = NODE_PLANNING_SOURCE_DIGEST_DOMAINS[1];

export const NODE_PLANNING_SOURCE_CODES = Object.freeze([
  "NODE_PLANNING_SOURCE_MALFORMED",
  "NODE_PLANNING_SOURCE_LIMIT_EXCEEDED",
  "NODE_PLANNING_SOURCE_DUPLICATE_MIGRATION",
  "NODE_PLANNING_SOURCE_SCHEMA_MISMATCH",
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

export interface NodePlanningSourceIssue {
  readonly code: NodePlanningSourceIssueCode;
  readonly layer: NodePlanningSourceLayer;
  readonly message: string;
}
export type NodePlanningSourceRefusal = Readonly<{
  readonly issues: readonly NodePlanningSourceIssue[];
  readonly ok: false;
}>;

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

export const NODE_PLANNING_SOURCE_DECLARED_MIGRATIONS_KEY = "declaredMigrations";
/**
 * ITS OWN ENVELOPE KEY, not a member of the dependency blob. The declaration is not
 * dependency material: burying it inside `dependencyContentBytesBase64` would make
 * that key's name a lie and force every reader of the dependency component to know
 * about a field with nothing to do with edges. A distinct key also gives ABSENCE a
 * spelling on the durable wire — the key is simply not there — which is exactly the
 * UNKNOWN-vs-explicit-empty distinction one layer down, expressed in bytes.
 */
export const NODE_PLANNING_SOURCE_DECLARED_MIGRATIONS_ENVELOPE_KEY =
  "declaredMigrationsBytesBase64";

/** The version is chosen by CONTENT and never stated by a caller. */
export function nodePlanningSourceVersionOf(
  declaredMigrations: readonly string[] | undefined,
): NodePlanningSourceSchemaVersion {
  return declaredMigrations === undefined
    ? NODE_PLANNING_SOURCE_UNDECLARED_SCHEMA_VERSION : NODE_PLANNING_SOURCE_SCHEMA_VERSION;
}

const admissibleIdentifier = (entry: unknown): entry is string =>
  isGraphKey(entry) && readText(entry, NODE_AUTHORITY_LIMITS.maxIdBytes, "id").ok;

/**
 * The source-layer twin of `readDeclaredMigrations` (node-authority-fields.ts:98).
 * ORDER IS PRESERVED AND A DUPLICATE REFUSES — deliberately NOT the generic list
 * reader, which dedups and sorts, because two admissible spellings that differ only
 * in order are two different declarations and the digest binds that difference.
 * The bound and the entry admission are the AUTHORITY's, reused rather than
 * restated, so the two layers cannot drift into disagreeing about the same value.
 * The CODES are this layer's own: sharing the authority's would leave an arm unable
 * to tell which layer answered, and only this layer sees an unadmitted source.
 */
export function readSourceDeclaredMigrations(
  value: unknown,
): Readonly<{ ok: true; value: readonly string[] }> | NodePlanningSourceRefusal {
  if (!isPlainArray(value)) {
    return refuse("NODE_PLANNING_SOURCE_MALFORMED", "NODE_PLANNING_SOURCE_ADMISSION",
      "declaredMigrations is not a list");
  }
  const length = readPlainArrayLength(value);
  if (length === null || length > NODE_AUTHORITY_LIMITS.maxMigrationEntries) {
    return refuse("NODE_PLANNING_SOURCE_LIMIT_EXCEEDED", "NODE_PLANNING_SOURCE_LIMITS",
      "declaredMigrations exceeds its bound");
  }
  if (!hasExactDenseArrayShape(value, length)) {
    return refuse("NODE_PLANNING_SOURCE_MALFORMED", "NODE_PLANNING_SOURCE_ADMISSION",
      "declaredMigrations holds an inadmissible entry");
  }
  const declared: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const entry = readOwnArrayElement(value, index);
    if (!entry.ok || !entry.present || !admissibleIdentifier(entry.value)) {
      return refuse("NODE_PLANNING_SOURCE_MALFORMED", "NODE_PLANNING_SOURCE_ADMISSION",
        "declaredMigrations holds an inadmissible entry");
    }
    if (declared.includes(entry.value)) {
      return refuse("NODE_PLANNING_SOURCE_DUPLICATE_MIGRATION", "NODE_PLANNING_SOURCE_ADMISSION",
        "declaredMigrations states one identifier twice");
    }
    declared.push(entry.value);
  }
  return Object.freeze({ ok: true as const, value: Object.freeze(declared) });
}
