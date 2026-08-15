import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";

import { REVIEW_SCHEMA_VERSION, decodeReviewRequestBytes } from "./review-contracts.js";
import { commitAccepted, readReviewLedger } from "./review-ledger.js";
import { runReviewCommand } from "./review-services.js";
import type { ReviewOutcome } from "./review-ledger.js";

/**
 * Request fixtures for the review-flow suites.
 *
 * Every helper here builds INPUT or reads the store back; none restates a rule. `send` drives
 * the production `runReviewCommand` and `decisionsFor` reads the production decision log, so an
 * assertion written against these helpers is an assertion about shipped code. A fixture that
 * reimplemented the append-only rule or the carry-forward comparison would let this suite stay
 * green while the shipped rule drifted away from it.
 *
 * This module is test-tier scaffolding: it is reached only from `*.test.ts`, never from a
 * published unit, so it deliberately has no `.js` runtime bridge.
 */

export const PROJECT_ID = "project-review-1";
export const SUBJECT_REF = "node-run-1";
export const REVIEWER = "reviewer-1";
export const AUTHOR = "author-1";

const encoder = new TextEncoder();
const openStores: SqliteEventStore[] = [];
const openDirectories: string[] = [];

export function hex64(seed: string): string {
  const base = seed.replace(/[^0-9a-f]/gu, "0");
  return (base + "0".repeat(64)).slice(0, 64);
}

export function openStore(): SqliteEventStore {
  const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
  openStores.push(store);
  return store;
}

/**
 * A file-backed store plus its reopen handle. An ephemeral `:memory:` store cannot answer the
 * durability question at all — it would prove only that a value survived inside one process.
 */
export interface RestartableStore {
  readonly path: string;
  readonly store: SqliteEventStore;
}

export function openRestartableStore(): RestartableStore {
  const directory = mkdtempSync(join(tmpdir(), "moe-review-"));
  openDirectories.push(directory);
  const path = join(directory, "store.sqlite");
  const store = SqliteEventStore.openForProject(path, PROJECT_ID);
  openStores.push(store);
  return { path, store };
}

/** Closes the handle first: an open SQLite file cannot be reopened cleanly on Windows. */
export function reopen(restartable: RestartableStore): SqliteEventStore {
  restartable.store.close();
  const store = SqliteEventStore.openForProject(restartable.path, PROJECT_ID);
  openStores.push(store);
  return store;
}

export function closeStores(): void {
  while (openStores.length > 0) {
    try {
      openStores.pop()?.close();
    } catch {
      // A store closed by `reopen` is already gone; cleanup must not mask a test failure.
    }
  }
  while (openDirectories.length > 0) {
    const directory = openDirectories.pop();
    if (directory === undefined) continue;
    try {
      rmSync(directory, { force: true, recursive: true });
    } catch {
      // Windows can hold a transient handle on the WAL file; a leaked temp dir is not a defect.
    }
  }
}

export interface Envelope {
  readonly commandId: string;
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly expectedVersion: number;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly principalId: string;
  readonly projectId: string;
  readonly schemaVersion: string;
}

export function envelope(
  kind: string,
  expectedVersion: number,
  payload: Record<string, unknown>,
  commandId = `cmd-${kind}-${expectedVersion}`,
): Envelope {
  return {
    commandId,
    correlationId: "corr-review-1",
    decidedAt: "2026-08-09T00:00:00.000Z",
    expectedVersion,
    kind,
    payload,
    principalId: REVIEWER,
    projectId: PROJECT_ID,
    schemaVersion: REVIEW_SCHEMA_VERSION,
  };
}

export function send(store: SqliteEventStore, request: Envelope): ReviewOutcome {
  return runReviewCommand(store, encoder.encode(JSON.stringify(request)));
}

export interface DecisionRow {
  readonly commandKind: string;
  readonly decisionId: string;
  readonly resultBytes: string;
  readonly resultSha256: string;
  readonly targetAggregateId: string;
}

/**
 * Every committed decision, read back from the durable log. `resultBytes` is rendered as hex so
 * a byte comparison is a value comparison — comparing two `Uint8Array`s by identity would pass
 * for two different buffers holding different bytes.
 */
export function decisionRows(store: SqliteEventStore): readonly DecisionRow[] {
  const rows: DecisionRow[] = [];
  let cursor = 0n;
  for (;;) {
    const page = store.readCommandDecisionsAfter(cursor, 200);
    for (const decision of page.items) {
      rows.push({
        commandKind: decision.commandKind,
        decisionId: decision.decisionId,
        resultBytes: Buffer.from(decision.resultBytes).toString("hex"),
        resultSha256: decision.resultSha256,
        targetAggregateId: decision.targetAggregateId,
      });
    }
    if (!page.hasMore || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return rows;
}

export function decisionCount(store: SqliteEventStore): number {
  return decisionRows(store).length;
}

export function finding(
  overrides: Partial<{
    detail: string;
    ruleId: string;
    severity: string;
    subject: { kind: string; locator: string };
  }> = {},
): Record<string, unknown> {
  return {
    detail: "The completion node ships without the receipt its criterion requires.",
    ruleId: "rule-receipt-required",
    severity: "MAJOR",
    subject: { kind: "NODE", locator: "node-alpha" },
    ...overrides,
  };
}

/**
 * A complete, buildable package: the five singleton kinds plus a criterion and a daemon receipt.
 * `buildReviewPackage` refuses anything less, which is what makes "no evidence link" refusable.
 */
export function packageItems(): readonly Record<string, unknown>[] {
  return [
    { digest: hex64("c1"), kind: "CRITERION", locator: "criterion-1" },
    { digest: hex64("d1"), kind: "DAEMON_RECEIPT", locator: "receipt-1" },
    { digest: hex64("6a"), kind: "GRAPH_HASH", locator: "graph-1" },
    { digest: hex64("f1"), kind: "INTEGRATED_TREE", locator: "tree-1" },
    { digest: hex64("b1"), kind: "PLAN_HASH", locator: "plan-1" },
    { digest: hex64("2b"), kind: "RUBRIC", locator: "rubric-1" },
    { digest: hex64("5b"), kind: "SUBMITTED_BYTES", locator: "submitted-1" },
  ];
}

export function submitPayload(
  round: number,
  findings: readonly Record<string, unknown>[] = [finding()],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    findings,
    packageItems: packageItems(),
    round,
    subjectRef: SUBJECT_REF,
    ...overrides,
  };
}

export function submit(
  store: SqliteEventStore,
  round: number,
  findings: readonly Record<string, unknown>[] = [finding()],
): ReviewOutcome {
  return send(
    store,
    envelope("review.submit", round - 1, submitPayload(round, findings), `cmd-round-${round}`),
  );
}

/** Drives `count` distinct unsuccessful rounds, throwing rather than leaving a silent setup gap. */
export function driveRounds(store: SqliteEventStore, count: number): void {
  for (let round = 1; round <= count; round += 1) {
    const outcome = submit(store, round, [
      finding({ ruleId: `rule-${round}`, subject: { kind: "NODE", locator: `node-${round}` } }),
    ]);
    if (!outcome.ok) throw new Error(`round ${round} setup failed: ${outcome.code}`);
  }
}

export function reviewerFacts(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    authors: [AUTHOR],
    authorshipResolved: true,
    leaseHistory: [{ kind: "READ_ONLY", principal: REVIEWER, subjectRef: SUBJECT_REF }],
    leaseHistoryResolved: true,
    reviewer: REVIEWER,
    subjectRef: SUBJECT_REF,
    ...overrides,
  };
}

export function calibration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { corpusRevision: "corpus-1", sentinelPassed: true, staleness: "CURRENT", ...overrides };
}

export const ACCEPTANCE_ACTION = "integration.accept_output";

/**
 * A `@moe/core` evaluation input that genuinely evaluates to ALLOW.
 *
 * The classified R1 fact and the matching auto-approval opt-in are both load-bearing. With NO
 * facts the risk tier is unclassifiable and `evaluatePolicy` answers HOLD_UNKNOWN — correctly,
 * since unclassified risk must never auto-approve — so an "empty" policy input would make every
 * acceptance case refuse for a reason that has nothing to do with review, and the acceptance
 * gate would look enforced while nothing about it had been exercised. Measured, not assumed:
 * this exact input returns `{"decision":"ALLOW","reasonCodes":["ALLOWED_BY_POLICY"]}`.
 */
export function policyInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: ACCEPTANCE_ACTION,
    actor: REVIEWER,
    callerRiskHint: "R1",
    decisionDigest: hex64("d1"),
    evaluatedAtEpochMs: 1_760_000_000_000,
    evaluatorVersion: "evaluator-1",
    facts: [{ factId: "fact-review-risk", tier: "R1", truthClass: "DAEMON_VERIFIED" }],
    graphNodeRevisionRefs: [],
    policyRevisionRef: hex64("a1"),
    requiredFactIds: [],
    scope: [],
    sliceChain: [{
      autoApprovalOptIns: [{ action: ACCEPTANCE_ACTION, tier: "R1" }],
      rules: [],
      sliceRef: hex64("a1"),
    }],
    waivers: [],
    ...overrides,
  };
}

export function acceptancePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    calibration: calibration(),
    packageItems: packageItems(),
    policy: policyInput(),
    proof: "PASSED",
    reviewer: reviewerFacts(),
    subjectRef: SUBJECT_REF,
    ...overrides,
  };
}

export const CANONICALIZER_VERSION = "moe-canonical/1";

/**
 * One node's carry-forward evidence. `sourceHash === targetHash` by default, so the adversarial
 * pair is a one-field override rather than a second fixture that could drift.
 */
export function deltaNode(
  nodeRef: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const hash = hex64("aa");
  return {
    evidence: {
      canonicalizerVersion: CANONICALIZER_VERSION,
      dependenciesPresent: true,
      environmentClosureUnchanged: true,
      policySliceUnchanged: true,
      predecessorResultUnchanged: true,
      sourceHash: hash,
      targetHash: hash,
      ...overrides,
    },
    nodeRef,
  };
}

export function replanPayload(
  nodes: readonly Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    nodes,
    subjectRef: SUBJECT_REF,
    successorPlanRef: "plan-revision-2",
    supportedCanonicalizerVersions: [CANONICALIZER_VERSION],
    ...overrides,
  };
}

export function escalationPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { escalationRef: "escalation-1", subjectRef: SUBJECT_REF, ...overrides };
}

/**
 * Commits an arbitrary result through the PRODUCTION seam, bypassing the handlers.
 *
 * This is how a corrupt or tampered stored round is staged: no handler will ever write one, so
 * the only honest way to prove the read path fails closed is to put the bytes there directly and
 * then drive a real command against them. It decodes through the production ingress first, so it
 * cannot smuggle in an envelope the daemon would have refused.
 */
export function commitRaw(
  store: SqliteEventStore,
  request: Envelope,
  result: unknown,
  eventType = "ReviewRoundRecorded",
): ReviewOutcome {
  const decoded = decodeReviewRequestBytes(encoder.encode(JSON.stringify(request)));
  if (!decoded.ok) throw new Error(`fixture envelope refused: ${decoded.code}`);
  return commitAccepted(store, decoded.request, {
    aggregateId: SUBJECT_REF,
    eventPayload: { staged: true },
    eventType,
    expectedVersion: readReviewLedger(store, PROJECT_ID, SUBJECT_REF).version,
    result: result as never,
  });
}

/** A shape-valid lineage whose digest does not attest it: a hand-reset escalation counter. */
export function tamperedRoundResult(): Record<string, unknown> {
  return {
    lineage: {
      digest: hex64("dead"),
      highestRound: 1,
      records: [
        {
          finding: finding(),
          fingerprint: hex64("f1"),
          round: 1,
        },
      ],
      unsuccessfulRounds: 0,
    },
    reviewInputDigest: hex64("a1"),
    round: 1,
    routing: {
      layer: "FINDINGS",
      reasonCodes: [],
      repeatFingerprints: [],
      route: "REJECT_IMPLEMENTATION",
    },
  };
}
