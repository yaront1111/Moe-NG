import type { CommandDecisionRecord, EventDraft, SqliteEventStore } from "@moe/store";

import {
  DEPLOY_ENGINE_PRINCIPAL_ID, DEPLOY_RECEIPT_COMMAND_KIND, DEPLOY_RECEIPT_VERSION,
  decodeDeployReceiptBytes, deployAggregateId, deployReceiptId,
} from "./deploy-receipt-contracts.js";
import type { DeployReceiptV1, DeployRefusal } from "./deploy-receipt-contracts.js";

/**
 * Durable reads and writes for deploying. Each deploy's receipt lands on the
 * environment's own deploy aggregate (`deploy:<projectId>:<environment>`) under
 * the engine's reserved principal. ONE walk of the decision ledger answers
 * every environment's deploy state: the current receipt and the one it
 * replaced.
 *
 * THE PREVIOUS RECEIPT IS KEPT, NEVER OVERWRITTEN. Rollback resolves through
 * it, so the ledger holds both and they stay distinguishable by sha.
 */

const encoder = new TextEncoder();
const LEDGER_PAGE_SIZE = 200;

export interface EnvironmentDeployState {
  /** The most recent receipt for this environment, in ledger order. */
  readonly current: DeployReceiptV1;
  /** The receipt the current one replaced, or null on an environment's first deploy. */
  readonly previous: DeployReceiptV1 | null;
  /** Every receipt for this environment in ledger order, oldest first. */
  readonly receipts: readonly DeployReceiptV1[];
}

export type DeployReceiptReadResult =
  | Readonly<{ readonly decision: CommandDecisionRecord; readonly ok: true; readonly receipt: DeployReceiptV1 }>
  | Readonly<{ readonly code: "DEPLOY_RECEIPT_NOT_FOUND" | "DEPLOY_RECEIPT_INVALID"; readonly ok: false }>;

export type DeployRecordResult =
  | Readonly<{ readonly ok: true; readonly receipt: DeployReceiptV1; readonly replayed: boolean }>
  | Readonly<{ readonly code: "EXPECTED_VERSION_CONFLICT" | "DEPLOY_RECEIPT_INVALID"; readonly ok: false }>;

export interface RecordDeployReceiptInput {
  readonly decidedAt: string;
  readonly decisionId: string;
  readonly environment: string;
  readonly imageDigest: string | null;
  readonly projectId: string;
  readonly refusal: DeployRefusal | null;
  readonly releaseDecision: string | null;
  readonly sha: string;
  readonly url: string | null;
}

/**
 * Every environment's deploy history, from one walk of the decision ledger.
 *
 * Receipts are held in LEDGER ORDER and never collapsed. Keying on sha alone
 * would make a redeploy of the same sha erase the entry before it, which is
 * exactly the row rollback needs.
 */
export function readDeployLedger(
  store: SqliteEventStore, projectId: string,
): ReadonlyMap<string, EnvironmentDeployState> {
  const byEnvironment = new Map<string, DeployReceiptV1[]>();
  const seen = new Set<string>();
  let cursor = 0n;
  for (;;) {
    const page = store.readCommandDecisionsAfter(cursor, LEDGER_PAGE_SIZE);
    for (const decision of page.items) {
      if (decision.key.projectId !== projectId || decision.effectDisposition !== "EFFECTS_COMMITTED") continue;
      if (decision.commandKind !== DEPLOY_RECEIPT_COMMAND_KIND) continue;
      if (decision.key.principalId !== DEPLOY_ENGINE_PRINCIPAL_ID) continue;
      const decoded = decodeDeployReceiptBytes(decision.resultBytes);
      if (!decoded.ok || decoded.receipt.projectId !== projectId) continue;
      const { environment, receiptId } = decoded.receipt;
      if (deployAggregateId(projectId, environment) !== decision.targetAggregateId) continue;
      // One row per receipt id: a replayed decision must not double the history.
      if (seen.has(receiptId)) continue;
      seen.add(receiptId);
      const list = byEnvironment.get(environment) ?? [];
      list.push(decoded.receipt);
      byEnvironment.set(environment, list);
    }
    if (!page.hasMore || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  const states = new Map<string, EnvironmentDeployState>();
  for (const [environment, list] of byEnvironment) {
    const current = list[list.length - 1];
    if (current === undefined) continue;
    states.set(environment, Object.freeze({
      current,
      previous: list[list.length - 2] ?? null,
      receipts: Object.freeze([...list]),
    }));
  }
  return states;
}

/**
 * THE ROLLBACK TARGET, published as its own call.
 *
 * `readPreviousDeployReceipt(store, projectId, environment): DeployReceiptV1 | null`
 *
 * A thin read over `readDeployLedger` so a caller that only wants the receipt
 * to roll back to does not have to understand the ledger's shape. Answers null
 * when the environment has never deployed or has deployed exactly once — in
 * both cases there is nothing to roll back TO, and null says so rather than
 * handing back the current receipt.
 */
export function readPreviousDeployReceipt(
  store: SqliteEventStore, projectId: string, environment: string,
): DeployReceiptV1 | null {
  return readDeployLedger(store, projectId).get(environment)?.previous ?? null;
}

/** The environment's most recent receipt, or null while it has never deployed. */
export function readCurrentDeployReceipt(
  store: SqliteEventStore, projectId: string, environment: string,
): DeployReceiptV1 | null {
  return readDeployLedger(store, projectId).get(environment)?.current ?? null;
}

export function readDeployReceipt(
  store: SqliteEventStore, projectId: string, receiptId: string,
): DeployReceiptReadResult {
  let decision: CommandDecisionRecord | null;
  try {
    decision = store.getCommandDecision({
      commandId: receiptId, principalId: DEPLOY_ENGINE_PRINCIPAL_ID, projectId,
    });
  } catch {
    return { code: "DEPLOY_RECEIPT_INVALID", ok: false };
  }
  if (decision === null) return { code: "DEPLOY_RECEIPT_NOT_FOUND", ok: false };
  if (decision.effectDisposition !== "EFFECTS_COMMITTED"
    || decision.commandKind !== DEPLOY_RECEIPT_COMMAND_KIND
    || decision.key.commandId !== receiptId || decision.key.projectId !== projectId) {
    return { code: "DEPLOY_RECEIPT_INVALID", ok: false };
  }
  const decoded = decodeDeployReceiptBytes(decision.resultBytes);
  if (!decoded.ok || decoded.receipt.receiptId !== receiptId || decoded.receipt.projectId !== projectId
    || decision.targetAggregateId !== deployAggregateId(projectId, decoded.receipt.environment)) {
    return { code: "DEPLOY_RECEIPT_INVALID", ok: false };
  }
  return { decision, ok: true, receipt: decoded.receipt };
}

/**
 * ONE receipt per deploy decision. The id is a pure function of that decision,
 * so a repeat READS BACK the receipt already there and answers
 * `replayed: true` rather than writing a second row — which is what makes "the
 * same sha deployed twice" answerable instead of accidental, and what keeps a
 * redeploy from pushing the real previous receipt out of reach.
 */
export function recordDeployReceipt(
  store: SqliteEventStore, input: RecordDeployReceiptInput,
): DeployRecordResult {
  const receiptId = deployReceiptId(input.projectId, input.environment, input.decisionId);
  const historical = readDeployReceipt(store, input.projectId, receiptId);
  if (historical.ok) return { ok: true, receipt: historical.receipt, replayed: true };
  if (historical.code === "DEPLOY_RECEIPT_INVALID") return { code: historical.code, ok: false };
  const receipt: DeployReceiptV1 = {
    decidedAt: input.decidedAt,
    decisionId: input.decisionId,
    environment: input.environment,
    imageDigest: input.imageDigest,
    outcome: input.refusal === null ? "DEPLOYED" : "REFUSED",
    projectId: input.projectId,
    receiptId,
    refusal: input.refusal,
    releaseDecision: input.releaseDecision,
    sha: input.sha,
    url: input.url,
    version: DEPLOY_RECEIPT_VERSION,
  };
  const resultBytes = encoder.encode(JSON.stringify(receipt));
  // The null-pairing discipline is enforced on the WRITE too: a caller that
  // hands us both an imageDigest and a refusal never reaches the store.
  if (!decodeDeployReceiptBytes(resultBytes).ok) return { code: "DEPLOY_RECEIPT_INVALID", ok: false };
  const aggregateId = deployAggregateId(input.projectId, input.environment);
  const event: EventDraft = {
    eventId: `${receiptId}-DeployRecorded`,
    eventType: receipt.outcome === "DEPLOYED" ? "EnvironmentDeployed" : "EnvironmentDeployRefused",
    payload: encoder.encode(JSON.stringify({
      environment: input.environment, outcome: receipt.outcome, receiptId, sha: input.sha,
    })),
  };
  const response = store.commitExpectedVersionDecision({
    commandKind: DEPLOY_RECEIPT_COMMAND_KIND,
    committedResultBytes: resultBytes,
    correlationId: "deploy-engine-receipt",
    decidedAt: input.decidedAt,
    events: [event],
    expectedVersion: store.getAggregateVersion(aggregateId),
    key: { commandId: receiptId, principalId: DEPLOY_ENGINE_PRINCIPAL_ID, projectId: input.projectId },
    requestBytes: encoder.encode(JSON.stringify({
      decisionId: input.decisionId, environment: input.environment, receiptId,
      version: DEPLOY_RECEIPT_VERSION,
    })),
    targetAggregateId: aggregateId,
  });
  if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    return { code: "EXPECTED_VERSION_CONFLICT", ok: false };
  }
  const persisted = readDeployReceipt(store, input.projectId, receiptId);
  if (!persisted.ok) return { code: "DEPLOY_RECEIPT_INVALID", ok: false };
  return { ok: true, receipt: persisted.receipt, replayed: false };
}
