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

/** What a refusal detail becomes when it is not one of this engine's own public phase words. */
const REDACTED_DETAIL = "[REDACTED]";

/**
 * THE ONLY DETAILS THAT MAY BECOME DURABLE, as a finite set of the engine's OWN outputs.
 *
 * A refusal detail is external free text — docker's stderr, ssh's stderr, a migration engine's
 * words — so it can carry a connection string, a registry token or an echoed authorization
 * header (epic rail 3). The defence is NOT recognising secrets: an environment value is usually
 * opaque and `lastStderrLine` keeps only the last 600 bytes, so a credential arrives with no
 * scheme, delimiter or header to match on. What a detector cannot see, a FINITE OUTPUT SET does
 * not have to — every string below is minted by production code with no caller text in it
 * (deploy-service.ts, deploy-image-build.ts), so anything else is untrusted by construction.
 * Membership is EXACT: no trim, no prefix/suffix, no case folding, because `"<phase>: <tool
 * output>"` is exactly how a secret rides along beside a safe word.
 */
const PUBLIC_PHASE_DETAILS: ReadonlySet<string> = new Set([
  "DEPLOY_PROXY_MISSING_OR_AMBIGUOUS", "DEPLOY_PROXY_BUSY", "DEPLOY_PROXY_CONFIG_UNSUPPORTED",
  "DEPLOY_PROXY_INCUMBENT_MISSING", "DEPLOY_PROXY_RECOVERY_REQUIRED", "DEPLOY_PROXY_WRITE_FAILED",
  "DEPLOY_PROXY_RELOAD_FAILED", "DEPLOY_BUILD_UNAVAILABLE", "DEPLOY_IMAGE_DIGEST_UNAVAILABLE",
  "DEPLOY_ROLLBACK_IMAGE_UNAVAILABLE", "DEPLOY_EFFECT_UNAVAILABLE", "DEPLOY_COMMIT_UNAVAILABLE",
  "DEPLOY_ARCHIVE_UNAVAILABLE", "DEPLOY_ARCHIVE_FAILED", "DEPLOY_DOCKER_UNAVAILABLE",
  "DEPLOY_BUILD_STDIN_FAILED", "DEPLOY_BUILD_TIMED_OUT",
  // The ONE migration composite that qualifies. Both halves are closed-roster constants minted by
  // migration-service.ts — the code and layer from migration-receipt.ts's frozen `codeLayers`, the
  // detail the code itself — so no filename, stderr or connection string can ride here. Every
  // OTHER migration refusal carries a filename tail, which is caller-influenced text, so the
  // generic `MIGRATION_FAILED@DAEMON_INGRESS` is deliberately NOT a member and stays redacted.
  "MIGRATION_TOOL_MISSING@DAEMON_INGRESS: MIGRATION_TOOL_MISSING",
]);

/** The refusal as it may be STORED: code and layer unchanged — this engine's own stable
 *  vocabulary, and what every reader routes on — with only the free-text detail declassified. */
function declassifyRefusal(refusal: DeployRefusal): DeployRefusal {
  return PUBLIC_PHASE_DETAILS.has(refusal.detail)
    ? refusal
    : { code: refusal.code, detail: REDACTED_DETAIL, layer: refusal.layer };
}

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
  // The null-pairing discipline is enforced on the WRITE too: a caller that
  // hands us both an imageDigest and a refusal never reaches the store.
  // ADMISSION RUNS ON THE CALLER'S SHAPE, BEFORE DECLASSIFICATION — masking the detail first
  // would turn a malformed refusal into a well-formed one and write it.
  const admitted = decodeDeployReceiptBytes(encoder.encode(JSON.stringify(receipt)));
  if (!admitted.ok) return { code: "DEPLOY_RECEIPT_INVALID", ok: false };
  const stored = admitted.receipt.refusal === null
    ? admitted.receipt
    : { ...admitted.receipt, refusal: declassifyRefusal(admitted.receipt.refusal) };
  // ONLY these bytes are committed, so the untrusted text is never durable — scrubbing at a read
  // or in a browser would leave the plaintext in the event store for every later reader.
  const resultBytes = encoder.encode(JSON.stringify(stored));
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
