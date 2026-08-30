import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonObject, JsonValue } from "@moe/contracts";
import type { SqliteEventStore, StoredEvent } from "@moe/store";

import { readPolicyEvaluationAuthority } from "./bootstrap-policy-authority-reader.js";
import type { PolicyEvaluationAuthority } from "./bootstrap-policy-authority-reader.js";
import type { UpstreamRefusal } from "../planning/approval-policy-ref.js";
import { RUN_POLICY_EVENT_TYPE, runPolicyAggregateId } from "../planning/run-policy-record.js";

/**
 * RUN-SCOPED SELECTION of the one `PolicyEvaluated` the finalize leg wrote for a run.
 *
 * The responsibility line: `bootstrap-policy-authority-reader.ts` answers "is THIS row honest",
 * and this module answers "WHICH row is this run's". It never reads evaluation bytes for meaning
 * — it decodes exactly enough to hand a candidate to the strict reader and forwards that
 * reader's verdict. Task rail 2 forbids a second reader of `PolicyEvaluated` bytes, and this is
 * the composition that respects it.
 *
 * SELECTION IS BY RUN, NEVER BY RECENCY. `runPolicyAggregateId(runId)` is the address the
 * production writer files under (`run-policy-evaluation.ts:203`), so the run linkage IS the
 * lookup rather than a filter applied after a newest-first walk. `deriveApplicablePolicyRef`
 * (approval-policy-ref.ts:88) walks newest-first because its question is project-scoped and has
 * no run to key on; a tier that answered for a different run would be a wrong answer, not a
 * stale one, so the two selections must not share a strategy.
 *
 * THE LINKAGE CHECK IS NOT REDUNDANT WITH THE ADDRESS. A row filed on run A's aggregate can
 * still STATE run B, and such a row is internally honest — the strict reader replays it and
 * accepts. Only the comparison below can refuse it.
 */

/** MODULE-PRIVATE literal, published only as a closed TYPE: the security roster counts exported
 *  column-zero `*_LAYER` constants, and `run-policy-record.ts:29-33` sets the precedent. */
const LAYER = "DAEMON_RUN_POLICY_SELECTION" as const;
export type RunPolicySelectionLayer = typeof LAYER;

/**
 * Five codes, one per mechanism that can answer. They are deliberately NOT collapsed:
 * `ABSENT` (no row) and `ROW_UNREADABLE` (a row exists and will not decode) are different
 * operator problems, and folding the second into the first would let a corrupt row read as
 * "this run was never evaluated" — which the seam would then report as a fact still to be
 * produced rather than as durable state that needs repair.
 */
export const RUN_POLICY_SELECTION_CODES = Object.freeze([
  "RUN_POLICY_SELECTION_ABSENT",
  "RUN_POLICY_SELECTION_AMBIGUOUS",
  "RUN_POLICY_SELECTION_ROW_UNREADABLE",
  "RUN_POLICY_SELECTION_RUN_MISMATCH",
  "RUN_POLICY_SELECTION_UNVERIFIED",
] as const);
export type RunPolicySelectionCode = (typeof RUN_POLICY_SELECTION_CODES)[number];

export interface RunPolicySelectionRefused {
  readonly code: RunPolicySelectionCode;
  readonly layer: RunPolicySelectionLayer;
  readonly ok: false;
  /** The answering authority's OWN diagnosis, forwarded rather than restamped. Present only on
   *  `UNVERIFIED`, because that is the only code another layer produced. */
  readonly upstream?: UpstreamRefusal | undefined;
}

export interface RunPolicyEvaluationSelected {
  readonly evaluation: PolicyEvaluationAuthority;
  readonly ok: true;
}

export type RunPolicySelectionResult =
  | RunPolicyEvaluationSelected
  | RunPolicySelectionRefused;

export interface RunPolicySelectionRequest {
  readonly projectId: string;
  readonly runId: string;
}

function refuse(
  code: RunPolicySelectionCode, upstream?: UpstreamRefusal,
): RunPolicySelectionRefused {
  return upstream === undefined
    ? Object.freeze({ code, layer: LAYER, ok: false as const })
    : Object.freeze({ code, layer: LAYER, ok: false as const, upstream: Object.freeze(upstream) });
}

/**
 * The run's own `PolicyEvaluated` rows.
 *
 * A store throw yields the empty list, which surfaces as `ABSENT` — the same containment
 * `approval-policy-ref.ts:29-33` applies. That is fail-closed at the seam: the caller's next
 * move is to refuse for a missing fact either way, and no unread row can become a tier.
 */
function runRows(store: SqliteEventStore, aggregateId: string): readonly StoredEvent[] {
  try {
    return store.readEvents(aggregateId).filter(
      (event) => event.aggregateId === aggregateId && event.eventType === RUN_POLICY_EVENT_TYPE,
    );
  } catch {
    return [];
  }
}

function rowPayload(event: StoredEvent): JsonObject | null {
  const decoded = decodeBoundedJsonBytes(event.payload);
  const value: JsonValue | undefined = decoded.ok ? decoded.value : undefined;
  return value === null || value === undefined || typeof value !== "object"
    || Array.isArray(value) ? null : value as JsonObject;
}

/**
 * The replay-verified evaluation this run's finalize leg wrote, or a refusal naming which
 * mechanism answered.
 *
 * AMBIGUITY REFUSES BEFORE ANY ROW IS READ. Two rows claiming one run means the writer's
 * one-row-per-run invariant broke; picking either — newest, first, highest tier — would be this
 * module inventing a resolution rule the producer never declared.
 */
export function readRunPolicyEvaluation(
  store: SqliteEventStore,
  request: RunPolicySelectionRequest,
): RunPolicySelectionResult {
  const aggregateId = runPolicyAggregateId(request.runId);
  const rows = runRows(store, aggregateId);
  if (rows.length === 0) return refuse("RUN_POLICY_SELECTION_ABSENT");
  if (rows.length > 1) return refuse("RUN_POLICY_SELECTION_AMBIGUOUS");
  const row = rows[0];
  if (row === undefined) return refuse("RUN_POLICY_SELECTION_ABSENT");
  const payload = rowPayload(row);
  if (payload === null) return refuse("RUN_POLICY_SELECTION_ROW_UNREADABLE");
  const authority = readPolicyEvaluationAuthority(
    payload, request.projectId, Date.parse(row.committedAt),
  );
  if (!authority.ok) {
    return refuse(
      "RUN_POLICY_SELECTION_UNVERIFIED",
      Object.freeze({ code: authority.code, layer: authority.layer }),
    );
  }
  // NO SEPARATE TIER GUARD, on purpose. `runScopedLinkage` (run-policy-record.ts:90) returns
  // `runId` and `riskTier` together or returns null, so a non-null `runId` already carries a
  // tier drawn from POLICY_RISK_TIERS. A second check here would share this code and this layer,
  // could never be the only mechanism to refuse, and would therefore be undrillable.
  if (authority.runId !== request.runId) return refuse("RUN_POLICY_SELECTION_RUN_MISMATCH");
  return Object.freeze({ evaluation: authority, ok: true as const });
}
