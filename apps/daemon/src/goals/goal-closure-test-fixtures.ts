import * as daemon from "@moe/daemon";
import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import { ACTIVATION_LEDGER_EVENT_TYPE } from "../activation/activation-ledger-contracts.js";
import { seedActivationWorldWithGatePolicy } from "../activation/activation-world-fixtures.js";
import {
  PROJECT_ID, SEALED_SUBMISSION_HASH, approvalPayload, approvalRecord, driveThrough, envelope,
  send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { seedVerifierReceipt } from "../review/review-test-fixtures.js";

/**
 * The APPROVAL and REVIEW half of the goal-closure worlds, staged through PRODUCTION code only.
 *
 * WHAT THIS MODULE CAN AND CANNOT MINT, stated so no consumer mistakes silence for capability.
 * It stages exactly two durable facts: a decided approval naming an approved node scope, and an
 * accepted review with the verifier receipt that acceptance attests. Both travel the shipped
 * command paths.
 *
 * IT NEVER MINTS `EffectActivationCommitted`, A PROVEN FOUNDATION ATTEMPT, OR A FOUNDATION
 * VERIFICATION RECEIPT. It used to: `seedProvenAttempt` drove `runEffectActivateCommand` and
 * `seedVerifiedNode` drove a real verifier child process on top of it. Production cannot
 * currently commit an activation from a test world — the ingress refuses — so that whole chain
 * asserted against a state production cannot reach. Governor ruling
 * comment-937524c83a1945a5afae3ed8ac2405b9 clause 3 directs the remedy taken here: the chain is
 * DELETED and the suites assert the refusal production genuinely returns without it, rather than
 * the world being rebuilt below the admission path under another name. Minting one here — from a
 * ledger record, a raw positive attempt or receipt row, a seeded policy fact, or any other
 * bypass — is exactly what that ruling forbids.
 *
 * The reachable first fence for every consumer is therefore
 * `GOAL_CLOSE_VERIFICATION_RECEIPT_ABSENT` at `DAEMON_PREREQUISITE`, and the artifact lane's is
 * `FOUNDATION_ARTIFACT_LEDGER_ABSENT`/`_UNREADABLE` at `DAEMON_FOUNDATION_ARTIFACT_LEDGER`.
 *
 * Test-tier scaffolding, reached only from `*.test.ts`, so it deliberately has no `.js` bridge —
 * `review-test-fixtures.ts` has none either, and `index-surface.test.ts` keeps both names off the
 * published root.
 */

const encoder = new TextEncoder();
const OPERATOR_CREDENTIAL = "j1-operator-credential";
const OPERATOR_PRINCIPAL_ID = "j1-operator";
const GLOBAL_PAGE_LIMIT = 200;

export interface GlobalEventScan {
  /** Rows of `ACTIVATION_LEDGER_EVENT_TYPE` anywhere in the store. */
  readonly activationRows: number;
  /** False if the walk stopped on a non-advancing cursor rather than on `hasMore`. */
  readonly exhausted: boolean;
  readonly total: number;
}

/**
 * The whole store's event stream, walked to exhaustion.
 *
 * STORE-WIDE AND NOT PER-AGGREGATE, deliberately. A consumer asserting "this world holds no
 * committed activation" by reading one guessed aggregate would miss a row committed anywhere
 * else, and the sibling row that landed this technique (task-bff22559, commit d96797f) flagged
 * exactly that trap. `total` is returned so the caller can assert a NONZERO denominator: an empty
 * store also has zero activation rows, and a scan that measured nothing would pass vacuously.
 */
export function scanGlobalEvents(store: SqliteEventStore): GlobalEventScan {
  let activationRows = 0, total = 0, cursor = 0n;
  for (;;) {
    const page = store.readEventsAfter(cursor, GLOBAL_PAGE_LIMIT);
    total += page.items.length;
    activationRows += page.items
      .filter((event) => event.eventType === ACTIVATION_LEDGER_EVENT_TYPE).length;
    if (!page.hasMore || page.nextCursor === null) {
      return Object.freeze({ activationRows, exhausted: true, total });
    }
    if (page.nextCursor <= cursor) return Object.freeze({ activationRows, exhausted: false, total });
    cursor = page.nextCursor;
  }
}

/**
 * The approval whose durable `approvedNodeScope` is the closure's node set.
 *
 * THE WORLD IS SEEDED FIRST (task-1de7b81a), and the order is now load-bearing rather than
 * incidental. The witnessless HUMAN_APPROVAL world stands in for the grant this repository cannot yet
 * express: it authorizes a FUNDED budget root, and a root is once-only. Approving first would
 * mint the zero-amount genesis root instead, and every later `effect.activate` in this lineage
 * would refuse BUDGET_LEDGER_TRANSITION_REFUSED against a root that can never be topped up —
 * `openBudgetRoot` is the only unit-creating reducer in `@moe/scheduler`. The call is idempotent,
 * so the world these fixtures measure is unchanged; only the moment it comes into existence
 * moved earlier. It seeds a GRAPH and a BUDGET ROOT and commits no activation ledger row.
 */
export function approveNodes(store: SqliteEventStore, nodeRefs: readonly string[]): void {
  driveThrough(store, "approval.decide");
  seedActivationWorldWithGatePolicy(store, "HUMAN_APPROVAL");
  const outcome = send(store, envelope("approval.decide", 0, approvalPayload({
    // The SEALED hash: `driveThrough` proposed through the shipped journey, whose propose
    // terminal carries the authority member, so the run's submission hash is the sealed
    // plan body's own `planHash` and an approval naming the legacy constant is refused
    // BOOTSTRAP_REVISION_HASH_MISMATCH (task-074e6d2e).
    record: { ...approvalRecord(SEALED_SUBMISSION_HASH), approvedNodeScope: [...nodeRefs] },
  })));
  if (!outcome.ok) throw new Error(`approval setup failed: ${outcome.code}`);
}

/**
 * The daemon-side review acceptance required before the third human action, driven through the
 * PUBLISHED, authenticated package-root command path. The verifier receipt is the daemon's own
 * internal producer, so the fixture seeds that durable fact and nothing else.
 *
 * A `VerifierReceiptRecorded` row is NOT a Foundation verification receipt: the closure composer
 * reads it only after an in-scope node already has one, which is why every consumer of this
 * helper still refuses at the receipt fence.
 */
export function seedReviewAcceptance(store: SqliteEventStore, nodeRef = "node-1"): void {
  const receipt = seedVerifierReceipt(store, nodeRef, PROJECT_ID);
  const ports = daemon.createDaemonCommandPorts({
    clock: () => "2026-08-16T00:00:00.000Z",
    operatorPrincipalId: OPERATOR_PRINCIPAL_ID,
    projectId: PROJECT_ID,
    store,
  });
  const outcome = daemon.handleCommandRequest({
    authenticator: {
      authenticate: (credential) => credential === OPERATOR_CREDENTIAL
        ? {
          principal: {
            capabilities: daemon.OPERATOR_CAPABILITIES,
            principalId: OPERATOR_PRINCIPAL_ID,
            projectId: PROJECT_ID,
          },
          verdict: "AUTHENTICATED" as const,
        }
        : { verdict: "UNAUTHENTICATED" as const },
    },
    ...ports,
  }, {
    body: encoder.encode(JSON.stringify({
      commandId: `cmd-j1-review-accept-${nodeRef}`,
      commandKind: "integration.accept_output",
      correlationId: "corr-j1-review",
      expectedVersion: receipt.currentVersion,
      payload: { receiptId: receipt.receiptId, subjectRef: nodeRef },
      requestDigest: "a".repeat(64),
      schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: OPERATOR_CREDENTIAL,
      targetAggregateId: nodeRef,
    })),
    credential: OPERATOR_CREDENTIAL,
    protocolVersion: daemon.WIRE_PROTOCOL_VERSION,
  });
  if (!outcome.ok) throw new Error(`authenticated review setup failed for ${nodeRef}`);
}
