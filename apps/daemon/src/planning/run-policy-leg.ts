/**
 * The run-scoped policy evaluation as a LEG of the finalize decision (task-a888038d).
 *
 * WHY A LEG AND NOT A SECOND COMMAND. A run that sealed without an evaluation is exactly the hole
 * this row exists to close: a downstream approver would find no tier and would have to either
 * invent one or refuse a run the daemon had already accepted. Riding the SAME
 * `commitExpectedVersionDecisionLegs` array as the finalize event makes that unrepresentable — a
 * version race or a store failure commits neither, and a replay writes neither twice.
 *
 * WHY THE REFUSAL IS LOUD HERE AND SILENT IN `policy-risk-leg.ts`. That leg records a HUMAN's
 * approval tier and may legitimately be absent (an unauthenticated transport is a reason to record
 * no authority, not to refuse the approval). This one is the daemon's OWN verdict over content it
 * sealed itself: if it cannot tier the run, nothing downstream can, so the seal is refused with it.
 * That is the ruling's condition 3 — no default tier anywhere, including "no record".
 */
import type { ExpectedVersionDecisionLeg, SqliteEventStore } from "@moe/store";

import type { DurableLedger } from "../bootstrap/bootstrap-ledger.js";
import { ownValue } from "./planning-authority-finalize-ingress.js";
import { evaluateRunPolicy } from "./run-policy-evaluation.js";
import { RUN_POLICY_EVENT_TYPE } from "./run-policy-record.js";
import type { RunPolicyEvaluationCode, RunPolicyLayer } from "./run-policy-record.js";

const encoder = new TextEncoder();

/**
 * WHAT THE LEG MAY READ, and nothing else.
 *
 * `HandlerContext` would have been the idiom here, and it carries `request.payload` — so a future
 * edit reading a caller-stated hash off it would compile and, at this seam, agree: the finalize
 * reducer DERIVES `sealedHashes` from the command's own revision, so the two values are provably
 * equal and no fixture can tell them apart. A test therefore cannot police that boundary. This
 * narrow input can: there is no payload to read, so the mutation does not typecheck.
 */
export interface RunPolicyLegInput {
  readonly decidedAt: string;
  readonly ledger: DurableLedger;
  readonly principalId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly state: unknown;
  readonly store: SqliteEventStore;
}

export type RunPolicyLegResult =
  | { readonly kind: "ABSENT" }
  | {
    readonly code: RunPolicyEvaluationCode; readonly kind: "REFUSED";
    readonly layer: RunPolicyLayer;
  }
  | {
    readonly kind: "LEG"; readonly leg: ExpectedVersionDecisionLeg;
    readonly riskTier: string;
  };

/**
 * Builds the run's evaluation leg from the just-folded state, or refuses.
 *
 * ABSENT means the fold did not SEAL. `finalize`'s rejection arm writes no `sealedHashes`, so
 * there is no graph to evaluate and no run to tier; refusing there would refuse the rejection
 * itself. Every fold that DID seal goes through the evaluator unconditionally — including one
 * whose sealed hashes are malformed, which the evaluator refuses rather than skips.
 */
export function buildRunPolicyLeg(input: RunPolicyLegInput): RunPolicyLegResult {
  const { runId, state } = input;
  if (ownValue(state, "lifecycle") !== "PLAN_REVIEW") {
    return Object.freeze({ kind: "ABSENT" as const });
  }
  const graphContentHash = ownValue(ownValue(state, "sealedHashes"), "graphContentHash");
  const evaluated = evaluateRunPolicy(input.store, input.ledger, {
    decidedAt: input.decidedAt,
    // A non-string hash reaches the evaluator as an address no body can be filed under, so it
    // refuses GRAPH_UNAVAILABLE. Coercing or defaulting it here would be this module inventing a
    // subject; the empty string is simply an address that never matches.
    graphContentHash: typeof graphContentHash === "string" ? graphContentHash : "",
    principalId: input.principalId,
    projectId: input.projectId,
    runId,
  });
  if (!evaluated.ok) {
    return Object.freeze({ code: evaluated.code, kind: "REFUSED" as const, layer: evaluated.layer });
  }
  return Object.freeze({
    kind: "LEG" as const,
    leg: Object.freeze({
      aggregateId: evaluated.aggregateId,
      events: Object.freeze([Object.freeze({
        eventId: `${runId}-${RUN_POLICY_EVENT_TYPE}`,
        eventType: RUN_POLICY_EVENT_TYPE,
        payload: encoder.encode(JSON.stringify(evaluated.payload)),
      })]),
      expectedVersion: input.store.getAggregateVersion(evaluated.aggregateId),
    }),
    riskTier: evaluated.computedTier,
  });
}
