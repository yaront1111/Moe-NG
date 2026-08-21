/**
 * Root authorization, hierarchical movements, the caller-authority sweep, atomicity, replay and
 * the canonical codec — driven through a REAL file-backed SqliteEventStore.
 *
 * EVERY successor assertion compares against the PRODUCTION SCHEDULER REDUCER'S OWN OUTPUT,
 * never against a hand-computed table. A hand-written expectation is a second implementation of
 * the arithmetic: it agrees with a writer that recomputes the successor locally, which is
 * precisely the defect these tests exist to catch.
 *
 * EVERY refusal assertion pins the exact code AND the layer that refused, and — where a
 * scheduler reducer is what said no — the `sourceCode`/`sourceLayer` it said it with. A test
 * that asserted only "refused" would stay green while the writer restamped a reducer's code as
 * its own, which is the other defect these tests exist to catch.
 *
 * The hold writers have their own suite next door; see its header for why that split is load
 * bearing rather than cosmetic.
 *
 * WINDOWS HANDLE DISCIPLINE lives in `withBudgetStore`: the handle closes in a `finally` inside
 * the temp directory's own `finally`.
 */

import { allocateToChild, openBudgetRoot, returnToParent } from "@moe/scheduler";
import type { BudgetAuthorization, BudgetLedgerState } from "@moe/scheduler";
import type { CommandDecisionResponse, CommitExpectedVersionDecisionInput, SqliteEventStore } from "@moe/store";
import { describe, expect, it } from "vitest";

import {
  budgetLedgerDigest,
  canonicalBudgetJson,
  decodeBudgetLedgerRecord,
  encodeBudgetLedgerRecord,
} from "./budget-ledger-codec.js";
import { BUDGET_LEDGER_EVENT_TYPE } from "./budget-ledger-contracts.js";
import {
  BUDGET_ACTIVATE_INPUT_KEYS,
  BUDGET_AUTHORIZE_INPUT_KEYS,
  BUDGET_CALLER_AUTHORITY_KEYS,
  BUDGET_MOVEMENT_INPUT_KEYS,
  BUDGET_RECONCILE_INPUT_KEYS,
  BUDGET_RESERVE_INPUT_KEYS,
  BUDGET_SETTLE_INPUT_KEYS,
} from "./budget-ledger-requests.js";
import { reconcileBudgetSettlement, settleBudgetReservation } from "./budget-ledger-holds.js";
import { allocateBudgetToChild, authorizeBudgetRoot, returnBudgetToParent } from "./budget-ledger.js";
import {
  BUDGET_ACCOUNT_REF,
  GOAL_ID,
  PROJECT_ID,
  REVISION_ID,
  rawCounts,
  seedDurableBindings,
  seedProjectAndGoal,
  withBudgetStore,
} from "./budget-ledger-fixtures.js";
import {
  AGGREGATE,
  AUTHORIZED,
  CHILD,
  CHILD_OWNER,
  accepted,
  authorizeInput,
  context,
  currentLedger,
  movementInput,
  observation,
  refused,
  seedActivatedHold,
  unknownObservation,
} from "./budget-transition-fixtures.js";

/**
 * A delegate over the REAL store that lands a foreign event on the ledger aggregate BETWEEN the
 * writer's read and its commit. Not a fake: the forwarded commit reaches the same file, and the
 * head it observes really did move — which is exactly what a second writer racing this one does.
 */
function racingCommitPort(store: SqliteEventStore) {
  return {
    commitExpectedVersionDecision(input: CommitExpectedVersionDecisionInput): CommandDecisionResponse {
      store.commit({
        aggregateId: input.targetAggregateId,
        commandBytes: new TextEncoder().encode("interloper"),
        commandId: "interloper-command",
        committedAt: "2026-08-19T00:00:02.000Z",
        events: [{
          eventId: "interloper-event",
          eventType: "InterloperCommitted",
          payload: new TextEncoder().encode("{}"),
        }],
        expectedVersion: store.getAggregateVersion(input.targetAggregateId),
      });
      return store.commitExpectedVersionDecision(input);
    },
  };
}

describe("durable budget root authorization", () => {
  it("binds the root to durable goal and graph facts and commits the reducer's own successor", () => {
    withBudgetStore("authorize", (store) => {
      const revision = seedDurableBindings(store);
      const before = rawCounts(store, AGGREGATE);

      const result = accepted(authorizeBudgetRoot(store, authorizeInput()));

      expect(result.disposition).toBe("COMMITTED");
      expect(result.aggregateId).toBe(AGGREGATE);
      // Every binding field came off a DURABLE record, not off the input.
      expect(result.record.binding).toEqual({
        budgetAccountRef: BUDGET_ACCOUNT_REF,
        goalRef: GOAL_ID,
        graphEpoch: revision.graphEpoch,
        graphRevisionRef: REVISION_ID,
        ownerRef: GOAL_ID,
        projectId: PROJECT_ID,
      });
      expect(revision.graphEpoch).toBe(1);

      // The successor is the REDUCER'S, byte for byte — never a local recomputation.
      const authorization: BudgetAuthorization = {
        amounts: AUTHORIZED,
        graphRevisionRef: REVISION_ID,
        ownerRef: GOAL_ID,
        rootAccountId: BUDGET_ACCOUNT_REF,
      };
      const reducer = openBudgetRoot(authorization);
      expect(reducer.ok).toBe(true);
      expect(canonicalBudgetJson(result.record.accounts)).toBe(canonicalBudgetJson(reducer.state.accounts));
      expect(canonicalBudgetJson(result.record.appended)).toBe(canonicalBudgetJson(reducer.state.entries));
      expect(canonicalBudgetJson(result.record.authorization)).toBe(canonicalBudgetJson(authorization));

      // Exactly one durable event, and its bytes round-trip to the same record.
      const events = store.readEvents(AGGREGATE);
      expect(events).toHaveLength(1);
      const [event] = events;
      if (event === undefined) throw new Error("no committed event");
      expect(event.eventType).toBe(BUDGET_LEDGER_EVENT_TYPE);
      const decoded = decodeBudgetLedgerRecord(event.payload);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) throw new Error(decoded.code);
      expect(canonicalBudgetJson(decoded.record)).toBe(canonicalBudgetJson(result.record));

      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.record)).toBe(true);
      expect(Object.isFrozen(result.record.binding)).toBe(true);
      expect(rawCounts(store, AGGREGATE).events).toBe(before.events + 1);
    });
  });

  it("refuses a second root authorization with ALREADY_AUTHORIZED and appends nothing", () => {
    withBudgetStore("authorize-twice", (store) => {
      seedDurableBindings(store);
      accepted(authorizeBudgetRoot(store, authorizeInput()));
      const before = rawCounts(store, AGGREGATE);

      const second = refused(authorizeBudgetRoot(store, authorizeInput("cmd-authorize-2")));

      expect(second.code).toBe("BUDGET_LEDGER_ALREADY_AUTHORIZED");
      expect(second.layer).toBe("BUDGET_LEDGER");
      expect(second.sourceLayer).toBeNull();
      expect(rawCounts(store, AGGREGATE).events).toBe(before.events);
    });
  });

  it("refuses before any binding read when the goal has no durable GoalCreated", () => {
    withBudgetStore("authorize-absent-goal", (store) => {
      seedDurableBindings(store);

      const result = refused(authorizeBudgetRoot(store, { ...authorizeInput(), goalRef: "goal-nonexistent" }));

      // Forwarded VERBATIM from the durable binding reader: the writer never restamps a read
      // refusal as its own, so the layer names the module that actually looked and failed.
      expect(result.code).toBe("BUDGET_PROJECTION_GOAL_ABSENT");
      expect(result.layer).toBe("BUDGET_CURRENT_PROJECTION");
      expect(result.outcome).toBe("UNKNOWN");
    });
  });

  it("refuses a request whose project does not own the durable goal", () => {
    withBudgetStore("authorize-foreign", (store) => {
      seedDurableBindings(store);

      const result = refused(authorizeBudgetRoot(store, { ...authorizeInput(), projectId: "project-elsewhere" }));

      expect(result.code).toBe("BUDGET_PROJECTION_SCOPE_FOREIGN");
      expect(result.layer).toBe("BUDGET_CURRENT_PROJECTION");
      expect(result.sourceLayer).toBeNull();
    });
  });

  it("preserves the active-graph projection's own code and layer when no graph is active", () => {
    withBudgetStore("authorize-no-graph", (store) => {
      // Project and goal ONLY — no graph revision is committed at all.
      seedProjectAndGoal(store);
      expect(store.readEvents(GOAL_ID).length).toBeGreaterThan(0);

      const result = refused(authorizeBudgetRoot(store, authorizeInput()));

      expect(result.code).toBe("BUDGET_PROJECTION_GRAPH_UNAVAILABLE");
      expect(result.layer).toBe("BUDGET_CURRENT_PROJECTION");
      expect(result.sourceCode).toBe("ACTIVE_GRAPH_ABSENT");
      expect(result.sourceLayer).toBe("ACTIVE_GRAPH_PROJECTION");
      expect(result.outcome).toBe("UNKNOWN");
    });
  });
});

describe("caller-supplied budget authority is unrepresentable", () => {
  it("refuses every forbidden key with one exact code, over a nonempty generated case set", () => {
    const generated: string[] = [];
    withBudgetStore("forbidden-keys", (store) => {
      seedDurableBindings(store);
      const before = rawCounts(store, AGGREGATE);

      for (const key of BUDGET_CALLER_AUTHORITY_KEYS as readonly string[]) {
        const hostile = { ...authorizeInput(`cmd-hostile-${key}`), [key]: "smuggled" } as unknown;
        const result = refused(authorizeBudgetRoot(store, hostile as Parameters<typeof authorizeBudgetRoot>[1]));
        expect(result.code).toBe("BUDGET_LEDGER_INPUT_UNEXPECTED_KEY");
        expect(result.layer).toBe("BUDGET_LEDGER");
        expect(result.sourceLayer).toBeNull();
        generated.push(key);
      }

      expect(rawCounts(store, AGGREGATE).events).toBe(before.events);
    });

    // A sweep that silently generated nothing passes while testing nothing.
    expect(generated.length).toBeGreaterThan(0);
    expect(generated).toEqual([...BUDGET_CALLER_AUTHORITY_KEYS]);
  });

  it("keeps every forbidden key out of every writer's own accepted key roster", () => {
    const rosters = [
      BUDGET_AUTHORIZE_INPUT_KEYS,
      BUDGET_MOVEMENT_INPUT_KEYS,
      BUDGET_RESERVE_INPUT_KEYS,
      BUDGET_ACTIVATE_INPUT_KEYS,
      BUDGET_SETTLE_INPUT_KEYS,
      BUDGET_RECONCILE_INPUT_KEYS,
    ];
    expect(rosters).toHaveLength(6);
    const forbidden = new Set<string>(BUDGET_CALLER_AUTHORITY_KEYS);
    for (const roster of rosters) {
      expect(roster.length).toBeGreaterThan(0);
      expect(roster.filter((key) => forbidden.has(key))).toEqual([]);
    }
    // The roster names the AUTHORITY a request must never carry — the available view, its
    // buckets and the identity a transition is bound to. `accountId` is deliberately absent: it
    // names WHICH account a hold is placed on, which is intent, not balance. A roster that
    // drifted off these fields would sweep nothing that matters.
    for (const field of ["available", "committed", "meters", "quarantined", "reserved", "state",
      "version", "view", "views"]) {
      expect(forbidden.has(field)).toBe(true);
    }
  });
});

describe("hierarchical movements delegate to the account reducer", () => {
  it("commits allocateToChild's own successor and appends its own entries", () => {
    withBudgetStore("allocate", (store) => {
      seedDurableBindings(store);
      accepted(authorizeBudgetRoot(store, authorizeInput()));
      const prior = priorState(store);

      const result = accepted(
        allocateBudgetToChild(store, movementInput("cmd-allocate", [{ meter: "tokens", amount: 400 }])),
      );

      const reducer = allocateToChild(prior, {
        amounts: [{ meter: "tokens", amount: 400 }], childAccountId: CHILD, childOwnerRef: CHILD_OWNER,
        expectedChildVersion: null, expectedParentVersion: versionOf(prior, BUDGET_ACCOUNT_REF),
        parentAccountId: BUDGET_ACCOUNT_REF,
      });
      expect(reducer.ok).toBe(true);
      expect(canonicalBudgetJson(result.record.accounts)).toBe(canonicalBudgetJson(reducer.state.accounts));
      expect(canonicalBudgetJson(result.record.appended))
        .toBe(canonicalBudgetJson(reducer.state.entries.slice(prior.entries.length)));
      expect(result.record.transition).toBe("ALLOCATED");
    });
  });

  it("passes an account-reducer refusal through with its own code and layer, never restamped", () => {
    withBudgetStore("allocate-over", (store) => {
      seedDurableBindings(store);
      accepted(authorizeBudgetRoot(store, authorizeInput()));
      const before = rawCounts(store, AGGREGATE);

      const result = refused(
        allocateBudgetToChild(store, movementInput("cmd-over", [{ meter: "tokens", amount: 5_000 }])),
      );

      expect(result.code).toBe("BUDGET_LEDGER_TRANSITION_REFUSED");
      expect(result.layer).toBe("BUDGET_LEDGER");
      expect(result.sourceCode).toBe("BUDGET_ACCOUNT_INSUFFICIENT_AVAILABLE");
      expect(result.sourceLayer).toBe("BUDGET_ACCOUNT");
      expect(rawCounts(store, AGGREGATE).events).toBe(before.events);
    });
  });

  it("commits returnToParent's own successor", () => {
    withBudgetStore("return", (store) => {
      seedDurableBindings(store);
      accepted(authorizeBudgetRoot(store, authorizeInput()));
      accepted(allocateBudgetToChild(store, movementInput("cmd-allocate", [{ meter: "tokens", amount: 400 }])));
      const prior = priorState(store);

      const result = accepted(
        returnBudgetToParent(store, movementInput("cmd-return", [{ meter: "tokens", amount: 150 }])),
      );

      const reducer = returnToParent(prior, {
        amounts: [{ meter: "tokens", amount: 150 }], childAccountId: CHILD, childOwnerRef: CHILD_OWNER,
        expectedChildVersion: versionOf(prior, CHILD), expectedParentVersion: versionOf(prior, BUDGET_ACCOUNT_REF),
        parentAccountId: BUDGET_ACCOUNT_REF,
      });
      expect(reducer.ok).toBe(true);
      expect(canonicalBudgetJson(result.record.accounts)).toBe(canonicalBudgetJson(reducer.state.accounts));
      expect(result.record.transition).toBe("RETURNED");
    });
  });

  it("refuses a movement against an account that still holds reserved units", () => {
    withBudgetStore("movement-held", (store) => {
      seedActivatedHold(store);
      const before = rawCounts(store, AGGREGATE);

      const result = refused(
        returnBudgetToParent(store, movementInput("cmd-return-held", [{ meter: "tokens", amount: 10 }])),
      );

      expect(result.code).toBe("BUDGET_LEDGER_ACCOUNT_HELD");
      expect(result.layer).toBe("BUDGET_LEDGER");
      expect(result.sourceLayer).toBeNull();
      expect(rawCounts(store, AGGREGATE).events).toBe(before.events);
    });
  });
});

/**
 * The whole lifecycle behind the drain cases: reserve, activate, settle UNMEASURED, reconcile
 * with an exact receipt. Ends with the child's hold view fully settled — reserved and
 * quarantined both zero, 60 of the 100-token hold committed, 40 refunded back to available —
 * while the CHILD ACCOUNT RECORD still says all 400 allocated tokens are available. (A COMPLETE
 * settle cannot be followed by a reconcile — reconciliation only exits QUARANTINED — so the
 * quarantine detour IS the longest honest lifecycle.)
 */
function seedSettledHold(store: SqliteEventStore): void {
  seedActivatedHold(store);
  const [reservation] = currentLedger(store).reservations;
  if (reservation === undefined) throw new Error("no durable reservation");
  accepted(settleBudgetReservation(store, {
    context: context("cmd-settle-unknown"), goalRef: GOAL_ID, observations: [unknownObservation()],
    projectId: PROJECT_ID, reservationId: reservation.reservationId,
  }));
  accepted(reconcileBudgetSettlement(store, {
    context: context("cmd-reconcile"), goalRef: GOAL_ID, neverStartedProofRef: null,
    observations: [observation({ sequence: 1 })], projectId: PROJECT_ID,
    reservationId: reservation.reservationId,
  }));
}

/**
 * `heldAccount` used to refuse on MERE VIEW EXISTENCE while nothing ever removed a view, so an
 * account that had ever carried a reservation stayed barred from movements FOREVER — while the
 * projection reported its unconsumed units as refundable. The drain is the one composed exit:
 * return EXACTLY the view's refundable units, sized by the VIEW (the account record never learns
 * committed spend), and close the view through the settlement reducer's own terminal.
 */
describe("a fully settled hold view drains back to the parent", () => {
  it("returns exactly the refundable units and commits the view's CLOSED successor", () => {
    withBudgetStore("drain", (store) => {
      seedSettledHold(store);
      const prior = priorState(store);

      const result = accepted(
        returnBudgetToParent(store, movementInput("cmd-drain", [{ meter: "tokens", amount: 340 }])),
      );

      // The account successor is the REDUCER'S own, exactly as for any other movement.
      const reducer = returnToParent(prior, {
        amounts: [{ meter: "tokens", amount: 340 }], childAccountId: CHILD, childOwnerRef: CHILD_OWNER,
        expectedChildVersion: versionOf(prior, CHILD), expectedParentVersion: versionOf(prior, BUDGET_ACCOUNT_REF),
        parentAccountId: BUDGET_ACCOUNT_REF,
      });
      expect(reducer.ok).toBe(true);
      if (!reducer.ok) throw new Error("reducer refused");
      expect(canonicalBudgetJson(result.record.accounts)).toBe(canonicalBudgetJson(reducer.state.accounts));
      expect(canonicalBudgetJson(result.record.appended))
        .toBe(canonicalBudgetJson(reducer.state.entries.slice(prior.entries.length)));
      expect(result.record.transition).toBe("RETURNED");

      // The CLOSED successor is durable, and the projection still reads clean over it — the
      // conservation cross-check passes with the RETURNED entries folded in.
      const current = currentLedger(store);
      const closedView = current.views.find((entry) => entry.accountId === CHILD);
      expect(closedView?.state).toBe("CLOSED");
      expect(closedView?.meters).toEqual([
        { available: 0, committed: 60, meter: "tokens", quarantined: 0, reserved: 0 },
      ]);

      // Nothing vanished and nothing consumed came back: the 340 refundable tokens live at the
      // parent, the 60 committed stay visible on the closed view.
      const parent = current.accounts.find((entry) => entry.accountId === BUDGET_ACCOUNT_REF);
      expect(parent?.meters.find((bucket) => bucket.meter === "tokens")?.available).toBe(940);
      const tokens = current.meters.find((entry) => entry.meter === "tokens");
      expect(tokens?.buckets).toEqual({ available: 940, committed: 60, meter: "tokens", quarantined: 0, reserved: 0 });
      expect(tokens?.coverage).toBe("COMPLETE");
      expect(tokens?.refundable).toBe(940);
    });
  });

  it("sizes the drain by the VIEW, never by the stale account record", () => {
    withBudgetStore("drain-stale-record", (store) => {
      seedSettledHold(store);
      const before = rawCounts(store, AGGREGATE);

      // The trap: the account fold never learned the 60 committed tokens, so the child RECORD
      // still claims the whole 400-token allocation is available.
      const child = currentLedger(store).accounts.find((entry) => entry.accountId === CHILD);
      expect(child?.meters.find((bucket) => bucket.meter === "tokens")?.available).toBe(400);

      // Asking for what the record claims — or any amount but the view's exact 340 — would
      // refund consumed units, so every such request stays refused.
      for (const amount of [400, 341, 60]) {
        const result = refused(returnBudgetToParent(
          store, movementInput(`cmd-drain-record-${amount}`, [{ meter: "tokens", amount }]),
        ));
        expect(result.code).toBe("BUDGET_LEDGER_ACCOUNT_HELD");
        expect(result.sourceLayer).toBeNull();
      }
      expect(rawCounts(store, AGGREGATE).events).toBe(before.events);
    });
  });

  it("keeps refusing while units are still quarantined, even for the exact available balance", () => {
    withBudgetStore("drain-quarantined", (store) => {
      seedActivatedHold(store);
      const [reservation] = currentLedger(store).reservations;
      if (reservation === undefined) throw new Error("no durable reservation");
      accepted(settleBudgetReservation(store, {
        context: context("cmd-settle-unknown"), goalRef: GOAL_ID, observations: [unknownObservation()],
        projectId: PROJECT_ID, reservationId: reservation.reservationId,
      }));
      const before = rawCounts(store, AGGREGATE);

      // Settled but NOT reconciled: the whole hold is quarantined, nothing is refundable yet.
      const result = refused(
        returnBudgetToParent(store, movementInput("cmd-drain-held", [{ meter: "tokens", amount: 300 }])),
      );

      expect(result.code).toBe("BUDGET_LEDGER_ACCOUNT_HELD");
      expect(result.layer).toBe("BUDGET_LEDGER");
      expect(rawCounts(store, AGGREGATE).events).toBe(before.events);
    });
  });

  it("leaves the drained account terminal and the parent fully live", () => {
    withBudgetStore("drain-terminal", (store) => {
      seedSettledHold(store);
      accepted(returnBudgetToParent(store, movementInput("cmd-drain", [{ meter: "tokens", amount: 340 }])));
      const before = rawCounts(store, AGGREGATE);

      // The CLOSED view is the durable bar: the stale child record — still claiming the 60
      // consumed tokens as available — may never move again, in either direction.
      const again = refused(
        returnBudgetToParent(store, movementInput("cmd-drain-again", [{ meter: "tokens", amount: 60 }])),
      );
      expect(again.code).toBe("BUDGET_LEDGER_ACCOUNT_HELD");
      const refund = refused(
        allocateBudgetToChild(store, movementInput("cmd-refund-closed", [{ meter: "tokens", amount: 10 }])),
      );
      expect(refund.code).toBe("BUDGET_LEDGER_ACCOUNT_HELD");
      expect(rawCounts(store, AGGREGATE).events).toBe(before.events);

      // ...while the PARENT is unheld: the drained units fund a fresh child account.
      const sibling = accepted(allocateBudgetToChild(store, {
        ...movementInput("cmd-allocate-sibling", [{ meter: "tokens", amount: 100 }]),
        childAccountId: "child-account-b", childOwnerRef: "graph-node:dev-c",
      }));
      expect(sibling.record.transition).toBe("ALLOCATED");
    });
  });
});

describe("one decision-bound transition, atomically", () => {
  it("leaves ZERO partial movements when the head moves between the read and the commit", () => {
    withBudgetStore("race", (store) => {
      seedDurableBindings(store);
      accepted(authorizeBudgetRoot(store, authorizeInput()));
      const before = rawCounts(store, AGGREGATE);

      const result = refused(allocateBudgetToChild(
        store, movementInput("cmd-raced", [{ meter: "tokens", amount: 400 }]), racingCommitPort(store),
      ));

      expect(result.code).toBe("BUDGET_LEDGER_EXPECTED_VERSION_CONFLICT");
      expect(result.layer).toBe("BUDGET_LEDGER");
      expect(result.sourceCode).toBe("EXPECTED_VERSION_CONFLICT");
      expect(result.sourceLayer).toBe("STORE");
      // Exactly the interloper landed; the refused allocation appended nothing at all.
      const after = store.readEvents(AGGREGATE);
      expect(after).toHaveLength(before.events + 1);
      expect(after.filter((event) => event.eventType === BUDGET_LEDGER_EVENT_TYPE)).toHaveLength(before.events);
    });
  });

  it("returns the ORIGINAL bytes on a same-byte replay and appends nothing", () => {
    withBudgetStore("replay", (store) => {
      seedDurableBindings(store);
      const first = accepted(authorizeBudgetRoot(store, authorizeInput()));
      const before = rawCounts(store, AGGREGATE);

      const second = accepted(authorizeBudgetRoot(store, authorizeInput()));

      expect(second.disposition).toBe("REPLAYED");
      expect(second.digest).toBe(first.digest);
      expect(canonicalBudgetJson(second.record)).toBe(canonicalBudgetJson(first.record));
      expect(rawCounts(store, AGGREGATE)).toEqual(before);
    });
  });

  it("refuses conflicting bytes under one decision identity with the first ledger intact", () => {
    withBudgetStore("replay-conflict", (store) => {
      seedDurableBindings(store);
      const first = accepted(authorizeBudgetRoot(store, authorizeInput()));
      const before = rawCounts(store, AGGREGATE);

      const conflict = refused(authorizeBudgetRoot(store, {
        ...authorizeInput(), amounts: [{ meter: "tokens", amount: 9_999 }],
      }));

      expect(conflict.code).toBe("BUDGET_LEDGER_IDEMPOTENCY_CONFLICT");
      expect(conflict.layer).toBe("BUDGET_LEDGER");
      // THIS ledger refused, not the store: the store never saw the second request.
      expect(conflict.sourceLayer).toBeNull();
      expect(rawCounts(store, AGGREGATE)).toEqual(before);
      expect(canonicalBudgetJson(currentLedger(store).accounts))
        .toBe(canonicalBudgetJson(first.record.accounts));
    });
  });
});

/** The codec's frame is `version LF digest LF body`; these two read and rebuild it by hand so a
 *  tamper can be sealed exactly the way an attacker holding the writer's own codec would. */
function frameBody(bytes: Uint8Array): string {
  const text = new TextDecoder().decode(bytes);
  return text.slice(text.indexOf("\n", text.indexOf("\n") + 1) + 1);
}

function reseal(version: string, body: string): Uint8Array {
  const digest = budgetLedgerDigest(new TextEncoder().encode(body));
  return new TextEncoder().encode([version, digest, body].join("\n"));
}

describe("the canonical record codec", () => {
  it("round-trips a committed record and refuses a version line it does not own", () => {
    withBudgetStore("codec-roundtrip", (store) => {
      seedDurableBindings(store);
      const record = accepted(authorizeBudgetRoot(store, authorizeInput())).record;

      const sealed = encodeBudgetLedgerRecord(record);
      expect(sealed.ok).toBe(true);
      if (!sealed.ok) throw new Error(sealed.code);
      const decoded = decodeBudgetLedgerRecord(sealed.bytes);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) throw new Error(decoded.code);
      expect(canonicalBudgetJson(decoded.record)).toBe(canonicalBudgetJson(record));
      // Deterministic: re-encoding the decoded record reproduces the same seal.
      const resealed = encodeBudgetLedgerRecord(decoded.record);
      expect(resealed.ok).toBe(true);
      if (!resealed.ok) throw new Error(resealed.code);
      expect(resealed.digest).toBe(sealed.digest);

      const body = frameBody(sealed.bytes);
      const foreign = reseal("moe-budget-ledger/2", body);
      const refusedVersion = decodeBudgetLedgerRecord(foreign);
      expect(refusedVersion.ok).toBe(false);
      if (refusedVersion.ok) throw new Error("version drift accepted");
      expect(refusedVersion.code).toBe("BUDGET_LEDGER_VERSION_UNSUPPORTED");
      expect(refusedVersion.layer).toBe("BUDGET_LEDGER");
      expect(refusedVersion.outcome).toBe("UNKNOWN");

      const notBytes = decodeBudgetLedgerRecord("moe-budget-ledger/1");
      expect(notBytes.ok).toBe(false);
      if (notBytes.ok) throw new Error("a string was accepted as record bytes");
      expect(notBytes.code).toBe("BUDGET_LEDGER_BYTES_MALFORMED");
    });
  });

  it("refuses a duplicate key even when the digest over the tampered body agrees", () => {
    withBudgetStore("codec-duplicate-key", (store) => {
      seedDurableBindings(store);
      const record = accepted(authorizeBudgetRoot(store, authorizeInput())).record;
      const sealed = encodeBudgetLedgerRecord(record);
      if (!sealed.ok) throw new Error(sealed.code);

      // `JSON.parse` keeps the LAST of two identical keys, so a smuggled second `sequence` would
      // decode cleanly. The digest is recomputed over the tampered body on purpose: this case
      // exists to prove the RE-ENCODE comparison is what catches it, not the seal.
      const smuggled = `{"sequence":9,${frameBody(sealed.bytes).slice(1)}`;

      const result = decodeBudgetLedgerRecord(reseal("moe-budget-ledger/1", smuggled));

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("duplicate key accepted");
      expect(result.code).toBe("BUDGET_LEDGER_RECORD_MALFORMED");
      expect(result.layer).toBe("BUDGET_LEDGER");
    });
  });

  it("refuses a record past the frame cap with its own code, never generic malformation", () => {
    withBudgetStore("codec-too-large", (store) => {
      seedDurableBindings(store);
      const record = accepted(authorizeBudgetRoot(store, authorizeInput())).record;

      // One reservation row of canonical-JSON bulk past the 4 MiB frame cap. The list's CONTENT
      // is producer-owned and preserved verbatim, so only its size is what the codec judges.
      const bloated = { ...record, reservations: ["x".repeat(4_194_304)] };

      const result = encodeBudgetLedgerRecord(bloated);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("an oversized record was sealed");
      // The distinction is load-bearing: MALFORMED tells a caller to fix the bytes, TOO_LARGE
      // says the record itself no longer fits the frame — acting on the wrong one is what made
      // a grown ledger read as corruption.
      expect(result.code).toBe("BUDGET_LEDGER_RECORD_TOO_LARGE");
      expect(result.code).not.toBe("BUDGET_LEDGER_RECORD_MALFORMED");
      expect(result.layer).toBe("BUDGET_LEDGER");
    });
  });
});

/** The account-ledger state the NEXT movement will be applied to, taken from the production
 *  projection rather than rebuilt: a hand-built prior would be a second implementation of the
 *  fold, and the point of these comparisons is that only the reducer folds. */
function priorState(store: SqliteEventStore): BudgetLedgerState {
  const current = currentLedger(store);
  return {
    accounts: current.accounts, authorized: current.authorization.amounts, entries: current.entries,
    overrun: [], rootAccountId: BUDGET_ACCOUNT_REF,
  };
}

function versionOf(state: BudgetLedgerState, accountId: string): number {
  const account = state.accounts.find((entry) => entry.accountId === accountId);
  if (account === undefined) throw new Error(`no account ${accountId}`);
  return account.version;
}

/**
 * The shape gap the exact-key roster cannot see.
 *
 * Key admission compares NAMES. A declared list field arriving as `undefined`, `null`, a string
 * or any non-array iterable therefore passed admission and reached a reducer as a non-iterable,
 * which THREW — an outcome carrying no stable code and no layer, so no caller can act on it and
 * no test asserting "refused" would ever have seen it.
 */
describe("a declared list field cannot reach a reducer as a non-array", () => {
  it("refuses every non-array amounts with one exact code, over a nonempty generated case set", () => {
    const hostileShapes: readonly unknown[] = [
      undefined, null, "nope", 0, Number.NaN, true, {}, { length: 1, 0: { meter: "tokens", amount: 1 } },
      new Set([{ meter: "tokens", amount: 1 }]),
    ];
    const generated: string[] = [];
    withBudgetStore("amounts-shape", (store) => {
      seedDurableBindings(store);
      const before = rawCounts(store, AGGREGATE);

      for (const [index, amounts] of hostileShapes.entries()) {
        const opened = { ...authorizeInput(`cmd-shape-open-${index}`), amounts };
        const root = refused(authorizeBudgetRoot(store, opened as Parameters<typeof authorizeBudgetRoot>[1]));
        expect(root.code).toBe("BUDGET_LEDGER_INPUT_MALFORMED");
        expect(root.layer).toBe("BUDGET_LEDGER");
        expect(root.sourceLayer).toBeNull();
        generated.push(`authorize:${index}`);

        const move = { ...movementInput(`cmd-shape-move-${index}`, AUTHORIZED), amounts };
        const moved = refused(allocateBudgetToChild(store, move as Parameters<typeof allocateBudgetToChild>[1]));
        expect(moved.code).toBe("BUDGET_LEDGER_INPUT_MALFORMED");
        expect(moved.layer).toBe("BUDGET_LEDGER");
        expect(moved.sourceLayer).toBeNull();
        generated.push(`allocate:${index}`);
      }

      expect(rawCounts(store, AGGREGATE).events).toBe(before.events);
    });

    // A sweep that silently generated nothing passes while testing nothing.
    expect(generated.length).toBe(hostileShapes.length * 2);
    expect(generated.length).toBeGreaterThan(0);
  });

  it("pins ARRAY-NESS ONLY, leaving what is IN the array to the reducer and its own code", () => {
    // The positive control for the guard above. An empty amounts IS a well-formed array, so it
    // must travel PAST this layer and be refused by the account reducer under its own code — a
    // guard that answered here instead would have quietly taken over the reducer's judgement.
    withBudgetStore("amounts-shape-control", (store) => {
      seedDurableBindings(store);
      const before = rawCounts(store, AGGREGATE);

      const result = refused(authorizeBudgetRoot(store, { ...authorizeInput("cmd-shape-empty"), amounts: [] }));

      expect(result.code).toBe("BUDGET_LEDGER_TRANSITION_REFUSED");
      expect(result.layer).toBe("BUDGET_LEDGER");
      expect(result.sourceCode).toBe("BUDGET_ACCOUNT_COMMAND_MALFORMED");
      expect(result.sourceLayer).toBe("BUDGET_ACCOUNT");
      expect(rawCounts(store, AGGREGATE).events).toBe(before.events);
    });
  });
});
