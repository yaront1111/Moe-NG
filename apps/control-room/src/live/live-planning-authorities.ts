import {
  MAX_JSON_BODY_BYTES, MAX_JSON_DEPTH, MAX_JSON_STRING_UTF8_BYTES,
} from "@moe/contracts";
import type { JsonObject, JsonValue } from "@moe/contracts";

import { DEV_PAYLOADS, PLANNING_CHAIN_STEPS } from "./live-dispatch-payloads.js";

/**
 * THE DAEMON'S PER-RUN PLANNING AUTHORITY, READ AS DATA AND BOUND TO ONE OFFER.
 *
 * Graph and plan identity are produced by Node-only codecs the daemon owns
 * (affordance-planning-authorities.ts, over `journeyAuthority`). A browser copy would be a
 * SECOND verifier of the same facts — two spellings of one hash, drifting silently — so this
 * module MINTS NOTHING: it validates a bounded transport shape, checks the two bindings the
 * material carries, snapshots the bodies, and assembles the caller half around bytes it never
 * touches. No hash is computed, canonicalised, rotated, repaired or defaulted here, and no
 * entry is ever picked for the caller — an absent binding is the honest answer.
 *
 * WHY A SIDECAR AND NOT A FRAME MEMBER. `SurfaceFrame` is imported for its TYPE by twenty-odd
 * modules with nothing to do with planning, so widening it would fan this row across all of
 * them. The material lives in a module-owned WeakMap keyed by the exact frozen offer records
 * `frameOfSurface` mints, which also makes caller-supplied authority UNREPRESENTABLE: a
 * structurally identical literal is a different object and carries none.
 */

/** The kinds the daemon keys material by. `goal.close` targets the GOAL, never a run. */
export const PLANNING_AUTHORITY_KINDS: readonly string[] =
  Object.freeze(["approval.decide", "plan.propose"]);

/** The producer's exact seven members — no more, no fewer, checked as a set. */
const ENTRY_KEYS: readonly string[] = Object.freeze([
  "authority", "goalRef", "graphContentBytesBase64", "graphContentHash",
  "graphRevisionRef", "runId", "submissionHash",
]);

const MAX_ENTRIES = 256;
const MAX_ID_BYTES = 512;
const MAX_NODES = 4096;
const HEX64 = /^[0-9a-f]{64}$/u;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;
/** Canonical padding: the discarded bits of the final quantum must be zero. */
const ONE_PAD_TAIL = /[AEIMQUYcgkosw048]=$/u;
const TWO_PAD_TAIL = /[AQgw]==$/u;

interface PlanningMaterial {
  readonly authority: JsonObject;
  readonly goalRef: string;
  readonly graphContentBytesBase64: string;
  readonly graphContentHash: string;
  readonly graphRevisionRef: string;
  readonly runId: string;
  readonly submissionHash: string;
}

interface Budget { bytes: number; nodes: number }

/** No own enumerable DATA property under this key — the accessor case included. */
const ABSENT: unique symbol = Symbol("absent");
const ENCODER = new TextEncoder();

/** UTF-8 length, with a character pre-bound so a hostile megastring is never encoded. */
function utf8Bytes(text: string, limit: number): number {
  return text.length > limit ? limit + 1 : ENCODER.encode(text).length;
}

/**
 * THE ONLY READ IN THE VALIDATION PATH. Plain access would INVOKE an accessor, which is the
 * answered body computing itself against this board; a descriptor read decides without ever
 * running the daemon's code, so "refuses without evaluation" stays literally true.
 */
function ownValue(target: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return ABSENT;
    }
    return descriptor.value;
  } catch {
    return ABSENT;
  }
}

/**
 * A frozen deep COPY of one JSON body, or `undefined` for refusal — never a legitimate JSON
 * member, so an unambiguous sentinel. A cycle terminates on the shared depth bound; accessors,
 * symbol keys, functions, sparse holes, arrays carrying an injected own key and nonfinite
 * numbers all refuse rather than being coerced.
 */
function snapshot(value: unknown, depth: number, budget: Budget): JsonValue | undefined {
  if (depth > MAX_JSON_DEPTH) return undefined;
  budget.nodes += 1;
  if (budget.nodes > MAX_NODES) return undefined;
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    budget.bytes += utf8Bytes(value, MAX_JSON_BODY_BYTES);
    return budget.bytes > MAX_JSON_BODY_BYTES ? undefined : value;
  }
  if (typeof value !== "object") return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    // Own keys are exactly the dense indices plus `length`: a hole or an injected key refuses.
    if (prototype !== Array.prototype) return undefined;
    if (Reflect.ownKeys(value).length !== value.length + 1) return undefined;
    const members: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const member = snapshot(ownValue(value, String(index)), depth + 1, budget);
      if (member === undefined) return undefined;
      members.push(member);
    }
    return Object.freeze(members) as JsonValue;
  }
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const copied: Record<string, JsonValue> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return undefined;
    budget.bytes += utf8Bytes(key, MAX_JSON_BODY_BYTES);
    if (budget.bytes > MAX_JSON_BODY_BYTES) return undefined;
    const member = snapshot(ownValue(value, key), depth + 1, budget);
    if (member === undefined) return undefined;
    copied[key] = member;
  }
  return Object.freeze(copied) as JsonValue;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== undefined && value !== null && typeof value === "object"
    && !Array.isArray(value);
}

function boundedId(value: unknown): string | null {
  return typeof value === "string" && value !== ""
    && utf8Bytes(value, MAX_ID_BYTES) <= MAX_ID_BYTES ? value : null;
}

function lowerHex64(value: unknown): string | null {
  return typeof value === "string" && HEX64.test(value) ? value : null;
}

/**
 * Canonical base64 only. `atob` and `Buffer.from` decode whitespace, the url-safe alphabet and
 * missing padding best-effort, so a lenient reader would carry bytes the daemon's ingress then
 * refuses PLANNING_GRAPH_CONTENT_MALFORMED. Same check, same reason, one round trip earlier.
 */
function canonicalBase64(value: unknown): string | null {
  if (typeof value !== "string" || value === "" || value.length % 4 !== 0) return null;
  if (value.length > MAX_JSON_STRING_UTF8_BYTES || !BASE64.test(value)) return null;
  if (value.endsWith("==")) return TWO_PAD_TAIL.test(value) ? value : null;
  if (value.endsWith("=")) return ONE_PAD_TAIL.test(value) ? value : null;
  return value;
}

/**
 * One run's material, or null. BOTH bindings are checked and neither is repaired: the record
 * must name the run it is filed under, and the goal the daemon separately bound to that run.
 */
function entryOf(
  mapKey: string, raw: unknown, goalRefs: Readonly<Record<string, string>>,
): PlanningMaterial | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(raw);
  if (keys.length !== ENTRY_KEYS.length) return null;
  for (const key of keys) {
    if (typeof key !== "string" || !ENTRY_KEYS.includes(key)) return null;
  }
  const runId = boundedId(ownValue(raw, "runId"));
  const goalRef = boundedId(ownValue(raw, "goalRef"));
  const graphRevisionRef = boundedId(ownValue(raw, "graphRevisionRef"));
  const graphContentHash = lowerHex64(ownValue(raw, "graphContentHash"));
  const submissionHash = lowerHex64(ownValue(raw, "submissionHash"));
  const graphContentBytesBase64 = canonicalBase64(ownValue(raw, "graphContentBytesBase64"));
  if (runId === null || runId !== mapKey || graphRevisionRef === null
    || graphContentHash === null || submissionHash === null
    || graphContentBytesBase64 === null) return null;
  // An unbound run answers ABSENT, which never equals a string, so it refuses here too.
  if (goalRef === null || goalRef !== ownValue(goalRefs, runId)) return null;
  const authority = snapshot(ownValue(raw, "authority"), 1, { bytes: 0, nodes: 0 });
  if (!isJsonObject(authority)) return null;
  return Object.freeze({
    authority, goalRef, graphContentBytesBase64, graphContentHash,
    graphRevisionRef, runId, submissionHash,
  });
}

/** The sidecar. Keyed by the parsed offer itself, so nothing a caller minted can be a key. */
const MATERIAL = new WeakMap<object, PlanningMaterial>();

/**
 * Reads `planningAuthorityByRun` and binds each record to the offers it belongs to. A WHOLLY
 * ABSENT map is optional — a legacy surface still reads, it is simply not authoritative for
 * planning — while any PRESENT value this reader cannot vouch for answers false, and the
 * caller refuses the frame whole rather than binding the half it could read.
 */
export function bindPlanningAuthorities(
  offers: readonly Record<string, unknown>[],
  goalRefs: Readonly<Record<string, string>> | undefined,
  raw: unknown,
): boolean {
  if (raw === undefined || raw === null) return true;
  if (goalRefs === undefined) return false;
  if (typeof raw !== "object" || Array.isArray(raw)) return false;
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(raw);
  if (keys.length > MAX_ENTRIES) return false;
  const byRun = new Map<string, PlanningMaterial>();
  for (const key of keys) {
    if (typeof key !== "string" || boundedId(key) === null) return false;
    const entry = entryOf(key, ownValue(raw, key), goalRefs);
    if (entry === null) return false;
    byRun.set(key, entry);
  }
  for (const offer of offers) {
    if (!PLANNING_AUTHORITY_KINDS.includes(String(offer["commandKind"]))) continue;
    const target = offer["targetAggregateId"];
    const material = typeof target === "string" ? byRun.get(target) : undefined;
    if (material !== undefined) MATERIAL.set(offer, material);
  }
  return true;
}

/** Whether THIS exact offer record carries daemon material. No type escapes the module. */
export function hasPlanningMaterial(offer: unknown): boolean {
  return typeof offer === "object" && offer !== null && MATERIAL.has(offer);
}

/** A member of the frozen snapshot. Plain reads are safe: it holds no accessors by construction. */
function at(body: JsonValue | undefined, ...path: readonly string[]): JsonValue | undefined {
  let cursor = body;
  for (const key of path) {
    if (!isJsonObject(cursor)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

interface PlanIdentity {
  readonly actor: string;
  readonly criteriaRef: string;
  readonly nodeScope: readonly JsonValue[];
  readonly planHash: string;
}

/**
 * The four identities the finalize and the approval restate, all read off the SAME snapshotted
 * authority. Absent or wrongly typed means the board authors nothing: there is no default
 * actor, no first-node scope and no locally derived hash to fall back to.
 */
function identityOf(material: PlanningMaterial): PlanIdentity | null {
  const contract = at(material.authority, "acceptanceContract");
  const actor = at(contract, "authorRef");
  const criteriaRef = at(contract, "criteriaDigest");
  const nodeScope = at(contract, "applicability", "nodeIds");
  const planHash = at(material.authority, "planRevision", "planHash");
  if (typeof actor !== "string" || typeof criteriaRef !== "string"
    || typeof planHash !== "string" || !Array.isArray(nodeScope)) return null;
  return Object.freeze({ actor, criteriaRef, nodeScope, planHash });
}

/**
 * RAIL 3. `journeyAuthority` returns FOUR members and the daemon adds three bindings; none of
 * them is a dependency, quality or policy digest. These are the EXISTING internally consistent
 * placeholders, carried verbatim out of live-dispatch-payloads.ts and deliberately NOT
 * re-derived — relabelling an unrelated digest as one would be fabricated authority.
 */
const DEPENDENCY_HASH_PLACEHOLDER = `d1${"0".repeat(62)}`;
const QUALITY_HASH_PLACEHOLDER = `dd${"0".repeat(62)}`;

/** The sealing chain for one offered run, opened against the goal the daemon bound to it. */
function proposeChain(material: PlanningMaterial): readonly JsonObject[] {
  return [
    {
      commandId: "chain-create", expectedVersion: 0, goalRef: material.goalRef,
      kind: "planning.create_draft", runId: material.runId, runKind: "INITIAL",
    },
    PLANNING_CHAIN_STEPS["ready"] as JsonObject,
    PLANNING_CHAIN_STEPS["claim"] as JsonObject,
    {
      ...(PLANNING_CHAIN_STEPS["propose"] as JsonObject),
      // The daemon's bytes, carried and never re-encoded. `graphContentBytesBase64` is a
      // MANDATORY sibling of `authority`: a propose without it is PLANNING_GRAPH_CONTENT_REQUIRED.
      authority: material.authority,
      graphContentBytesBase64: material.graphContentBytesBase64,
      submissionHash: material.submissionHash,
    },
  ];
}

/**
 * The finalize rides a request of its OWN (a chain holding both terminals is refused
 * PLANNING_FINALIZE_CHAIN_MIXED), and carries the graph HASH but never the bytes — that key is
 * in the daemon's FORBIDDEN_BODY_KEYS and a finalize holding it is refused whole at ingress.
 */
function finalizeChain(
  material: PlanningMaterial, identity: PlanIdentity,
): readonly JsonObject[] {
  const base = PLANNING_CHAIN_STEPS["finalize"] as JsonObject;
  const witness = base["witness"] as JsonObject;
  return [{
    ...base,
    revision: {
      dependencyHash: DEPENDENCY_HASH_PLACEHOLDER,
      graphContentHash: material.graphContentHash,
      graphRevisionRef: material.graphRevisionRef,
      planHash: identity.planHash,
      qualityHash: QUALITY_HASH_PLACEHOLDER,
    },
    witness: {
      ...witness,
      nodeSummaries: identity.nodeScope.map((nodeKey) => ({ executionBearing: true, nodeKey })),
    },
  }];
}

/** The approval's every identity-bearing member, rebound to the same sealed authority. */
function approvalPayload(
  material: PlanningMaterial, identity: PlanIdentity,
): JsonObject | null {
  const base = DEV_PAYLOADS["approval.decide"];
  const activation = base === undefined ? undefined : base["activation"];
  const record = base === undefined ? undefined : base["record"];
  if (base === undefined || !isJsonObject(activation) || !isJsonObject(record)) return null;
  return {
    ...base,
    activation: { ...activation, graphHash: material.graphContentHash },
    graphRevisionRef: material.graphRevisionRef,
    record: {
      ...record,
      actor: identity.actor,
      approvedNodeScope: [...identity.nodeScope],
      criteriaRef: identity.criteriaRef,
      exactRevisionHash: identity.planHash,
    },
    runId: material.runId,
  };
}

/**
 * THE PAYLOAD FOR ONE AUTHORITY-BEARING OFFER, and the only place either kind is authored.
 *
 * Material is looked up by the offer RECORD, so an unbound or caller-minted offer authors
 * nothing; the goal is re-checked against the material's own binding, so a caller cannot pair
 * one run's sealed plan with another run's goal. plan.propose also reads the step's VERSION,
 * because the same card dispatches twice — the sealing chain, then the finalize.
 */
export function planningPayloadFor(
  kind: string, offer: unknown, version: number | null = null,
  planningGoalRef: string | null = null,
): JsonObject | null {
  if (!PLANNING_AUTHORITY_KINDS.includes(kind)) return null;
  if (planningGoalRef === null || planningGoalRef === "") return null;
  const material = typeof offer === "object" && offer !== null
    ? MATERIAL.get(offer)
    : undefined;
  if (material === undefined || material.goalRef !== planningGoalRef) return null;
  const identity = identityOf(material);
  if (identity === null) return null;
  if (kind === "approval.decide") return approvalPayload(material, identity);
  return {
    commands: (version ?? 0) > 0
      ? finalizeChain(material, identity)
      : proposeChain(material),
    runId: material.runId,
  };
}
