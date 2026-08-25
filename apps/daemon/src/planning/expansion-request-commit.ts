/**
 * The ATOMIC writer for one expansion request: the ACTIVE hold and the EXPANSION PlanningRun
 * bound to it, committed in a single store decision.
 *
 * ONE store call, so both aggregates share one SQLite transaction, one fence pass and one replay
 * identity. Two separate commits are not an option at all — that is precisely the SPLIT world
 * `readCurrentExpansionRequest` exists to refuse, and a crash between them would make it real.
 *
 * `commitAcceptedLegs` is deliberately NOT reused. Its `BootstrapRequest` narrows `kind` to
 * `BOOTSTRAP_COMMAND_KINDS`, a ten-kind roster measured at HEAD that does not contain
 * `graph.request_expansion`, so reaching it would need a cast — and the cast would hide a real
 * transport dependency that task-931f99e8 owns. The public store seam is used directly instead.
 *
 * THIS MODULE CONSTRUCTS NOTHING. The hold, the binding and the run arrive already produced by
 * the reducers that own them and are persisted exactly as given.
 */

import { DurableStoreError } from "@moe/store";
import type { CommandDecisionResponse, SqliteEventStore } from "@moe/store";
import type { ExpansionPlanningHoldState } from "@moe/core";

import { expansionRequestRefusal } from "./expansion-request-contracts.js";
import type {
  ExpansionRequestEnvelope,
  ExpansionRequestRefusal,
} from "./expansion-request-contracts.js";
import {
  EXPANSION_HOLD_EVENT_TYPE,
  EXPANSION_RUN_EVENT_TYPE,
  encodeExpansionHoldRecord,
  encodeExpansionRunRecord,
  expansionHoldEventId,
  expansionRunEventId,
} from "./expansion-request-records.js";
import type { ExpansionRunRecord } from "./expansion-request-records.js";

/** The server-assembled pair the writer accepts. Only the real reducers may produce it. */
export interface ExpansionRequestCommitInput {
  readonly envelope: ExpansionRequestEnvelope;
  readonly hold: ExpansionPlanningHoldState;
  readonly holdAggregateId: string;
  readonly requestBytes: Uint8Array;
  readonly run: ExpansionRunRecord;
}

export type ExpansionRequestCommitResult =
  | {
    readonly decision: CommandDecisionResponse;
    readonly disposition: "DECIDED" | "REPLAYED";
    readonly ok: true;
  }
  | ExpansionRequestRefusal;

function refuseThrown(error: unknown): ExpansionRequestRefusal {
  if (!(error instanceof DurableStoreError)) {
    return expansionRequestRefusal("EXPANSION_REQUEST_LEDGER_UNAVAILABLE");
  }
  if (error.code === "IDEMPOTENCY_CONFLICT") {
    return expansionRequestRefusal(
      "EXPANSION_REQUEST_LEDGER_IDEMPOTENCY_CONFLICT", error.code, "DURABLE_STORE",
    );
  }
  if (error.code === "EXPECTED_VERSION_CONFLICT" || error.code === "DURABLE_ID_CONFLICT") {
    return expansionRequestRefusal(
      "EXPANSION_REQUEST_LEDGER_VERSION_CONFLICT", error.code, "DURABLE_STORE",
    );
  }
  return expansionRequestRefusal(
    "EXPANSION_REQUEST_LEDGER_UNAVAILABLE", error.code, "DURABLE_STORE",
  );
}

/** Both legs or neither: the store fences and appends them inside one transaction. */
export function commitExpansionRequest(
  store: SqliteEventStore,
  input: ExpansionRequestCommitInput,
): ExpansionRequestCommitResult {
  const { envelope } = input;
  let response: CommandDecisionResponse;
  try {
    response = store.commitExpectedVersionDecisionLegs({
      commandKind: "graph.request_expansion",
      committedResultBytes: encodeExpansionHoldRecord(input.hold),
      correlationId: envelope.correlationId,
      decidedAt: envelope.decidedAt,
      key: {
        commandId: envelope.commandId,
        principalId: envelope.principalId,
        projectId: envelope.projectId,
      },
      legs: [
        {
          aggregateId: input.holdAggregateId,
          events: [{
            eventId: expansionHoldEventId(envelope.commandId),
            eventType: EXPANSION_HOLD_EVENT_TYPE,
            payload: encodeExpansionHoldRecord(input.hold),
          }],
          expectedVersion: 0,
        },
        {
          aggregateId: input.run.state.runId,
          events: [{
            eventId: expansionRunEventId(envelope.commandId),
            eventType: EXPANSION_RUN_EVENT_TYPE,
            payload: encodeExpansionRunRecord(input.run),
          }],
          expectedVersion: 0,
        },
      ],
      requestBytes: input.requestBytes,
    });
  } catch (error) {
    return refuseThrown(error);
  }
  // A fenced decision is RETURNED, not thrown: the store writes a NO_BUSINESS_EFFECT record and
  // appends nothing. Reading "it did not throw" as success is how a second hold would be
  // reported as committed while neither leg was written.
  if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    return expansionRequestRefusal(
      "EXPANSION_REQUEST_LEDGER_VERSION_CONFLICT", response.decision.resultCode, "DURABLE_STORE",
    );
  }
  return Object.freeze({
    decision: response, disposition: response.disposition, ok: true as const,
  });
}
