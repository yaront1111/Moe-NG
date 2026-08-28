import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { decodeBootstrapRequestBytes } from "../bootstrap/bootstrap-contracts.js";
import type { BootstrapRequest } from "../bootstrap/bootstrap-contracts.js";
import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import type { HandlerContext } from "../bootstrap/bootstrap-ledger.js";
import {
  GOAL_CREATE_COMMAND_ID,
  GOAL_ID,
  PROJECT_ID,
  closeStores,
  driveThrough,
  envelope,
  openStore,
} from "../bootstrap/bootstrap-test-fixtures.js";
import {
  admitDocumentSource,
  currentDocumentSourceRef,
  documentSourceLegOf,
  documentSourceRecordOf,
} from "../documents/document-source-leg.js";
import type { AdmittedDocumentSource } from "../documents/document-source-leg.js";
import {
  GOAL_CREATED_BINDING_KEY,
  SOURCE_BOUND_GOAL_CREATED_KEYS,
  createGoalWithSource,
} from "./goal-create-with-source.js";
import { GOAL_CREATE_SOURCE_AGGREGATE_COLLISION } from "./goal-document-binding.js";

/**
 * The atomic PRD-to-goal bind.
 *
 * WHY EVERY ARM DRIVES A `goal.create`-KINDED REQUEST. `BootstrapRequest["kind"]` is a
 * `BootstrapCommandKind`, and `goal.create_with_source` is not in `BOOTSTRAP_COMMAND_KINDS`
 * yet — extending that roster is task-0ca390d9's scope, and `decodeBootstrapRequestBytes` is
 * the only way to mint a request without an unsafe cast. The properties proved here — which
 * legs are built, that both aggregates move or neither does, replay, and the conflict codes —
 * do not depend on the kind label, so the label is deliberately the production one.
 *
 * NO ARM SEEDS A SOURCE-BOUND GoalCreated INTO A SHARED FIXTURE OR A LONG-LIVED STORE. Every
 * store here is disposable and per-test: the catalog reader admits a source-bound payload only
 * under a `goal.create_with_source` trace, so a bound row in a shared world would take the
 * whole project's catalog dark.
 */

const PRD = "# Build the widget\n\nAn operator dropped this PRD in the browser.\n";
const SECOND_PRD = "# Build another widget\n\nA second PRD, different bytes.\n";
const encoder = new TextEncoder();

afterEach(closeStores);

function admitted(overrides: Partial<Record<string, unknown>> = {}): AdmittedDocumentSource {
  const outcome = admitDocumentSource({
    displayPath: "docs/prd.md", mediaType: "text/markdown", text: PRD, ...overrides,
  });
  if ("refusal" in outcome) throw new Error(`fixture refused: ${outcome.refusal.code}`);
  return outcome.value;
}

/** The source aggregate id derived INDEPENDENTLY of the seam, from the shared leaf. */
function sourceAggregateIdOf(source: AdmittedDocumentSource, projectId = PROJECT_ID): string {
  const record = documentSourceRecordOf(source);
  return documentSourceLegOf(projectId, record, currentDocumentSourceRef(record)).aggregateId;
}

/** A genuine `BootstrapRequest` through the production decoder — never a cast. */
function requestOf(commandId = GOAL_CREATE_COMMAND_ID, expectedVersion = 0): BootstrapRequest {
  const decoded = decodeBootstrapRequestBytes(
    encoder.encode(JSON.stringify(envelope("goal.create", expectedVersion, {
      instructions: "Carry J1 from an activated project to an accepted goal.",
      title: "Bootstrap journey goal",
    }, commandId))),
  );
  if (!decoded.ok) throw new Error(`fixture request refused: ${decoded.code}`);
  return decoded.request;
}

/** An activated world, with the ledger read fresh so the readiness witness is derivable. */
function contextOf(store: SqliteEventStore, request = requestOf()): HandlerContext {
  return { ledger: readDurableLedger(store, PROJECT_ID), request, store };
}

function activatedStore(): SqliteEventStore {
  const store = openStore();
  driveThrough(store, "goal.create");
  return store;
}

const BRIEF = Object.freeze({
  instructions: "Carry J1 from an activated project to an accepted goal.",
  title: "Bootstrap journey goal",
});

/** The single GoalCreated payload element the seam committed, decoded from durable bytes. */
function committedGoalFact(store: SqliteEventStore): Readonly<Record<string, unknown>> {
  const page = store.readEventsByTypeAfter("GoalCreated", 0n, 50);
  expect(page.items).toHaveLength(1);
  const event = page.items[0];
  if (event === undefined) throw new Error("no GoalCreated event");
  const decoded = JSON.parse(new TextDecoder().decode(event.payload)) as unknown;
  expect(Array.isArray(decoded)).toBe(true);
  const facts = decoded as readonly Readonly<Record<string, unknown>>[];
  expect(facts).toHaveLength(1);
  const fact = facts[0];
  if (fact === undefined) throw new Error("no GoalCreated fact");
  return fact;
}

describe("task-fc42ae5e: createGoalWithSource binds the PRD in one decision", () => {
  it("absent source: appends the source leg and stamps the server-derived binding", () => {
    const store = activatedStore();
    const source = admitted();

    const outcome = createGoalWithSource(contextOf(store), BRIEF, source);

    expect(outcome.ok).toBe(true);
    const fact = committedGoalFact(store);
    // Sorted SET-EQUALITY, not a subset check: this roster is the contract downstream rows
    // measure against, so an extra or a missing key must red here.
    expect(Object.keys(fact).sort()).toEqual([...SOURCE_BOUND_GOAL_CREATED_KEYS]);

    const binding = fact[GOAL_CREATED_BINDING_KEY] as Readonly<Record<string, unknown>>;
    const record = documentSourceRecordOf(source);
    expect(Object.keys(binding).sort())
      .toEqual(["byteLength", "contentSha256", "sourceAggregateId", "sourceRef"]);
    expect(binding["byteLength"]).toBe(record.byteLength);
    expect(binding["contentSha256"]).toBe(record.contentSha256);
    expect(binding["sourceAggregateId"]).toBe(sourceAggregateIdOf(source));
    expect(binding["sourceRef"]).toBe(currentDocumentSourceRef(record));
    // The goal is derived from the AUTHENTICATED COMMAND IDENTITY, never from a payload.
    expect(fact["goalId"]).toBe(GOAL_ID);

    // BOTH aggregates advanced inside the one decision.
    expect(store.getAggregateVersion(GOAL_ID)).toBe(1);
    expect(store.getAggregateVersion(sourceAggregateIdOf(source))).toBe(1);
  });

  it("present source: fences the existing source instead of appending a second event", () => {
    const store = activatedStore();
    const source = admitted();
    expect(createGoalWithSource(contextOf(store), BRIEF, source).ok).toBe(true);
    const sourceAggregateId = sourceAggregateIdOf(source);
    expect(store.getAggregateVersion(sourceAggregateId)).toBe(1);

    // A SECOND goal carrying the IDENTICAL PRD. The source aggregate is content-addressed and
    // its only commit is at expectedVersion 0, so an unconditional append would refuse here
    // with a store-shaped idempotency error that reads like a store bug.
    const second = createGoalWithSource(
      contextOf(store, requestOf("goal-create-2")), BRIEF, source,
    );

    expect(second.ok).toBe(true);
    expect(store.getAggregateVersion("goal-goal-create-2")).toBe(1);
    // NO second source event, and the source did not move.
    expect(store.getAggregateVersion(sourceAggregateId)).toBe(1);
    expect(store.readAggregateEvents(sourceAggregateId, 0, 50).items).toHaveLength(1);
  });

  it("a caller-supplied binding field is refused by admission, not obeyed", () => {
    // `admitDocumentSource` is exact-key, so a caller naming any identity or binding field is
    // refused before a seam ever sees it. Asserted by CODE and by refusing LAYER, because more
    // than one layer can refuse a bad create.
    for (const extra of ["sourceRef", "contentSha256", "sourceAggregateId", "goalId"]) {
      const outcome = admitDocumentSource({
        displayPath: "docs/prd.md", mediaType: "text/markdown", text: PRD,
        [extra]: "attacker-chosen",
      });
      if (!("refusal" in outcome)) throw new Error(`admitted a caller-supplied ${extra}`);
      expect(outcome.refusal.code).toBe("DOCUMENT_WORK_INGEST_PAYLOAD_INVALID");
      expect(outcome.refusal.layer).toBe("DAEMON_INGRESS");
    }
  });

  it("the bound source id is server-derived: different bytes cannot reach the same aggregate", () => {
    const store = activatedStore();
    const source = admitted();
    const other = admitted({ text: SECOND_PRD });
    expect(sourceAggregateIdOf(other)).not.toBe(sourceAggregateIdOf(source));

    expect(createGoalWithSource(contextOf(store), BRIEF, other).ok).toBe(true);

    const binding = committedGoalFact(store)[GOAL_CREATED_BINDING_KEY] as
      Readonly<Record<string, unknown>>;
    // The committed id tracks the ADMITTED BYTES, so a seam that took the id from anywhere else
    // stamps the wrong aggregate here.
    expect(binding["sourceAggregateId"]).toBe(sourceAggregateIdOf(other));
    expect(binding["sourceAggregateId"]).not.toBe(sourceAggregateIdOf(source));
  });

  it("legs[0] can never collide with the source leg: the two id namespaces are disjoint", () => {
    // MEASURED, and recorded because it changes what this file can prove. The collision guard
    // `GOAL_CREATE_SOURCE_AGGREGATE_COLLISION` is UNREACHABLE through this seam: the goal id is
    // `goal-${commandId}` while a source aggregate id is always `document-source/${digest}`, and
    // no `commandId` can bridge those prefixes. The guard is defensive depth for any other
    // caller of `goalDocumentBindingLegs`, and its own refusal arm is owned by
    // `goal-document-binding.test.ts:123`, which calls it directly with a colliding goal id.
    //
    // What IS assertable here is the structural reason, so that collapsing the two namespaces
    // reddens rather than silently making the collision reachable.
    const source = admitted();
    const sourceAggregateId = sourceAggregateIdOf(source);
    expect(sourceAggregateId.startsWith("document-source/")).toBe(true);

    const store = activatedStore();
    expect(createGoalWithSource(contextOf(store), BRIEF, source).ok).toBe(true);
    const goalId = committedGoalFact(store)["goalId"] as string;
    expect(goalId.startsWith("goal-")).toBe(true);
    expect(goalId).not.toBe(sourceAggregateId);
    expect(GOAL_CREATE_SOURCE_AGGREGATE_COLLISION)
      .toBe("GOAL_CREATE_SOURCE_AGGREGATE_COLLISION");
  });

  it("refuses a project that is not durably READY, before any leg is built", () => {
    const store = openStore();

    const outcome = createGoalWithSource(contextOf(store), BRIEF, admitted());

    if (outcome.ok) throw new Error("expected the readiness refusal");
    expect(outcome.code).toBe("GOAL_CREATE_PROJECT_NOT_READY");
    expect(outcome.refusedBy).toBe("DAEMON_PREREQUISITE");
    expect(store.getAggregateVersion(sourceAggregateIdOf(admitted()))).toBe(0);
  });
});

/**
 * ATOMICITY AND REPLAY over FILE-BACKED SQLite.
 *
 * Ephemeral stores cannot express close-and-reopen, and "the call returned an error" is not the
 * property this row exists to establish: it cannot tell a refused commit from a half-written
 * one. Every arm below therefore reopens the database and re-measures BOTH aggregate versions
 * and BOTH raw event cardinalities from durable bytes.
 *
 * Windows kills the vitest worker on a held handle, so every store is closed before a reopen and
 * on every exit path, failure arms included.
 */
describe("task-fc42ae5e: the bind is atomic and replay-stable on durable bytes", () => {
  const roots: string[] = [];
  const live: SqliteEventStore[] = [];

  function fileStore(label: string): { path: string; store: SqliteEventStore } {
    const root = mkdtempSync(join(tmpdir(), `moe-goal-bind-${label}-`));
    roots.push(root);
    const path = join(root, "events.sqlite3");
    const store = SqliteEventStore.openForProject(path, PROJECT_ID);
    live.push(store);
    return { path, store };
  }

  function reopen(path: string): SqliteEventStore {
    const store = SqliteEventStore.openForProject(path, PROJECT_ID);
    live.push(store);
    return store;
  }

  function closeAll(): void {
    while (live.length > 0) live.pop()?.close();
  }

  afterEach(() => {
    closeAll();
    while (roots.length > 0) {
      const root = roots.pop();
      if (root !== undefined) rmSync(root, { force: true, recursive: true });
    }
  });

  /** Raw durable cardinality of one aggregate, read after a reopen. */
  function eventCount(store: SqliteEventStore, aggregateId: string): number {
    return store.readAggregateEvents(aggregateId, 0, 100).items.length;
  }

  /**
   * The injection: the SECOND leg is fenced at a version its aggregate is not at.
   *
   * DIVERGENCE (epic rail 7A). This is the ONLY mechanism that can refuse the fixture, and the
   * arm below proves it by running the IDENTICAL fixture without the injection and getting a
   * committed decision. Every other fence the fixture crosses is passed before the store is
   * reached: ingress admission is bypassed entirely (the brief and the source arrive already
   * admitted, so no `admitDocumentSource` code can answer); the readiness gate passes because
   * `driveThrough` leaves the project durably READY; the reducer passes because the goal is
   * fresh at expectedVersion 0; and the collision guard cannot fire because `goal-` and
   * `document-source/` are disjoint prefixes. LEGS[0] — the goal — is fenced correctly at 0, so
   * a refusal here can only have come from the leg this shadow moved.
   *
   * MEASURED: `SqliteEventStore` calls `Object.freeze(this)` in its constructor, so the instance
   * method cannot be shadowed by assignment. A Proxy is used instead — legal here because
   * `getAggregateVersion` lives on the PROTOTYPE, not among the frozen own properties, so no
   * proxy invariant is violated. Every other member is forwarded BOUND TO THE REAL TARGET, which
   * is both what keeps the private `#core` field reachable and what makes `commitAcceptedLegs`
   * write through the REAL store: only the observed version the extra leg is built from moves.
   */
  function staleSourceFenceStore(
    store: SqliteEventStore, sourceAggregateId: string, observed: number,
  ): SqliteEventStore {
    return new Proxy(store, {
      get(target, property, receiver): unknown {
        if (property === "getAggregateVersion") {
          return (aggregateId: string): number =>
            aggregateId === sourceAggregateId ? observed : target.getAggregateVersion(aggregateId);
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  it("a failure on the SECOND leg leaves BOTH aggregates untouched on disk", () => {
    const { path, store } = fileStore("atomicity");
    driveThrough(store, "goal.create");
    const source = admitted();
    const sourceAggregateId = sourceAggregateIdOf(source);
    // The source does not exist, so an honest fence would be an APPEND at 0. Pinning it at 7
    // makes the second leg — and only the second leg — stale.
    const injected = staleSourceFenceStore(store, sourceAggregateId, 7);

    const outcome = createGoalWithSource(
      { ledger: readDurableLedger(store, PROJECT_ID), request: requestOf(), store: injected },
      BRIEF, source,
    );

    if (outcome.ok) throw new Error("expected the stale second leg to refuse");
    expect(outcome.code).toBe("EXPECTED_VERSION_CONFLICT");
    // A DIFFERENT layer from every daemon-side refusal in this file: the store answered.
    expect(outcome.refusedBy).toBe("DURABLE_STORE");

    closeAll();
    const reopened = reopen(path);
    expect(reopened.getAggregateVersion(GOAL_ID)).toBe(0);
    expect(reopened.getAggregateVersion(sourceAggregateId)).toBe(0);
    expect(eventCount(reopened, GOAL_ID)).toBe(0);
    expect(eventCount(reopened, sourceAggregateId)).toBe(0);
    // Positive control: the world is not simply empty — the activation events are there.
    expect(reopened.readEventsAfter(0n, 200).items.length).toBeGreaterThan(0);
  });

  it("the SAME fixture without the injection commits: the shadow is what refused", () => {
    // The isolation proof for the arm above. Loosening the injection by removing it must flip
    // the outcome; if this were also refused, the atomicity arm would be measuring some other
    // fence and would be a FINDING rather than a pass.
    const { path, store } = fileStore("isolation");
    driveThrough(store, "goal.create");
    const source = admitted();
    const sourceAggregateId = sourceAggregateIdOf(source);

    expect(createGoalWithSource(contextOf(store), BRIEF, source).ok).toBe(true);

    closeAll();
    const reopened = reopen(path);
    expect(reopened.getAggregateVersion(GOAL_ID)).toBe(1);
    expect(reopened.getAggregateVersion(sourceAggregateId)).toBe(1);
    expect(eventCount(reopened, GOAL_ID)).toBe(1);
    expect(eventCount(reopened, sourceAggregateId)).toBe(1);
  });

  it("the success path advances both exactly once and reads back with its binding", () => {
    const { path, store } = fileStore("success");
    driveThrough(store, "goal.create");
    const source = admitted();

    expect(createGoalWithSource(contextOf(store), BRIEF, source).ok).toBe(true);

    closeAll();
    const reopened = reopen(path);
    const fact = committedGoalFact(reopened);
    expect(Object.keys(fact).sort()).toEqual([...SOURCE_BOUND_GOAL_CREATED_KEYS]);
    const binding = fact[GOAL_CREATED_BINDING_KEY] as Readonly<Record<string, unknown>>;
    expect(binding["sourceAggregateId"]).toBe(sourceAggregateIdOf(source));
    expect(binding["contentSha256"]).toBe(documentSourceRecordOf(source).contentSha256);
    expect(reopened.getAggregateVersion(GOAL_ID)).toBe(1);
    expect(reopened.getAggregateVersion(sourceAggregateIdOf(source))).toBe(1);
  });

  /**
   * MEASURED, AND IT CHANGES WHAT THESE TWO ARMS CAN CLAIM. This seam is a HANDLER: the ingress
   * gate, the idempotent replay lookup and the durable-sequence check belong to
   * `runBootstrapCommand`, exactly as `goal-services.ts` says of `createGoal`, and this seam
   * deliberately does not restate them. A handler invoked directly a second time therefore never
   * reaches the store's replay lookup — the CORE REDUCER answers first, because the goal is now
   * at version 1 while the request still declares expectedVersion 0.
   *
   * So the property provable here is the one that actually matters for atomicity: a second
   * invocation writes NOTHING, under an exact code at an exact layer. The `REPLAYED` disposition
   * itself is owned by `runBootstrapCommand`, and it becomes reachable for this command only once
   * task-0ca390d9 wires the kind into `BOOTSTRAP_COMMAND_KINDS` and `GOAL_HANDLERS`.
   */
  it("an identical replay adds ZERO decision rows and ZERO event rows", () => {
    const { path, store } = fileStore("replay");
    driveThrough(store, "goal.create");
    const source = admitted();
    expect(createGoalWithSource(contextOf(store), BRIEF, source).ok).toBe(true);

    const before = readDurableLedger(store, PROJECT_ID).decisionCount;
    const beforeEvents = store.readEventsAfter(0n, 500).items.length;
    expect(before).toBeGreaterThan(0);
    expect(beforeEvents).toBeGreaterThan(0);

    const replay = createGoalWithSource(contextOf(store), BRIEF, source);

    if (replay.ok) throw new Error("expected the second invocation to write nothing");
    expect(replay.code).toBe("EXPECTED_VERSION_CONFLICT");
    expect(replay.refusedBy).toBe("CORE_REDUCER");
    closeAll();
    const reopened = reopen(path);
    // ROW COUNTS with their denominators, not merely the disposition.
    expect(readDurableLedger(reopened, PROJECT_ID).decisionCount).toBe(before);
    expect(reopened.readEventsAfter(0n, 500).items.length).toBe(beforeEvents);
    expect(reopened.getAggregateVersion(GOAL_ID)).toBe(1);
    expect(reopened.getAggregateVersion(sourceAggregateIdOf(source))).toBe(1);
  });

  it("the same command id with DIFFERENT bytes refuses deterministically", () => {
    const { path, store } = fileStore("conflict");
    driveThrough(store, "goal.create");
    const source = admitted();
    expect(createGoalWithSource(contextOf(store), BRIEF, source).ok).toBe(true);
    const before = readDurableLedger(store, PROJECT_ID).decisionCount;
    const beforeEvents = store.readEventsAfter(0n, 500).items.length;

    // Same command id, DIFFERENT bytes: `expectedVersion` is 1 rather than 0. Per the note
    // above, the core reducer answers before the store's idempotency fence is reached, and it
    // answers with a DIFFERENT code from the identical-replay arm — so the two retries are
    // distinguishable rather than collapsing into one generic "refused".
    const outcome = createGoalWithSource(
      contextOf(store, requestOf(GOAL_CREATE_COMMAND_ID, 1)), BRIEF, source,
    );

    if (outcome.ok) throw new Error("expected the different-bytes refusal");
    expect(outcome.code).toBe("ILLEGAL_TRANSITION");
    expect(outcome.refusedBy).toBe("CORE_REDUCER");
    closeAll();
    const reopened = reopen(path);
    expect(readDurableLedger(reopened, PROJECT_ID).decisionCount).toBe(before);
    expect(reopened.readEventsAfter(0n, 500).items.length).toBe(beforeEvents);
  });

  it("a second goal with the SAME PRD fences instead of appending a second source event", () => {
    const { path, store } = fileStore("second-goal");
    driveThrough(store, "goal.create");
    const source = admitted();
    const sourceAggregateId = sourceAggregateIdOf(source);
    expect(createGoalWithSource(contextOf(store), BRIEF, source).ok).toBe(true);

    const second = createGoalWithSource(
      contextOf(store, requestOf("goal-create-2")), BRIEF, source,
    );

    if (!second.ok) throw new Error(`second goal refused: ${second.code}`);
    closeAll();
    const reopened = reopen(path);
    expect(reopened.getAggregateVersion("goal-goal-create-2")).toBe(1);
    // The source aggregate is CONTENT-ADDRESSED: its first and only commit is at
    // expectedVersion 0, so an unconditional append here would have refused this goal with a
    // store-shaped idempotency error that reads like a store bug.
    expect(reopened.getAggregateVersion(sourceAggregateId)).toBe(1);
    expect(eventCount(reopened, sourceAggregateId)).toBe(1);
  });

  it("a source that MOVED between observation and commit is refused by the fence", () => {
    const { path, store } = fileStore("moved");
    driveThrough(store, "goal.create");
    const source = admitted();
    const sourceAggregateId = sourceAggregateIdOf(source);
    expect(createGoalWithSource(contextOf(store), BRIEF, source).ok).toBe(true);
    expect(store.getAggregateVersion(sourceAggregateId)).toBe(1);
    const beforeEvents = store.readEventsAfter(0n, 500).items.length;

    // The source is at 1, but observation reports 0 — the append branch is taken and its
    // expectedVersion 0 fence is stale. This is the opposite direction from the atomicity arm
    // (append rather than fence), and it is the store, not the daemon, that answers.
    const injected = staleSourceFenceStore(store, sourceAggregateId, 0);
    const outcome = createGoalWithSource(
      {
        ledger: readDurableLedger(store, PROJECT_ID),
        request: requestOf("goal-create-3"),
        store: injected,
      },
      BRIEF, source,
    );

    if (outcome.ok) throw new Error("expected the moved-source refusal");
    expect(outcome.code).toBe("EXPECTED_VERSION_CONFLICT");
    expect(outcome.refusedBy).toBe("DURABLE_STORE");
    closeAll();
    const reopened = reopen(path);
    expect(reopened.getAggregateVersion("goal-goal-create-3")).toBe(0);
    expect(reopened.getAggregateVersion(sourceAggregateId)).toBe(1);
    expect(eventCount(reopened, "goal-goal-create-3")).toBe(0);
    expect(eventCount(reopened, sourceAggregateId)).toBe(1);
    // MEASURED: a refused multi-leg commit does add exactly ONE global row, and naming it is
    // stronger than a bare count. It is the store's own fail-closed audit of the rejection, on a
    // dedicated internal aggregate — NOT a business event on either leg. Asserting the delta by
    // name is what distinguishes "the store accounted for the refusal" from "a leg leaked".
    const added = reopened.readEventsAfter(0n, 500).items.slice(beforeEvents);
    expect(added).toHaveLength(1);
    expect(added[0]?.eventType).toBe("command.expected-version-rejected");
    expect(added[0]?.aggregateId.startsWith("moe-internal:command-rejection:")).toBe(true);
  });
});
