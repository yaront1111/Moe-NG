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
import { seedActivationWorldWithGatePolicy } from "../activation/activation-world-fixtures.js";
import { scanGlobalEvents, seedReviewAcceptance } from "./goal-closure-test-fixtures.js";

/**
 * J1's command path, driven end to end through the PUBLISHED `@moe/daemon` root.
 *
 * Every production symbol here comes from the package root, never a deep subpath, because the
 * claim under test is that an external client can drive the journey — a test reaching into
 * `./goals/goal-services.js` would stay green against a surface no consumer can import
 * (see `mem:pattern-prove-a-published-package-root-with-plain-node`). The fixtures supply
 * request DATA only; the pipeline, the handler tables and the vocabulary are all root exports.
 *
 * THE THIRD HUMAN ACTION IS ATTEMPTED AND REFUSED, and that is what production does today rather
 * than a weakening of the claim. `goal.close` needs a durable Foundation verification receipt,
 * which needs a committed activation no test world can produce. Governor ruling
 * comment-937524c83a1945a5afae3ed8ac2405b9 clause 3 forbids manufacturing one, so the journey
 * still ISSUES the third action, pins the exact refusal, and proves the goal is not left parked
 * mid-closure and that the published vocabulary holds no fourth human action to rescue it with.
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

/** The frozen tuple the third human action answers with, restated by hand in full. */
const NO_RECEIPT_REFUSAL = Object.freeze({
  advisoryOnly: true,
  authority: "NONE",
  code: "GOAL_CLOSE_VERIFICATION_RECEIPT_ABSENT",
  ok: false,
  refusedBy: "DAEMON_PREREQUISITE",
});

/** No committed activation ANYWHERE in the store, with the journey's own events as the positive
 *  control: a store-wide walk, not one guessed aggregate. */
function expectUnactivatedWorld(store: SqliteEventStore): void {
  const scan = scanGlobalEvents(store);
  expect(scan.total).toBeGreaterThan(0);
  expect(scan.exhausted).toBe(true);
  expect(scan.activationRows).toBe(0);
}

/**
 * The review and evidence records as BYTES, so DoD 4's "earlier records remain readable and
 * byte-identical" is a byte comparison rather than a claim. Two objects can be deep-equal while
 * their canonical bytes differ, and it is the bytes the composer reads.
 *
 * THE RECEIPT COUNTED IS THE VERIFIER RECEIPT the acceptance attests — the daemon's own durable
 * producer, and exactly what `qualifyGoalClosure` re-reads through `readVerifierReceipt`. The
 * Foundation verification receipt this file used to count needs a committed activation and can no
 * longer exist in any reachable world; counting an event type nothing writes would make the
 * comparison below vacuous, which the nonzero denominator guard catches.
 *
 * The event type is restated by hand for the same reason `OWNED_KINDS` is: deriving it from the
 * production constant would make the comparison agree with itself.
 */
const RECEIPTED_EVENT_TYPE = "VerifierReceiptRecorded";

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
  it("issues the third human action and is refused, leaving no half-closed goal", () => {
    const store = openStore();
    const sequence = bootstrapSequence();
    const humanKinds: string[] = [];
    let closeAnswer: daemon.ServiceOutcome | undefined;

    for (const request of sequence) {
      // The FUNDED world before the approval (task-1de7b81a): a budget root is once-only,
      // so a project approved without one gets the zero-amount genesis root and every
      // later effect.activate refuses against a root nothing can top up.
      if (request.kind === "approval.decide") {
        seedActivationWorldWithGatePolicy(store, "HUMAN_APPROVAL");
      }
      if (request.kind === "goal.close") {
        // The REVIEWED half is real and production-driven, so the refusal below is the receipt
        // fence rather than the review one.
        seedReviewAcceptance(store);
        expectUnactivatedWorld(store);
        closeAnswer = drive(store, request);
        humanKinds.push(request.kind);
        continue;
      }
      const outcome = drive(store, request);
      expect(outcome.ok, `${request.kind}: ${outcome.ok ? "" : outcome.code}`).toBe(true);
      if (!isHumanAction(request.kind)) continue;
      humanKinds.push(request.kind);
    }

    // Non-vacuity: the journey really did run, and really did contain three human actions.
    expect(sequence.length).toBeGreaterThan(0);
    expect(humanKinds).toEqual([...HUMAN_ACTIONS]);
    expect(humanKinds).toHaveLength(3);
    expect(closeAnswer).toMatchObject(NO_RECEIPT_REFUSAL);
    // NOT CLOSING: a goal parked mid-closure would need a fourth human action to escape, and the
    // published vocabulary holds none — the three restated above are all of them.
    expect(goalLifecycle(store)).toBe("EXECUTION_ENABLED");
    expect(OWNED_KINDS.filter((kind) => isHumanAction(kind))).toHaveLength(3);
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

  it.each(cases)("%s replays to the same decision and leaves one durable row", (
    kind, index,
  ) => {
    const store = openStore();
    for (const request of sequence.slice(0, index)) {
      if (request.kind === "approval.decide") {
        seedActivationWorldWithGatePolicy(store, "HUMAN_APPROVAL");
      }
      expect(drive(store, request).ok, request.kind).toBe(true);
    }
    const request = sequence[index] as Envelope;

    // The FUNDED world before the approval (task-1de7b81a): a budget root is once-only,
    // so a project approved without one gets the zero-amount genesis root and every
    // later effect.activate refuses against a root nothing can top up.
    if (request.kind === "approval.decide") {
      seedActivationWorldWithGatePolicy(store, "HUMAN_APPROVAL");
    }
    if (request.kind === "goal.close") {
      seedReviewAcceptance(store);
      expectUnactivatedWorld(store);
      // A refusal composes no decision, so "replay" here means RE-DERIVED: the identical answer
      // twice, and still no durable row on either call.
      expect(drive(store, request)).toMatchObject(NO_RECEIPT_REFUSAL);
      expect(rowsFor(store, request.commandId)).toBe(0);
      expect(drive(store, request)).toMatchObject(NO_RECEIPT_REFUSAL);
      expect(rowsFor(store, request.commandId)).toBe(0);
      expect(kind).toBe(request.kind);
      return;
    }

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
 * DoD 4's other half: the closure is not allowed to disturb the evidence it consumed. The
 * composer reads the acceptance decision and the verifier receipt row on the way through — and
 * it reads them on the REFUSING path too, which is the path this world can reach — so "it only
 * reads" is proven against the BYTES on both sides of the one command that could rewrite them.
 */
describe("closure leaves earlier review and evidence records untouched (DoD 4)", () => {
  it("keeps the acceptance decision and the receipt row byte-identical across goal.close", () => {
    const store = openStore();
    let before: ReturnType<typeof evidenceBytes> | undefined;

    for (const request of bootstrapSequence()) {
      // The FUNDED world before the approval (task-1de7b81a): a budget root is once-only,
      // so a project approved without one gets the zero-amount genesis root and every
      // later effect.activate refuses against a root nothing can top up.
      if (request.kind === "approval.decide") {
        seedActivationWorldWithGatePolicy(store, "HUMAN_APPROVAL");
      }
      if (request.kind === "goal.close") {
        seedReviewAcceptance(store);
        expectUnactivatedWorld(store);
        before = evidenceBytes(store);
        // Non-vacuity: there really are records to be disturbed, and a stale event-type
        // literal above would be caught here rather than passing as "nothing changed".
        expect(before.acceptances.length).toBeGreaterThan(0);
        expect(before.receipts.length).toBeGreaterThan(0);
        expect(drive(store, request)).toMatchObject(NO_RECEIPT_REFUSAL);
        continue;
      }
      expect(drive(store, request).ok, request.kind).toBe(true);
    }

    expect(goalLifecycle(store)).toBe("EXECUTION_ENABLED");
    expect(before).toBeDefined();
    expect(evidenceBytes(store)).toEqual(before);
  }, 90_000);
});
