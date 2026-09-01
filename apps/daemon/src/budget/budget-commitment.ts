/**
 * THE DECIDE-TIME BUDGET COMMITMENT (task-61a2e8ad, governor ruling A in comment-87ad84c1).
 *
 * WHY IT EXISTS. `budgetRef` on an approval record used to mean the ACTIVATION digest — the
 * digest of the durable root activation mints. A decide-time reader cannot know that value,
 * because the root does not exist yet, so the field could only ever be filled by guessing or by
 * moving the mint. Ruling A takes the third road: the record commits to the budget MATERIAL
 * VISIBLE AT DECIDE TIME, and activation binds back by recomputing the same commitment from its
 * own durable reads. Nothing about what a human approval attests to changes, and activation
 * stays the mint.
 *
 * THE MATERIAL IS THE DECIDE-TIME-VISIBLE SUBSET: the project and goal being approved, the
 * budget binding as the durable readers answer it, and the amounts the root would carry. It
 * deliberately excludes the activation envelope — the request digest, the command context, the
 * decision identity — because those are precisely what is NOT knowable when the human decides.
 *
 * ONE CANONICAL BUILDER, WHICH IS RULING CONDITION 1. This module is the single source of the
 * material, and `budget-genesis-leg.ts` consumes it rather than assembling its own copy;
 * `GENESIS_AMOUNTS` is re-exported from there for its existing importers. Two hand-maintained
 * material lists is the digest-mirror drift this board keeps paying for, and it is invisible to
 * any test that checks each side against a literal — which is why the arm that guards it
 * compares the two production surfaces to each other.
 */

import { NODE_ADMISSION_METERS } from "@moe/scheduler";
import type { BudgetMeterAmount } from "@moe/scheduler";
import { createHash } from "node:crypto";

import type { SqliteEventStore } from "@moe/store";

import { readBudgetBinding } from "./budget-durable-binding.js";
import type { BudgetBindingResult } from "./budget-durable-binding.js";
import { genesisBudgetBindingPort } from "./budget-genesis-binding.js";
import type { GenesisApprovedRun } from "./budget-genesis-binding.js";
import type { BudgetDurableBinding } from "./budget-ledger-contracts.js";

/** The binding reader's own refusal shape, so it can be carried whole rather than rebuilt. */
export type BudgetBindingRefusal = Extract<BudgetBindingResult, { ok: false }>;

export const BUDGET_COMMITMENT_LAYER = "DAEMON_PREREQUISITE" as const;

export const BUDGET_COMMITMENT_CODES = Object.freeze([
  "BOOTSTRAP_BUDGET_COMMITMENT_MISMATCH",
  "BUDGET_COMMITMENT_MATERIAL_UNAVAILABLE",
  "BUDGET_COMMITMENT_REF_MALFORMED",
] as const);
export type BudgetCommitmentCode = (typeof BUDGET_COMMITMENT_CODES)[number];

/**
 * The material's field order, declared ONCE and used BOTH to shape the record and to serialize
 * it. A digest whose key order came from an object literal would move whenever someone tidied
 * that literal, which is a silent re-commitment of an unchanged approval.
 */
export const BUDGET_COMMITMENT_MATERIAL_KEYS = Object.freeze([
  "amounts", "binding", "goalRef", "projectId",
] as const);

/**
 * Genesis grants NOTHING: a zero amount per admission meter, bidirectionally complete against
 * the roster. It lives HERE rather than in the leg because the leg now consumes this builder,
 * and the amounts are part of the material the commitment covers.
 */
export const GENESIS_AMOUNTS: readonly BudgetMeterAmount[] = Object.freeze(
  NODE_ADMISSION_METERS.map((meter) => Object.freeze({ amount: 0, meter })),
);

export interface BudgetCommitmentMaterial {
  readonly amounts: readonly BudgetMeterAmount[];
  readonly binding: BudgetDurableBinding;
  readonly goalRef: string;
  readonly projectId: string;
}

export interface BudgetCommitmentQuery {
  readonly approvedRun: GenesisApprovedRun;
  readonly goalRef: string;
  readonly projectId: string;
}

export interface BudgetCommitmentUpstream {
  readonly code: string;
  readonly layer: string;
}

export type BudgetCommitmentMaterialResult =
  | { readonly ok: true; readonly material: BudgetCommitmentMaterial }
  | {
      readonly code: BudgetCommitmentCode;
      readonly layer: typeof BUDGET_COMMITMENT_LAYER;
      readonly ok: false;
      /**
       * The binding reader's OWN refusal object, carried whole. A caller that must forward the
       * refusal in the reader's vocabulary — the genesis leg does — re-raises THIS rather than
       * reconstructing one from `upstream`, which would drop `sourceCode`/`sourceLayer` and turn
       * a precise "the history is unreadable" into a generic absence.
       */
      readonly refusal: BudgetBindingRefusal;
      readonly upstream: BudgetCommitmentUpstream | null;
    };

export type BudgetCommitmentVerdict =
  | { readonly ok: true }
  | {
      readonly code: BudgetCommitmentCode;
      readonly layer: typeof BUDGET_COMMITMENT_LAYER;
      readonly ok: false;
    };

const DOMAIN = "moe/budget/commitment/v1";
const HEX64 = /^[0-9a-f]{64}$/u;
const ENCODER = new TextEncoder();

const refuse = (
  code: BudgetCommitmentCode, refusal: BudgetBindingRefusal,
): BudgetCommitmentMaterialResult => Object.freeze({
  code, layer: BUDGET_COMMITMENT_LAYER, ok: false as const, refusal,
  upstream: Object.freeze({ code: refusal.code, layer: refusal.layer }),
});

const deny = (code: BudgetCommitmentCode): BudgetCommitmentVerdict =>
  Object.freeze({ code, layer: BUDGET_COMMITMENT_LAYER, ok: false as const });

/**
 * Canonical text with SORTED object keys at every depth and declared array order.
 *
 * Sorted rather than insertion-ordered because insertion order is a property of how the value
 * was BUILT, not of what it MEANS: two readers assembling the same facts in a different order
 * must commit to the same thing.
 */
function canonicalText(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("budget commitment: non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalText).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  const fields = Object.keys(record).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalText(record[key])}`);
  return `{${fields.join(",")}}`;
}

/**
 * The decide-time material, read through the SAME port the genesis leg's writer is handed.
 *
 * Nothing is adopted from a caller: the binding comes from the durable readers behind
 * `genesisBudgetBindingPort`, and the amounts are the fixed genesis roster. A reader refusal is
 * carried with its OWN code and layer as `upstream` rather than collapsed, because "this goal
 * does not exist" and "the durable history is unreadable" demand opposite repairs.
 */
/**
 * THE ONE ASSEMBLY. Both entry points below differ only in WHICH binding reader answers; the
 * material they build from it is assembled here, once. A second material list is precisely the
 * thing that drifts, and a drifted list would make one caller's commitment silently
 * un-verifiable by the other's.
 */
function materialFrom(
  bound: BudgetBindingResult, goalRef: string, projectId: string,
): BudgetCommitmentMaterialResult {
  if (!bound.ok) {
    return refuse("BUDGET_COMMITMENT_MATERIAL_UNAVAILABLE", bound);
  }
  return Object.freeze({
    material: Object.freeze({
      amounts: GENESIS_AMOUNTS,
      binding: bound.binding,
      goalRef,
      projectId,
    }),
    ok: true as const,
  });
}

export function budgetCommitmentMaterial(
  store: SqliteEventStore, input: BudgetCommitmentQuery,
): BudgetCommitmentMaterialResult {
  return materialFrom(
    genesisBudgetBindingPort(input.approvedRun)(store, input.projectId, input.goalRef),
    input.goalRef, input.projectId,
  );
}

/**
 * The same commitment, for a seam that has an ACTIVE graph and therefore no approved run.
 *
 * Supersession is that seam: it reads the predecessor's durable state, which carries no runId,
 * so it cannot name a `GenesisApprovedRun` at all. It does not need one — the genesis fallback
 * only fires for a project that has never activated a graph, which is the opposite of this
 * case, so the strict reader is the only reader that could ever answer there. Taking
 * `readBudgetBinding` directly says that in the type instead of demanding an approved run the
 * caller would have to invent, and it keeps the SAME assembly and the SAME digest, so a
 * commitment built here verifies against the activation bind-back unchanged.
 */
export function budgetCommitmentMaterialForActiveGraph(
  store: SqliteEventStore,
  input: Readonly<{ goalRef: string; projectId: string }>,
): BudgetCommitmentMaterialResult {
  return materialFrom(
    readBudgetBinding(store, input.projectId, input.goalRef),
    input.goalRef, input.projectId,
  );
}

/**
 * The commitment digest: a DOMAIN-TAGGED hash, so it can never collide with another surface
 * that happens to hash the same material, and specifically never with the root digest activation
 * mints. Those are different notions and aliasing them would make the bind-back check vacuous.
 */
export function budgetCommitmentDigest(material: BudgetCommitmentMaterial): string {
  const ordered: Record<string, unknown> = {};
  for (const key of BUDGET_COMMITMENT_MATERIAL_KEYS) ordered[key] = material[key];
  return createHash("sha256")
    .update(DOMAIN, "utf8")
    .update(Uint8Array.of(0))
    .update(ENCODER.encode(canonicalText(ordered)))
    .digest("hex");
}

/**
 * ACTIVATION'S BIND-BACK (ruling condition 3). The caller's ref is never adopted, only
 * COMPARED against a commitment this function recomputes from its own reads.
 *
 * A malformed ref answers differently from a mismatched one on purpose: a caller who sent
 * garbage and a caller who sent a stale-but-well-formed digest need different repairs, and one
 * "it refused" for both would hide which happened.
 */
export function verifyBudgetCommitment(
  store: SqliteEventStore, input: BudgetCommitmentQuery, expectedRef: unknown,
): BudgetCommitmentVerdict {
  if (typeof expectedRef !== "string" || !HEX64.test(expectedRef)) {
    return deny("BUDGET_COMMITMENT_REF_MALFORMED");
  }
  const built = budgetCommitmentMaterial(store, input);
  if (!built.ok) return deny("BUDGET_COMMITMENT_MATERIAL_UNAVAILABLE");
  return budgetCommitmentDigest(built.material) === expectedRef
    ? Object.freeze({ ok: true as const })
    : deny("BOOTSTRAP_BUDGET_COMMITMENT_MISMATCH");
}
