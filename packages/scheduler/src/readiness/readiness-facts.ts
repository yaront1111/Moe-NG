/**
 * Caller-supplied readiness FACTS: what is known about one node, never what is
 * ready. Readiness derivation lives in ./readiness-projection.ts.
 *
 * @moe/scheduler declares no dependencies, so nothing here reaches for a
 * materializer, a policy engine, or a lease store. Dependency truth, the
 * NodeInputManifest binding, policy, budget, capability, resources, leases and
 * holds all arrive as DATA and are structurally validated with the hostile-
 * input helpers this package already uses (see ./readiness-fact-shapes.ts).
 *
 * The one rule everything else follows from: absent, malformed, wrong-typed or
 * stale truth is UNKNOWN. `CONFIRMED_FALSE` is a positive claim; producing one
 * the caller never made would turn "nobody knows" into "definitively blocked".
 */
import { dense, deepFreeze, oneOf, record } from "../admission/admission-model.js";
import {
  validateIntentionalWait,
  type IntentionalWait,
} from "../admission/admission-wait.js";
import {
  DEPENDENCY_GATES,
  type DependencyGate,
} from "../dependencies/dependency-contract.js";
import { isWithinHorizon } from "../dependencies/dependency-witness.js";
import { isGraphKey } from "../graph-key.js";
import type { GraphKey } from "../graph-model.js";
import {
  BUNDLE_KEYS,
  BUNDLE_REQUIRED,
  parseCurrentVersions,
  parseRawFact,
  type RawReadinessFact,
} from "./readiness-fact-shapes.js";
import {
  ADMISSION_REASON_CODES,
  CALLER_FACT_CODES,
  DISPATCH_REASON_CODES,
  READINESS_REASON_LAYERS,
  type CallerFactCode,
  type FactConfidence,
  type ReadinessLayer,
  type ReadinessProvenance,
} from "./readiness-model.js";

/** One caller predicate after classification. Always exactly one per code. */
export interface ReadinessPredicateFact {
  readonly code: CallerFactCode;
  readonly layer: ReadinessLayer;
  readonly confidence: FactConfidence;
  readonly provenance: ReadinessProvenance;
  /** Producer node or recovery command; `null` means it is not known. */
  readonly recoveryRef: string | null;
}

export interface NodeReadinessFacts {
  readonly nodeKey: GraphKey;
  readonly currentGate: DependencyGate;
  /** One entry per CALLER_FACT_CODES member, ordered by code. */
  readonly predicates: readonly ReadinessPredicateFact[];
  readonly admission: FactConfidence;
  readonly dispatch: FactConfidence;
  /** Non-null only when a well-formed wait record is still CURRENT. */
  readonly wait: IntentionalWait | null;
  readonly waitCurrent: boolean;
}

/**
 * Classify one attributed entry. Every failure mode collapses to UNKNOWN; the
 * caller's own `CONFIRMED_FALSE` is the only route to CONFIRMED_FALSE.
 */
function classify(
  raw: RawReadinessFact,
  currentGate: DependencyGate,
  currentVersions: ReadonlyMap<string, number>,
): FactConfidence {
  if (raw.provenance === null || !isWithinHorizon(currentGate, raw.horizonGate)) {
    return "UNKNOWN";
  }
  const current = currentVersions.get(raw.provenance.sourceFactRef);
  if (current !== undefined && current !== raw.provenance.sourceFactVersion) {
    return "UNKNOWN";
  }
  return raw.confidence === "CONFIRMED_TRUE" || raw.confidence === "CONFIRMED_FALSE"
    ? raw.confidence
    : "UNKNOWN";
}

/**
 * Three-valued AND. CONFIRMED_FALSE outranks UNKNOWN: a confirmed-false
 * predicate settles the layer no matter what else is unknown, and reporting
 * UNKNOWN there would be weaker than the truth the caller actually supplied.
 */
function fold(
  predicates: readonly ReadinessPredicateFact[],
  codes: readonly CallerFactCode[],
): FactConfidence {
  const wanted = new Set<string>(codes);
  let sawUnknown = false;
  for (const predicate of predicates) {
    if (!wanted.has(predicate.code)) {
      continue;
    }
    if (predicate.confidence === "CONFIRMED_FALSE") {
      return "CONFIRMED_FALSE";
    }
    sawUnknown ||= predicate.confidence === "UNKNOWN";
  }
  return sawUnknown ? "UNKNOWN" : "CONFIRMED_TRUE";
}

function classifyAll(
  raw: ReadonlyMap<CallerFactCode, RawReadinessFact>,
  currentGate: DependencyGate,
  currentVersions: ReadonlyMap<string, number>,
): ReadinessPredicateFact[] {
  const predicates: ReadinessPredicateFact[] = [];
  for (const code of [...CALLER_FACT_CODES].sort()) {
    const supplied = raw.get(code);
    predicates.push({
      code,
      layer: READINESS_REASON_LAYERS[code],
      confidence: supplied === undefined
        ? "UNKNOWN"
        : classify(supplied, currentGate, currentVersions),
      provenance: supplied?.provenance ?? null,
      recoveryRef: supplied?.recoveryRef ?? null,
    });
  }
  return predicates;
}

/**
 * Parse one node's fact bundle. Returns `null` on a structurally unusable
 * bundle so the caller chooses the stable issue code and layer, which is the
 * parse-then-code convention already used across this package.
 */
export function parseNodeReadinessFacts(input: unknown): NodeReadinessFacts | null {
  const item = record(input, BUNDLE_KEYS, BUNDLE_REQUIRED);
  if (
    item === null ||
    !isGraphKey(item["nodeKey"]) ||
    !oneOf(item["currentGate"], DEPENDENCY_GATES)
  ) {
    return null;
  }
  const currentGate = item["currentGate"];
  const currentVersions = parseCurrentVersions(item["currentFactVersions"]);
  const entries = dense(item["facts"]);
  if (currentVersions === null || entries === null) {
    return null;
  }

  const raw = new Map<CallerFactCode, RawReadinessFact>();
  for (const entry of entries) {
    const parsed = parseRawFact(entry);
    if (parsed === null || raw.has(parsed.code)) {
      return null;
    }
    raw.set(parsed.code, parsed);
  }

  const predicates = classifyAll(raw, currentGate, currentVersions);
  const validated = validateIntentionalWait(item["wait"]);
  const waitCurrent = validated.ok
    && isWithinHorizon(currentGate, validated.wait.deadlineGate);
  return deepFreeze({
    nodeKey: item["nodeKey"],
    currentGate,
    predicates,
    admission: fold(predicates, ADMISSION_REASON_CODES),
    dispatch: fold(predicates, DISPATCH_REASON_CODES),
    wait: waitCurrent && validated.ok ? validated.wait : null,
    waitCurrent,
  });
}
