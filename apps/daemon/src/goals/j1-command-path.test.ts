import * as daemon from "@moe/daemon";
import type { CommandDecisionRecord, SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ALL_HANDLERS as FIXTURE_HANDLERS,
  GOAL_ID,
  PROJECT_ID,
  bootstrapSequence,
  closeStores,
  openStore,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { FIXTURE_ACTIVATION_RECEIPTS } from "../bootstrap/bootstrap-test-fixtures.js";
import type { Envelope } from "../bootstrap/bootstrap-test-fixtures.js";
import { seedActivationWorldWithGatePolicy } from "../activation/activation-world-fixtures.js";
import { scanGlobalEvents } from "./goal-closure-test-fixtures.js";
import { createScopedCloseWorld } from "./goal-scoped-close-test-fixtures.js";

vi.mock("../../../../packages/runner/src/platform/windows/windows-broker-path.js", async (original) => {
  const actual = await original<{ resolveBrokerBinary(): unknown }>();
  return { ...actual, resolveBrokerBinary: () => process.env["MOE_TEST_APPROVED_BROKER"] ?? actual.resolveBrokerBinary() };
});

/**
 * J1's command path, driven end to end through the PUBLISHED `@moe/daemon` root.
 *
 * Every production symbol here comes from the package root, never a deep subpath, because the
 * claim under test is that an external client can drive the journey — a test reaching into
 * `./goals/goal-services.js` would stay green against a surface no consumer can import
 * (see `mem:pattern-prove-a-published-package-root-with-plain-node`). The pipeline, handler
 * roster and vocabulary are root exports. The journey injects the fixture's explicitly bound
 * publication authority, just as activation uses fixture measurements; native publication is
 * verified separately against Git and the durable human approval service.
 *
 * Legacy creation/approval progression keeps its original command roster. Successful closure
 * uses a current compiled scope, exact Git delivery, and real approved criterion checks. The
 * legacy three-command roster does not prove a current product can close in three human actions:
 * criterion approval is an additional explicit authority in the current product workflow.
 */

const encoder = new TextEncoder();

/**
 * The historical command roster, retained as a progression check rather than a product claim.
 */
const HUMAN_ACTIONS = ["goal.create", "approval.decide", "goal.close"] as const;

/**
 * The eleven owned kinds, restated by hand a second time and independently of
 * `bootstrap-services.test.ts`. Deriving either side from production would make the comparison
 * vacuous: a twelfth kind would appear on both sides and the suite would stay green.
 */
const OWNED_KINDS = [
  "approval.decide",
  "goal.close",
  "goal.create",
  "goal.create_with_source",
  "plan.propose",
  "policy.install",
  "policy.validate",
  "project.activate",
  "project.bind_repository",
  "project.register",
  "provider.probe",
  "repository.publish",
] as const;

const HANDLERS: daemon.HandlerTable = Object.freeze({
  ...daemon.BOOTSTRAP_HANDLERS,
  ...daemon.GOAL_HANDLERS,
  ...daemon.PLANNING_HANDLERS,
});
const publicationHandler = FIXTURE_HANDLERS["repository.publish"];
if (publicationHandler === undefined) throw new Error("fixture publication authority missing");
const JOURNEY_HANDLERS: daemon.HandlerTable = Object.freeze({
  ...HANDLERS,
  "repository.publish": publicationHandler,
});

function drive(store: SqliteEventStore, request: Envelope): daemon.ServiceOutcome {
  // FIXTURE_ACTIVATION_RECEIPTS stands in for what the daemon measures for itself;
  // `project.activate` mints its witness from them and refuses when none were measured.
  return daemon.runBootstrapCommand(
    store, encoder.encode(JSON.stringify(request)), JOURNEY_HANDLERS, undefined,
    FIXTURE_ACTIVATION_RECEIPTS,
  );
}

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
 * producer, and exactly what `qualifyGoalClosure` re-reads through `readVerifierReceipt`. This
 * compiled fixture uses the LIVE leg, so Foundation receipt rows are covered by their separate
 * activation-backed fixture. The nonzero denominator guard proves real receipt bytes were read.
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
  it("publishes exactly the twelve owned kinds from the package root", () => {
    expect(new Set<string>(daemon.BOOTSTRAP_COMMAND_KINDS)).toEqual(new Set<string>(OWNED_KINDS));
    expect(daemon.BOOTSTRAP_COMMAND_KINDS).toHaveLength(12);
    expect(OWNED_KINDS).toHaveLength(12);
  });

  it("routes every owned kind to a handler reachable from the package root", () => {
    expect(new Set(Object.keys(HANDLERS))).toEqual(new Set<string>(OWNED_KINDS));
  });
});

describe("J1 creation, approval, and evidenced closure", () => {
  it("retains the legacy human command roster without claiming complete product evidence", () => {
    const sequence = bootstrapSequence();
    expect(sequence.length).toBeGreaterThan(0);
    expect(sequence.filter((request) => isHumanAction(request.kind)).map((request) => request.kind)).toEqual([...HUMAN_ACTIONS]);
    expect(OWNED_KINDS.filter((kind) => isHumanAction(kind))).toHaveLength(3);
  });

  it("closes the compiled goal after exact delivery and approved criterion checks", async () => {
    const world = await createScopedCloseWorld();
    try {
      expect(goalLifecycle(world.store)).toBe("EXECUTION_ENABLED");
      expectUnactivatedWorld(world.store);
      const request = bootstrapSequence().find((item) => item.kind === "goal.close")!;
      const closeAnswer = drive(world.store, { ...request, expectedVersion: world.store.getAggregateVersion(GOAL_ID) });
      expect(closeAnswer.ok, closeAnswer.ok ? "" : closeAnswer.code).toBe(true);
      expect(goalLifecycle(world.store)).toBe("COMPLETED");
    } finally { await world.cleanup(); }
  }, 300_000);

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

  it("generates a case for every kind the legacy journey drives", () => {
    // A sweep that silently produced zero cases would pass every arm below without testing one.
    // One case per REQUEST, not per kind: the journey issues `plan.propose` twice, so the
    // kind claim is a SET claim while the case count follows the sequence. The registry suite's
    // source-bound describe owns goal.create_with_source replay without shifting this journey.
    expect(cases).toHaveLength(sequence.length);
    expect(cases.length).toBeGreaterThan(0);
    expect(new Set(cases.map(([kind]) => kind))).toEqual(new Set<string>(
      OWNED_KINDS.filter((kind) => kind !== "goal.create_with_source"),
    ));
  });

  it.each(cases)("%s replays to the same decision and leaves one durable row", async (
    kind, index,
  ) => {
    const world = kind === "goal.close" ? await createScopedCloseWorld() : null;
    const store = world?.store ?? openStore();
    try {
      for (const request of world === null ? sequence.slice(0, index) : []) {
        if (request.kind === "approval.decide") {
          seedActivationWorldWithGatePolicy(store, "HUMAN_APPROVAL");
        }
        expect(drive(store, request).ok, request.kind).toBe(true);
      }
      const original = sequence[index] as Envelope;
      const request = world === null ? original : { ...original, expectedVersion: store.getAggregateVersion(GOAL_ID) };

      // The FUNDED world before the approval (task-1de7b81a): a budget root is once-only,
      // so a project approved without one gets the zero-amount genesis root and every
      // later effect.activate refuses against a root nothing can top up.
      if (request.kind === "approval.decide") {
        seedActivationWorldWithGatePolicy(store, "HUMAN_APPROVAL");
      }
      if (world !== null) expectUnactivatedWorld(store);

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
    } finally { await world?.cleanup(); }
  }, 300_000);
});

/**
 * DoD 4's other half: the closure is not allowed to disturb the evidence it consumed. The
 * composer reads the acceptance decision and the verifier receipt row on the way through, and
 * since task-ae6fd9ac this world reaches the SUCCEEDING path — the strictly harder side, because
 * a command that commits has a write to get wrong — so "it only reads" is proven against the
 * BYTES on both sides of the one command that could rewrite them.
 */
describe("closure leaves earlier review and evidence records untouched (DoD 4)", () => {
  it("keeps the acceptance decision and the receipt row byte-identical across goal.close", async () => {
    const world = await createScopedCloseWorld();
    const { store } = world;
    try {
      expectUnactivatedWorld(store);
      const before = evidenceBytes(store);
      expect(before.acceptances.length).toBeGreaterThan(0);
      expect(before.receipts.length).toBeGreaterThan(0);
      const request = bootstrapSequence().find((item) => item.kind === "goal.close")!;
      const closed = drive(store, { ...request, expectedVersion: store.getAggregateVersion(GOAL_ID) });
      expect(closed.ok, closed.ok ? "" : closed.code).toBe(true);
      expect(goalLifecycle(store)).toBe("COMPLETED");
      expect(evidenceBytes(store)).toEqual(before);
    } finally { await world.cleanup(); }
  }, 300_000);
});
