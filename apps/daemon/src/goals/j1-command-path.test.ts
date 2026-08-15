import * as daemon from "@moe/daemon";
import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { CommandDecisionRecord, SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  GOAL_ID,
  PROJECT_ID,
  bootstrapSequence,
  closeStores,
  openStore,
} from "../bootstrap/bootstrap-test-fixtures.js";
import type { Envelope } from "../bootstrap/bootstrap-test-fixtures.js";
import {
  acceptancePayload as reviewAcceptancePayload,
  reviewerFacts,
} from "../review/review-test-fixtures.js";

/**
 * J1's command path, driven end to end through the PUBLISHED `@moe/daemon` root.
 *
 * Every production symbol here comes from the package root, never a deep subpath, because the
 * claim under test is that an external client can drive the journey — a test reaching into
 * `./goals/goal-services.js` would stay green against a surface no consumer can import
 * (see `mem:pattern-prove-a-published-package-root-with-plain-node`). The fixtures supply
 * request DATA only; the pipeline, the handler tables and the vocabulary are all root exports.
 */

const encoder = new TextEncoder();
const OPERATOR_CREDENTIAL = "j1-operator-credential";
const OPERATOR_PRINCIPAL_ID = "j1-operator";

/**
 * Design 1095: the per-goal happy path is EXACTLY three human actions. Restated by hand and in
 * order, so an implementation that quietly needed a fourth would redden here rather than pass.
 */
const HUMAN_ACTIONS = ["goal.create", "approval.decide", "goal.close"] as const;

/**
 * The ten owned kinds, restated by hand a second time and independently of
 * `bootstrap-services.test.ts`. Deriving either side from production would make the comparison
 * vacuous: an eleventh kind would appear on both sides and the suite would stay green.
 */
const OWNED_KINDS = [
  "approval.decide",
  "goal.close",
  "goal.create",
  "plan.propose",
  "policy.install",
  "policy.validate",
  "project.activate",
  "project.bind_repository",
  "project.register",
  "provider.probe",
] as const;

const HANDLERS: daemon.HandlerTable = Object.freeze({
  ...daemon.BOOTSTRAP_HANDLERS,
  ...daemon.GOAL_HANDLERS,
  ...daemon.PLANNING_HANDLERS,
});

function drive(store: SqliteEventStore, request: Envelope): daemon.ServiceOutcome {
  return daemon.runBootstrapCommand(store, encoder.encode(JSON.stringify(request)), HANDLERS);
}

/**
 * Records the daemon-side review acceptance required before the third human action.
 * Production dispatch remains package-root-only; the deep import above supplies request data.
 */
function acceptReviewedNode(store: SqliteEventStore, nodeRef = "node-1"): void {
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
      expectedVersion: 0,
      payload: reviewAcceptancePayload({
        reviewer: reviewerFacts({
          leaseHistory: [{ kind: "READ_ONLY", principal: "reviewer-1", subjectRef: nodeRef }],
          subjectRef: nodeRef,
        }),
        subjectRef: nodeRef,
      }),
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

/**
 * Every committed decision, read straight out of the store — the daemon's own ledger reader is
 * not a package-root export, and an external consumer would look here anyway.
 */
function committedDecisions(store: SqliteEventStore): readonly CommandDecisionRecord[] {
  const records: CommandDecisionRecord[] = [];
  let cursor = 0n;
  for (;;) {
    const page = store.readCommandDecisionsAfter(cursor, 200);
    records.push(...page.items);
    if (!page.hasMore || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return records;
}

function goalLifecycle(store: SqliteEventStore): string | undefined {
  const decoder = new TextDecoder();
  let lifecycle: string | undefined;
  for (const record of committedDecisions(store)) {
    if (record.key.projectId !== PROJECT_ID) continue;
    if (record.targetAggregateId !== GOAL_ID) continue;
    if (record.effectDisposition !== "EFFECTS_COMMITTED") continue;
    lifecycle = (JSON.parse(decoder.decode(record.resultBytes)) as { lifecycle?: string })
      .lifecycle;
  }
  return lifecycle;
}

/** Durable rows carrying this command id, counted from the store rather than from a response. */
function rowsFor(store: SqliteEventStore, commandId: string): number {
  return committedDecisions(store).filter((item) => item.key.commandId === commandId).length;
}

function isHumanAction(kind: string): boolean {
  return HUMAN_ACTIONS.some((action) => action === kind);
}

afterEach(closeStores);

describe("J1 command vocabulary", () => {
  it("publishes exactly the ten owned kinds from the package root", () => {
    expect(new Set<string>(daemon.BOOTSTRAP_COMMAND_KINDS)).toEqual(new Set<string>(OWNED_KINDS));
    expect(daemon.BOOTSTRAP_COMMAND_KINDS).toHaveLength(10);
    expect(OWNED_KINDS).toHaveLength(10);
  });

  it("routes every owned kind to a handler reachable from the package root", () => {
    expect(new Set(Object.keys(HANDLERS))).toEqual(new Set<string>(OWNED_KINDS));
  });
});

describe("J1 is exactly three human actions (design 1095)", () => {
  it("reaches the accepted terminal state after the third, with no fourth action", () => {
    const store = openStore();
    const sequence = bootstrapSequence();
    const humanKinds: string[] = [];
    let lifecycleAfterThird: string | undefined;

    for (const request of sequence) {
      if (request.kind === "goal.close") acceptReviewedNode(store);
      const outcome = drive(store, request);
      expect(outcome.ok, `${request.kind}: ${outcome.ok ? "" : outcome.code}`).toBe(true);
      if (!isHumanAction(request.kind)) continue;
      humanKinds.push(request.kind);
      if (humanKinds.length === HUMAN_ACTIONS.length) lifecycleAfterThird = goalLifecycle(store);
    }

    // Non-vacuity: the journey really did run, and really did contain three human actions.
    expect(sequence.length).toBeGreaterThan(0);
    expect(humanKinds).toEqual([...HUMAN_ACTIONS]);
    expect(humanKinds).toHaveLength(3);
    // The accepted terminal state is reached BY the third action, so a fourth is never needed.
    expect(lifecycleAfterThird).toBe("COMPLETED");
    expect(goalLifecycle(store)).toBe("COMPLETED");
  });

  it("activates the graph inside the approval, not as a separate human action", () => {
    const store = openStore();
    for (const request of bootstrapSequence()) {
      if (request.kind === "goal.close") break;
      expect(drive(store, request).ok, request.kind).toBe(true);
      if (request.kind === "goal.create") expect(goalLifecycle(store)).toBe("DRAFT");
    }
    // One approval, and the goal is already executable — no `graph.activate` in between.
    expect(goalLifecycle(store)).toBe("EXECUTION_ENABLED");
  });
});

describe("each command is idempotent on replay (DoD 5)", () => {
  const sequence = bootstrapSequence();
  const cases = sequence.map((request, index) => [request.kind, index] as const);

  it("generates a case for every owned kind", () => {
    // A sweep that silently produced zero cases would pass every arm below without testing one.
    expect(cases).toHaveLength(OWNED_KINDS.length);
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases)("%s replays to the same decision and leaves one durable row", (kind, index) => {
    const store = openStore();
    for (const request of sequence.slice(0, index)) {
      expect(drive(store, request).ok, request.kind).toBe(true);
    }
    const request = sequence[index] as Envelope;

    if (request.kind === "goal.close") acceptReviewedNode(store);

    const first = drive(store, request);
    expect(first.ok, first.ok ? "" : first.code).toBe(true);
    if (!first.ok) throw new Error("expected acceptance");
    expect(first.disposition).toBe("DECIDED");
    expect(rowsFor(store, request.commandId)).toBe(1);

    const second = drive(store, request);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("expected replay");
    expect(second.disposition).toBe("REPLAYED");
    expect(second.decision.decisionId).toBe(first.decision.decisionId);
    expect(second.decision.resultSha256).toBe(first.decision.resultSha256);
    // The load-bearing half: "it did not throw the second time" is also what a double write
    // looks like, so the row count is read back out of the store.
    expect(rowsFor(store, request.commandId)).toBe(1);
    expect(kind).toBe(request.kind);
  });
});
