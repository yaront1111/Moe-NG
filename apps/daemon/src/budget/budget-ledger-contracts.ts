/**
 * Frozen vocabulary for the durable hierarchical budget ledger.
 *
 * This module declares names, shapes and one pure derivation. It holds no behaviour over a
 * database and computes no balance: every conserved successor arrives as a `@moe/scheduler`
 * reducer's own output and is persisted verbatim.
 *
 * EVERY RECORD FIELD IS TYPED FROM ITS PRODUCING PACKAGE'S PUBLIC ROOT. A locally re-declared
 * shape would let a producer change compile cleanly here and diverge silently inside durable
 * bytes, which is the one place divergence cannot be corrected after the fact.
 *
 * THE LAYER CONSTANTS ARE MODULE-PRIVATE ON PURPOSE. `tests/security/boundary-roster.security.ts`
 * scans production modules for `^export const *_LAYER(S)` and requires a hand-written roster row
 * plus a BEFORE/AFTER/RACE hostile trio for each one it finds. This family refuses at two layers
 * and neither is a transport, storage or authority boundary that roster describes, so the
 * literals stay private and the closed TYPE is what callers name.
 *
 * TWO LAYERS, AND THE DISTINCTION IS LOAD-BEARING. `BUDGET_LEDGER` is a writer or the codec
 * refusing; `BUDGET_CURRENT_PROJECTION` is the durable READER refusing. A writer that cannot
 * read its own bindings forwards the reader's refusal VERBATIM rather than restamping it, so a
 * caller can always tell which of the two looked and failed.
 */

import { createHash } from "node:crypto";

import type {
  BudgetAccountIssueCode,
  BudgetAccountRecord,
  BudgetAuthorization,
  BudgetAvailableView,
  BudgetIssueCode,
  BudgetLedgerEntry,
  BudgetReservationIssueCode,
  BudgetSettlementIssueCode,
  MeasurementIssueCode,
  ReservationRecord,
  SettlementRecord,
} from "@moe/scheduler";
import type { DurableStoreErrorCode } from "@moe/store";

import type { ActiveGraphRefusal } from "../planning/active-graph-projection.js";

export const BUDGET_LEDGER_RECORD_VERSION = "moe-budget-ledger/1" as const;

/** The one event type this ledger writes and the only one its reader accepts. */
export const BUDGET_LEDGER_EVENT_TYPE = "BudgetLedgerTransitionCommitted" as const;

/**
 * The command kind every transition commits under: this ledger's INTERNAL durable identity, not
 * a `RuntimeCommandKind`. Those are gated at envelope decode and this one never crosses that
 * boundary.
 */
export const BUDGET_LEDGER_COMMAND_KIND = "budget.transition" as const;

const LEDGER_LAYER = "BUDGET_LEDGER" as const;
const PROJECTION_LAYER = "BUDGET_CURRENT_PROJECTION" as const;

export type BudgetRefusalLayer = typeof LEDGER_LAYER | typeof PROJECTION_LAYER;

/**
 * The layer that ORIGINATED a wrapped refusal, never this family's own. Deliberately not named
 * `*_LAYERS`: see the roster note above.
 */
export const BUDGET_SOURCE_ORIGINS = Object.freeze([
  "ACTIVE_GRAPH_PROJECTION",
  "BUDGET_ACCOUNT",
  "BUDGET_LEDGER",
  "BUDGET_MEASUREMENT",
  "BUDGET_RESERVATION",
  "BUDGET_SETTLEMENT",
  "STORE",
] as const);

export type BudgetSourceOrigin = (typeof BUDGET_SOURCE_ORIGINS)[number];

/** Closed union of every code this family can PRESERVE from underneath it. */
export type BudgetSourceCode =
  | ActiveGraphRefusal["code"]
  | BudgetIssueCode
  | BudgetAccountIssueCode
  | BudgetLedgerCode
  | BudgetReservationIssueCode
  | BudgetSettlementIssueCode
  | DurableStoreErrorCode
  | MeasurementIssueCode;

/**
 * Writer- and codec-originated refusals. Ordered by the stage that raises them: input shape,
 * bytes, ledger lifecycle, then commit. Nothing outside this module may add one, so a refusal
 * cannot be invented at a call site.
 */
export const BUDGET_LEDGER_CODES = Object.freeze([
  "BUDGET_LEDGER_INPUT_MALFORMED",
  "BUDGET_LEDGER_INPUT_UNEXPECTED_KEY",
  "BUDGET_LEDGER_RECORD_MALFORMED",
  "BUDGET_LEDGER_VERSION_UNSUPPORTED",
  "BUDGET_LEDGER_BYTES_MALFORMED",
  "BUDGET_LEDGER_DIGEST_MISMATCH",
  "BUDGET_LEDGER_ALREADY_AUTHORIZED",
  "BUDGET_LEDGER_ACCOUNT_HELD",
  "BUDGET_LEDGER_TARGET_ABSENT",
  "BUDGET_LEDGER_TRANSITION_REFUSED",
  "BUDGET_LEDGER_EXPECTED_VERSION_CONFLICT",
  "BUDGET_LEDGER_IDEMPOTENCY_CONFLICT",
  "BUDGET_LEDGER_STORE_UNAVAILABLE",
] as const);

export type BudgetLedgerCode = (typeof BUDGET_LEDGER_CODES)[number];

/** Reader-originated refusals: the durable bindings and the ledger replay. */
export const BUDGET_PROJECTION_CODES = Object.freeze([
  "BUDGET_PROJECTION_ABSENT",
  "BUDGET_PROJECTION_CONSERVATION_FAILED",
  "BUDGET_PROJECTION_CORRUPT",
  "BUDGET_PROJECTION_GOAL_ABSENT",
  "BUDGET_PROJECTION_GRAPH_UNAVAILABLE",
  "BUDGET_PROJECTION_SCOPE_FOREIGN",
  "BUDGET_PROJECTION_SPLIT_BRAIN",
  "BUDGET_PROJECTION_STALE_BINDING",
  "BUDGET_PROJECTION_VERSION_GAP",
] as const);

export type BudgetProjectionCode = (typeof BUDGET_PROJECTION_CODES)[number];

/**
 * A refusal. `UNKNOWN` is the answer to evidence that cannot be verified — epic rail 4's
 * "missing or unverifiable evidence stays UNKNOWN and never gains authority" — while `REFUSED`
 * is a transition that was declined. `sourceCode`/`sourceLayer` carry the ORIGINATING refusal
 * verbatim and are null only when this family itself is what said no.
 */
export interface BudgetRefusalOf<TCode extends BudgetLedgerCode | BudgetProjectionCode> {
  readonly ok: false;
  readonly outcome: "REFUSED" | "UNKNOWN";
  readonly code: TCode;
  readonly layer: BudgetRefusalLayer;
  readonly sourceCode: BudgetSourceCode | null;
  readonly sourceLayer: BudgetSourceOrigin | null;
}

/**
 * The code union is a TYPE PARAMETER so a wrapper can preserve a narrower one. The codec only
 * ever raises ledger codes, and a reader that wraps a codec refusal has to be able to put that
 * code in `sourceCode` — which a widened union would forbid at the type level and which a cast
 * would paper over.
 */
export type BudgetRefusal = BudgetRefusalOf<BudgetLedgerCode | BudgetProjectionCode>;
export type BudgetLedgerRefusal = BudgetRefusalOf<BudgetLedgerCode>;

export const BUDGET_TRANSITIONS = Object.freeze([
  "ROOT_AUTHORIZED", "ALLOCATED", "RETURNED", "RESERVED", "ACTIVATED", "SETTLED", "RECONCILED",
] as const);

export type BudgetTransition = (typeof BUDGET_TRANSITIONS)[number];

/** Every identity a transition is bound to, each field read from a DURABLE record. */
export interface BudgetDurableBinding {
  readonly budgetAccountRef: string;
  readonly goalRef: string;
  readonly graphEpoch: number;
  readonly graphRevisionRef: string;
  readonly ownerRef: string;
  readonly projectId: string;
}

/**
 * One durable transition, whole.
 *
 * `appended` is the ACCOUNT-fold delta this transition added, so the reader can concatenate the
 * stream and hand it to `replayBudgetLedger` rather than folding it itself. `accounts` is that
 * same reducer's successor, committed so a reader can cross-check its own replay against what
 * the writer claimed. `views` is the HOLD position, which the account fold does not model: a
 * reservation moves units between buckets of one account without appending a movement entry.
 */
export interface BudgetLedgerRecord {
  readonly recordVersion: typeof BUDGET_LEDGER_RECORD_VERSION;
  readonly accounts: readonly BudgetAccountRecord[];
  readonly appended: readonly BudgetLedgerEntry[];
  readonly authorization: BudgetAuthorization;
  readonly binding: BudgetDurableBinding;
  /** SHA-256 over the canonical input, so a replay can tell identical intent from conflicting. */
  readonly requestDigest: string;
  readonly reservations: readonly ReservationRecord[];
  readonly sequence: number;
  readonly settlements: readonly SettlementRecord[];
  readonly transition: BudgetTransition;
  readonly views: readonly BudgetAvailableView[];
}

/** The record's own key set, so a sweep over "every field" is bounded by the record itself. */
export const BUDGET_LEDGER_RECORD_KEYS = Object.freeze([
  "accounts", "appended", "authorization", "binding", "recordVersion", "requestDigest",
  "reservations", "sequence", "settlements", "transition", "views",
] as const);

export function budgetLedgerRefusal(
  outcome: BudgetRefusal["outcome"],
  code: BudgetLedgerCode,
  sourceCode: BudgetSourceCode | null = null,
  sourceLayer: BudgetSourceOrigin | null = null,
): BudgetLedgerRefusal {
  return Object.freeze({ code, layer: LEDGER_LAYER, ok: false as const, outcome, sourceCode, sourceLayer });
}

/** Reader refusals are always UNKNOWN: unverifiable evidence confers nothing. */
export function budgetProjectionRefusal(
  code: BudgetProjectionCode,
  sourceCode: BudgetSourceCode | null = null,
  sourceLayer: BudgetSourceOrigin | null = null,
): BudgetRefusal {
  return Object.freeze({
    code, layer: PROJECTION_LAYER, ok: false as const, outcome: "UNKNOWN" as const,
    sourceCode, sourceLayer,
  });
}

const AGGREGATE_NAMESPACE = `${BUDGET_LEDGER_RECORD_VERSION}|aggregate|`;
const MAX_STORE_IDENTIFIER_UTF8_BYTES = 512;

/**
 * One ledger aggregate per (project, budget account).
 *
 * Length framing is injective, so no two distinct pairs collide. Only rows whose framed form
 * would overflow the store's identifier bound fall back to collision-resistant SHA-256 over that
 * complete versioned preimage; every other row keeps its readable framing byte for byte.
 */
export function deriveBudgetAggregateId(projectId: string, budgetAccountRef: string): string {
  const framed =
    `${AGGREGATE_NAMESPACE}${projectId.length}:${projectId}|${budgetAccountRef.length}:${budgetAccountRef}`;
  if (Buffer.byteLength(framed, "utf8") <= MAX_STORE_IDENTIFIER_UTF8_BYTES) return framed;
  return `${AGGREGATE_NAMESPACE}sha256:${createHash("sha256").update(framed, "utf8").digest("hex")}`;
}
