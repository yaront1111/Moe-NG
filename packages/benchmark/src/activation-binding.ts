/**
 * GO_ACTIVATE binding admission. THIS MODULE ADMITS A BINDING AND PERFORMS NO ACTIVATION:
 * nothing here writes an activation marker, moves a lifecycle, or grants a success verdict.
 * An admitted binding is a statement that a named human bound one exact quiesce/import/backup/
 * distribution generation to one source commit — the act itself belongs to a later, gated row.
 *
 * WHY TODAY'S STANDING AUTHORIZATION REFUSES. The board currently holds a real human
 * authorization that names no generations. It arrives here as a valid gate over four empty
 * digests and is refused ACTIVATION_BINDING_GENERATION_UNBOUND. A standing authorization is
 * permission to proceed when the evidence exists; it is not the evidence, and admitting it
 * would let an activation inherit authority from a decision that saw none of it.
 *
 * WHY DECISION_MISMATCH ANSWERS BEFORE THE HUMAN GATE. A GO_QUIESCE record carries a REAL
 * human grant — for a DIFFERENT decision. If the gate answered first, that grant would be
 * consulted and would pass, and only a later check would notice the decision was the wrong
 * one. Refusing on decision kind first keeps GO_QUIESCE and GO_ACTIVATE separate at the
 * earliest possible point, which is what task rail 4 and DoD-2 require.
 *
 * WHY THE POLICY IS HARD-WIRED. `REQUIRE_HUMAN_POLICY` is module-private and this function
 * takes ONE argument, so no caller can present a `PROCEED_WITHOUT_HUMAN` policy — an extra
 * `policy` key is refused as SHAPE_INVALID before anything reads it. Combined with the shape
 * check rejecting a missing `authority`, the decider always receives a non-null gate and
 * therefore always consults the human check first (approval-policy.ts:130-137), so the
 * null-gate fall-through that the acceptance-binding precedent warns about
 * (packages/core/src/product-contract/product-contract-acceptance-binding.ts:4-13) is
 * unreachable from here.
 *
 * The human verdict is core's. `decideApprovalAuthority` is the published route;
 * `checkHumanAuthority` is unpublished on purpose (packages/core/src/index.ts:239-244) and a
 * consumer that could call it could decide whether to honour the answer. Its refusals are
 * returned VERBATIM, code and layer intact, never re-stamped with this module's layer.
 */
import { decideApprovalAuthority } from "@moe/core";
import type { ApprovalAuthorityRefusal, HumanAuthorityGate } from "@moe/core";

export const GA_ACTIVATION_BINDING_LAYER = "GA_ACTIVATION_BINDING" as const;

export const GA_ACTIVATION_BINDING_CODES = Object.freeze([
  "ACTIVATION_BINDING_ABSENT",
  "ACTIVATION_BINDING_SHAPE_INVALID",
  "ACTIVATION_BINDING_DECISION_MISMATCH",
  "ACTIVATION_BINDING_WORK_MISMATCH",
  "ACTIVATION_BINDING_GENERATION_UNBOUND",
] as const);

export type ActivationBindingCode = (typeof GA_ACTIVATION_BINDING_CODES)[number];
export type ActivationBindingLayer = typeof GA_ACTIVATION_BINDING_LAYER;

export const GO_ACTIVATE_GATE_ID = "GO_ACTIVATE" as const;
export const GA_ACTIVATION_WORK_REF = "task-09008b4cb39c4a15aa661540d20e9b9b" as const;

/** Every generation an activation must name. All four, or the binding is not a binding. */
export const ACTIVATION_GENERATION_KEYS = Object.freeze([
  "backupGenerationDigest",
  "distributionManifestSha256",
  "importGenerationSha256",
  "quiesceRecordSha256",
] as const);

export type ActivationGenerationKey = (typeof ACTIVATION_GENERATION_KEYS)[number];

export interface ActivationBinding {
  readonly authority: HumanAuthorityGate;
  readonly decision: typeof GO_ACTIVATE_GATE_ID;
  readonly generations: Readonly<Record<ActivationGenerationKey, string>>;
  readonly sourceCommit: string;
}

export interface ActivationBindingRefusal {
  readonly code: ActivationBindingCode;
  readonly layer: ActivationBindingLayer;
  readonly ok: false;
}

export type ActivationBindingAdmission =
  | { readonly binding: ActivationBinding; readonly ok: true }
  | ActivationBindingRefusal
  | ApprovalAuthorityRefusal;

const REQUIRE_HUMAN_POLICY = Object.freeze({ kind: "REQUIRE_HUMAN" } as const);
const RECORD_KEYS: readonly string[] = ["authority", "decision", "generations", "sourceCommit"];
const GATE_KEYS: readonly string[] = ["gateId", "grant", "workRef"];
const GRANT_KEYS: readonly string[] = [
  "gateId", "grantedAtEpochMs", "principalId", "principalKind", "workRef",
];
const DIGEST_HEX = /^[0-9a-f]{64}$/;
const COMMIT_HEX = /^[0-9a-f]{40}$/;

function refuse(code: ActivationBindingCode): ActivationBindingRefusal {
  return Object.freeze({ code, layer: GA_ACTIVATION_BINDING_LAYER, ok: false as const });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Exact keys, not a superset: an unexpected key is a different record than the one admitted. */
function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validGateShape(authority: unknown): authority is HumanAuthorityGate {
  if (!isRecord(authority) || !exactKeys(authority, GATE_KEYS)) return false;
  const grant = authority["grant"];
  if (grant === null) return true;
  return isRecord(grant) && exactKeys(grant, GRANT_KEYS);
}

function validShape(record: Readonly<Record<string, unknown>>): boolean {
  if (!exactKeys(record, RECORD_KEYS)) return false;
  if (typeof record["decision"] !== "string" || typeof record["sourceCommit"] !== "string") {
    return false;
  }
  const generations = record["generations"];
  if (!isRecord(generations) || !exactKeys(generations, ACTIVATION_GENERATION_KEYS)) return false;
  return validGateShape(record["authority"]);
}

/** Lowercase hex only: an uppercase digest is a different string and compares unequal later. */
function boundGenerations(generations: Readonly<Record<string, unknown>>): boolean {
  return ACTIVATION_GENERATION_KEYS.every((key) => {
    const value = generations[key];
    return typeof value === "string" && DIGEST_HEX.test(value);
  });
}

function frozenBinding(record: Readonly<Record<string, unknown>>): ActivationBinding {
  const generations = record["generations"] as Readonly<Record<ActivationGenerationKey, string>>;
  const authority = record["authority"] as HumanAuthorityGate;
  const grant = authority.grant;
  return Object.freeze({
    authority: Object.freeze({
      gateId: authority.gateId,
      grant: grant === null ? null : Object.freeze({ ...grant }),
      workRef: authority.workRef,
    }),
    decision: GO_ACTIVATE_GATE_ID,
    generations: Object.freeze({ ...generations }),
    sourceCommit: record["sourceCommit"] as string,
  });
}

/**
 * Admits one GO_ACTIVATE binding, or refuses closed. The check order is fixed and each
 * position is pinned by a single-defect fixture in activation-binding.test.ts, so exactly one
 * code can answer any given malformed record.
 */
export function admitActivationBinding(record: unknown): ActivationBindingAdmission {
  if (record === null || record === undefined) return refuse("ACTIVATION_BINDING_ABSENT");
  if (!isRecord(record) || !validShape(record)) {
    return refuse("ACTIVATION_BINDING_SHAPE_INVALID");
  }
  if (record["decision"] !== GO_ACTIVATE_GATE_ID) {
    return refuse("ACTIVATION_BINDING_DECISION_MISMATCH");
  }
  const authority = record["authority"] as HumanAuthorityGate;
  if (authority.gateId !== GO_ACTIVATE_GATE_ID || authority.workRef !== GA_ACTIVATION_WORK_REF) {
    return refuse("ACTIVATION_BINDING_WORK_MISMATCH");
  }
  const decided = decideApprovalAuthority({ gate: authority, policy: REQUIRE_HUMAN_POLICY });
  if (!decided.ok) return decided;
  const generations = record["generations"] as Readonly<Record<string, unknown>>;
  if (!boundGenerations(generations) || !COMMIT_HEX.test(record["sourceCommit"] as string)) {
    return refuse("ACTIVATION_BINDING_GENERATION_UNBOUND");
  }
  return Object.freeze({ binding: frozenBinding(record), ok: true as const });
}
