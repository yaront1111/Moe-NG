import * as daemon from "@moe/daemon";
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
  cleanupGoalClosureFixtures,
  seedReviewAcceptance,
  seedVerifiedNode,
} from "./goal-closure-test-fixtures.js";

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
 * The daemon-side evidence required before the third human action: a durable verification
 * receipt for the approved node and its accepted review. Both are seeded by the SHARED fixture,
 * which drives production code — the acceptance still traverses the published, authenticated
 * package-root command path, and the receipt comes from a real verifier child process.
 */
async function qualifyClosure(store: SqliteEventStore, nodeRef = "node-1"): Promise<void> {
  seedReviewAcceptance(store, nodeRef);
  await seedVerifiedNode(store, nodeRef);
}

/**
 * The review and evidence records as BYTES, so DoD 4's "earlier records remain readable and
 * byte-identical" is a byte comparison rather than a claim. Two objects can be deep-equal while
 * their canonical bytes differ, and it is the bytes closure hashed.
 *
 * The event type is restated by hand for the same reason `OWNED_KINDS` is: deriving it from the
 * production constant would make the comparison agree with itself. The non-vacuity guard below
 * is what catches a restatement that has gone stale.
 */
const RECEIPTED_EVENT_TYPE = "FoundationVerificationReceipted";

function evidenceBytes(store: SqliteEventStore): Readonly<{
  readonly acceptances: readonly string[];
  readonly receipts: readonly string[];
}> {
  const acceptances = committedDecisions(store)
    .filter((record) => record.commandKind === "integration.accept_output"
      && record.effectDisposition === "EFFECTS_COMMITTED")
    .map((record) => `${record.decisionId}:${record.resultSha256}`);
  const receipts = store.readEventsByTypeAfter(RECEIPTED_EVENT_TYPE, 0n, 200).items
    .map((event) => Buffer.from(event.payload).toString("hex"));
  return Object.freeze({ acceptances, receipts });
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
afterEach(cleanupGoalClosureFixtures);

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
  it("reaches the accepted terminal state after the third, with no fourth action", async () => {
    const store = openStore();
    const sequence = bootstrapSequence();
    const humanKinds: string[] = [];
    let lifecycleAfterThird: string | undefined;

    for (const request of sequence) {
      if (request.kind === "goal.close") await qualifyClosure(store);
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
  }, 90_000);

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
    // One case per REQUEST, not per kind: the journey issues `plan.propose` twice, so the
    // owned-kind claim is a SET claim while the case count follows the sequence.
    expect(cases).toHaveLength(sequence.length);
    expect(cases.length).toBeGreaterThan(0);
    expect(new Set(cases.map(([kind]) => kind))).toEqual(new Set<string>(OWNED_KINDS));
  });

  it.each(cases)("%s replays to the same decision and leaves one durable row", async (
    kind, index,
  ) => {
    const store = openStore();
    for (const request of sequence.slice(0, index)) {
      expect(drive(store, request).ok, request.kind).toBe(true);
    }
    const request = sequence[index] as Envelope;

    if (request.kind === "goal.close") await qualifyClosure(store);

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
  }, 90_000);
});

/**
 * DoD 4's other half, which no existing case covered: the closure is not allowed to disturb the
 * evidence it consumed. The composer reads the acceptance decision and the receipt row on the
 * way through, so "it only reads" has to be proven against the BYTES on both sides of the one
 * command that could rewrite them.
 */
describe("closure leaves earlier review and evidence records untouched (DoD 4)", () => {
  it("keeps the acceptance decision and the receipt row byte-identical across goal.close",
    async () => {
      const store = openStore();
      let before: ReturnType<typeof evidenceBytes> | undefined;

      for (const request of bootstrapSequence()) {
        if (request.kind === "goal.close") {
          await qualifyClosure(store);
          before = evidenceBytes(store);
          // Non-vacuity: there really are records to be disturbed, and a stale event-type
          // literal above would be caught here rather than passing as "nothing changed".
          expect(before.acceptances.length).toBeGreaterThan(0);
          expect(before.receipts.length).toBeGreaterThan(0);
        }
        expect(drive(store, request).ok, request.kind).toBe(true);
      }

      expect(goalLifecycle(store)).toBe("COMPLETED");
      expect(before).toBeDefined();
      expect(evidenceBytes(store)).toEqual(before);
    }, 90_000);
});
