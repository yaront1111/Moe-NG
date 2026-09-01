/**
 * The authenticated `graph.request_expansion` service end to end
 * (task-738a12a816e8421a96edd84648565a38), over a REAL file-backed SqliteEventStore whose goal,
 * parent run and ACTIVE graph are all produced by production writers via `seedActivationWorld`.
 *
 * TWO KINDS OF ARM, AND THE DIFFERENCE MATTERS.
 *   - The PRODUCTION arm passes `unavailableExpansionReleaseAuthority` — the only release reader
 *     production exports — and proves the accepted path is UNREACHABLE and writes nothing while
 *     task-e62e3828df234c66969a99b8223487f4 is absent.
 *   - The COMPOSITION arms pass `testOnlyReleaseAuthorityReader` and prove the real hold reducer,
 *     the real `bindCurrentExpansionHold` and the real two-leg commit fit together. They are not
 *     a claim that release authority exists; the production arm is what says it does not.
 *
 * WINDOWS HANDLE DISCIPLINE: `withFileStore` closes each handle in a `finally` INSIDE the temp
 * directory's own `finally`, and the reopen arm closes before it reopens. A handle held across
 * `rmSync` throws EPERM and kills the vitest worker with no output at all.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SqliteEventStore } from "@moe/store";

import {
  ACTIVATION_WORLD_NODE_KEY,
  seedActivationWorld,
  seedActivationWorldWithoutGraph,
} from "../activation/activation-world-fixtures.js";
import {
  GOAL_ID, PROJECT_ID, RUN_ID, driveThrough,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { readCurrentExpansionRequest } from "./expansion-request-ledger.js";
import {
  EXPANSION_HOLD_EVENT_TYPE,
  EXPANSION_RUN_EVENT_TYPE,
  expansionHoldAggregatePrefix,
} from "./expansion-request-records.js";
import {
  handleExpansionRequest,
  unavailableExpansionReleaseAuthority,
} from "./expansion-request-service.js";
import type { ExpansionRequestContext } from "./expansion-request-service.js";
import { hex64, testOnlyReleaseAuthorityReader } from "./expansion-request-test-fixtures.js";

type Release = ExpansionRequestContext["releaseAuthority"];

const RELEASE = testOnlyReleaseAuthorityReader() as Release;

function payloadOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    goalRef: GOAL_ID,
    parentNodeRef: ACTIVATION_WORLD_NODE_KEY,
    parentRunRef: RUN_ID,
    rationale: "the parent node needs a decomposition",
    ...overrides,
  };
}

function envelopeOf(
  commandId = "cmd-expansion-1", payload: unknown = payloadOf(),
): Record<string, unknown> {
  return {
    commandId,
    correlationId: `corr-${commandId}`,
    decidedAt: "2026-08-26T00:00:00.000Z",
    payload,
    principalId: "principal-1",
    projectId: PROJECT_ID,
  };
}

/** A seeded world on a REAL file, so the reopen arm has a file to reopen. */
function withFileStore<T>(
  run: (store: SqliteEventStore, storePath: string) => T,
  seed: (store: SqliteEventStore) => void = seedActivationWorld,
): T {
  const directory = mkdtempSync(join(tmpdir(), "moe-expansion-request-"));
  const storePath = join(directory, "store.sqlite");
  try {
    const store = SqliteEventStore.openForProject(storePath, PROJECT_ID);
    try {
      seed(store);
      return run(store, storePath);
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { force: true, maxRetries: 5, recursive: true });
  }
}

function holdAggregates(store: SqliteEventStore): readonly string[] {
  return store.enumerateAggregateIdsByPrefix(expansionHoldAggregatePrefix(PROJECT_ID));
}

function eventCounts(store: SqliteEventStore, planningRunRef: string) {
  const holds = holdAggregates(store).flatMap((id) => store.readEvents(id));
  const runs = store.readEvents(planningRunRef);
  return {
    hold: holds.filter((e) => e.eventType === EXPANSION_HOLD_EVENT_TYPE).length,
    run: runs.filter((e) => e.eventType === EXPANSION_RUN_EVENT_TYPE).length,
  };
}

function refusalOf(value: unknown): Record<string, unknown> {
  const refusal = value as Record<string, unknown>;
  expect(refusal["ok"]).toBe(false);
  return refusal;
}

describe("production release authority (task-738a12a816e8421a96edd84648565a38)", () => {
  it("refuses fail-closed and writes nothing, because e62's reader is not on disk", () => {
    withFileStore((store) => {
      const refusal = refusalOf(handleExpansionRequest({
        envelope: envelopeOf(),
        releaseAuthority: unavailableExpansionReleaseAuthority,
        store,
      }));
      expect(refusal["code"]).toBe("EXPANSION_REQUEST_RELEASE_AUTHORITY_UNAVAILABLE");
      expect(refusal["layer"]).toBe("RELEASE_AUTHORITY");
      expect(refusal["sourceCode"]).toBe("EXPANSION_RELEASE_AUTHORITY_ABSENT");
      expect(refusal["sourceLayer"]).toBe("RELEASE_AUTHORITY");
      expect(holdAggregates(store)).toStrictEqual([]);
    });
  });
});

describe("ingress refusals (task-738a12a816e8421a96edd84648565a38)", () => {
  it("refuses a payload carrying any server-owned member, and writes nothing", () => {
    withFileStore((store) => {
      let cases = 0;
      for (const key of ["holdId", "planningRunRef", "generation", "release", "projectId"]) {
        const refusal = refusalOf(handleExpansionRequest({
          envelope: envelopeOf("cmd-hostile", payloadOf({ [key]: "caller-supplied" })),
          releaseAuthority: RELEASE,
          store,
        }));
        expect(refusal["code"]).toBe("EXPANSION_REQUEST_PAYLOAD_MALFORMED");
        expect(refusal["layer"]).toBe("REQUEST");
        cases += 1;
      }
      expect(cases).toBe(5);
      expect(holdAggregates(store)).toStrictEqual([]);
    });
  });

  it("passes the current-authority refusal through unchanged", () => {
    withFileStore((store) => {
      const refusal = refusalOf(handleExpansionRequest({
        envelope: envelopeOf("cmd-absent", payloadOf({ goalRef: "goal-absent" })),
        releaseAuthority: RELEASE,
        store,
      }));
      expect(refusal["code"]).toBe("EXPANSION_REQUEST_GOAL_ABSENT");
      expect(refusal["layer"]).toBe("CURRENT_AUTHORITY");
    });
  });

  it("refuses an envelope whose decidedAt is not a real instant, and writes nothing", () => {
    withFileStore((store) => {
      // The deadline is derived from `decidedAt`; an unparseable one would otherwise reach the
      // hold command as NaN and be refused three layers later, by the wrong layer.
      const refusal = refusalOf(handleExpansionRequest({
        envelope: { ...envelopeOf("cmd-bad-instant"), decidedAt: "not-a-timestamp" },
        releaseAuthority: RELEASE,
        store,
      }));
      expect(refusal["code"]).toBe("EXPANSION_REQUEST_ENVELOPE_MALFORMED");
      expect(refusal["layer"]).toBe("REQUEST");
      expect(holdAggregates(store)).toStrictEqual([]);
    });
  });

  it("passes the core hold reducer's own code and layer through when release is unsafe", () => {
    withFileStore((store) => {
      // A handoff the release evidence does not match: core's `safeRelease` predicate is what
      // refuses, and its exact code must survive the passthrough.
      const mismatched: Release = () => ({
        ...(testOnlyReleaseAuthorityReader()({}) as ReturnType<Release> & { readonly ok: true }),
        workerHandoff: { digest: hex64("ee"), ref: "other-handoff" },
      });
      const refusal = refusalOf(handleExpansionRequest({
        envelope: envelopeOf("cmd-unsafe"), releaseAuthority: mismatched, store,
      }));
      expect(refusal["code"]).toBe("EXPANSION_REQUEST_HOLD_REFUSED");
      expect(refusal["layer"]).toBe("HOLD");
      expect(refusal["sourceCode"]).toBe("EXPANSION_HOLD_SAFE_BOUNDARY_UNPROVEN");
      expect(refusal["sourceLayer"]).toBe("SAFE_BOUNDARY");
      expect(holdAggregates(store)).toStrictEqual([]);
    });
  });
});

describe("accepted composition (task-738a12a816e8421a96edd84648565a38)", () => {
  it("opens one ACTIVE hold and one bound DRAFT EXPANSION run, and nothing else", () => {
    withFileStore((store) => {
      const outcome = handleExpansionRequest({
        envelope: envelopeOf(), releaseAuthority: RELEASE, store,
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.disposition).toBe("DECIDED");
      expect(outcome.holdVersion).toBe(1);
      // Zero downstream authority: the accepted answer names exactly these members and no
      // lease, effect, resource, budget, child or activation of any kind.
      expect(Object.keys(outcome).sort()).toStrictEqual([
        "disposition", "generation", "graphEpoch", "holdId", "holdVersion", "ok",
        "planningRunRef",
      ]);
      expect(outcome.holdId.startsWith("expansion-hold-")).toBe(true);
      expect(outcome.planningRunRef.startsWith("expansion-run-")).toBe(true);
      expect(holdAggregates(store)).toHaveLength(1);
      expect(eventCounts(store, outcome.planningRunRef)).toStrictEqual({ hold: 1, run: 1 });

      const found = readCurrentExpansionRequest(store, {
        generation: outcome.generation,
        goalRef: GOAL_ID,
        graphEpoch: outcome.graphEpoch,
        holdVersion: outcome.holdVersion,
        parentNodeRef: ACTIVATION_WORLD_NODE_KEY,
        parentRunRef: RUN_ID,
        planningRunRef: outcome.planningRunRef,
        projectId: PROJECT_ID,
      });
      expect(found.ok).toBe(true);
      if (!found.ok) return;
      expect(found.pair.hold.lifecycle).toBe("ACTIVE");
      expect(found.pair.run.lifecycle).toBe("DRAFT");
      expect(found.pair.run.runKind).toBe("EXPANSION");
      expect(found.pair.run.goalRef).toBe(GOAL_ID);
      // The binding the run carries is the scheduler's, bound to the daemon's CURRENT goal.
      expect(found.pair.run.runKind === "EXPANSION"
        ? found.pair.run.expansion.holdId : null).toBe(outcome.holdId);
      expect(found.pair.run.runKind === "EXPANSION"
        ? found.pair.run.expansion.truthClass : null).toBe("DAEMON_VERIFIED");
    });
  });

  it("answers an identical replay identically and writes nothing more", () => {
    withFileStore((store) => {
      const first = handleExpansionRequest({
        envelope: envelopeOf(), releaseAuthority: RELEASE, store,
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const decisions = store.readCommandDecisionsAfter(0n, 500).items.length;

      const replay = handleExpansionRequest({
        envelope: envelopeOf(), releaseAuthority: RELEASE, store,
      });
      expect(replay.ok).toBe(true);
      if (!replay.ok) return;
      expect(replay.disposition).toBe("REPLAYED");
      expect({ ...replay, disposition: "DECIDED" }).toStrictEqual({ ...first });
      expect(eventCounts(store, first.planningRunRef)).toStrictEqual({ hold: 1, run: 1 });
      expect(store.readCommandDecisionsAfter(0n, 500).items.length).toBe(decisions);
    });
  });

  it("refuses the same command id with different payload bytes", () => {
    withFileStore((store) => {
      const first = handleExpansionRequest({
        envelope: envelopeOf(), releaseAuthority: RELEASE, store,
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const refusal = refusalOf(handleExpansionRequest({
        envelope: envelopeOf("cmd-expansion-1", payloadOf({ rationale: "different bytes" })),
        releaseAuthority: RELEASE,
        store,
      }));
      expect(refusal["code"]).toBe("EXPANSION_REQUEST_LEDGER_IDEMPOTENCY_CONFLICT");
      expect(refusal["layer"]).toBe("LEDGER");
      expect(eventCounts(store, first.planningRunRef)).toStrictEqual({ hold: 1, run: 1 });
    });
  });

  it("lets exactly one of several racing requests win and writes nothing for the losers", () => {
    withFileStore((store) => {
      const outcomes = ["cmd-race-1", "cmd-race-2", "cmd-race-3"].map((commandId) =>
        handleExpansionRequest({
          envelope: envelopeOf(commandId), releaseAuthority: RELEASE, store,
        }));
      expect(outcomes).toHaveLength(3);
      const winners = outcomes.filter((outcome) => outcome.ok);
      const losers = outcomes.filter((outcome) => !outcome.ok);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(2);
      for (const loser of losers) {
        expect(refusalOf(loser)["code"]).toBe("EXPANSION_REQUEST_LEDGER_VERSION_CONFLICT");
        expect(refusalOf(loser)["layer"]).toBe("LEDGER");
      }
      const winner = winners[0];
      expect(winner?.ok).toBe(true);
      if (winner === undefined || !winner.ok) return;
      expect(holdAggregates(store)).toHaveLength(1);
      expect(eventCounts(store, winner.planningRunRef)).toStrictEqual({ hold: 1, run: 1 });
    });
  });

  it("appends exactly two events store-wide, so no other authority is minted", () => {
    withFileStore((store) => {
      const horizon = store.readEventHorizon();
      const outcome = handleExpansionRequest({
        envelope: envelopeOf(), releaseAuthority: RELEASE, store,
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      // Every event the request added, anywhere in the store — not just on the two aggregates
      // this suite thinks it wrote. A lease, effect, resource, budget, child or activation
      // record would appear here even if it landed on an aggregate nobody asked about.
      const appended = store.readEventsAfter(horizon, 200).items;
      expect(appended.map((event) => event.eventType).sort()).toStrictEqual([
        EXPANSION_HOLD_EVENT_TYPE, EXPANSION_RUN_EVENT_TYPE,
      ].sort());
      expect(new Set(appended.map((event) => event.aggregateId))).toStrictEqual(new Set([
        ...holdAggregates(store), outcome.planningRunRef,
      ]));
      expect(appended).toHaveLength(2);
    });
  });

  it("refuses a goal whose graph was never activated, and writes nothing", () => {
    withFileStore((store) => {
      // A REAL production world: `goal.create` alone leaves the goal DRAFT, so there is no
      // current graph an expansion could be opened against and no authority to borrow.
      const refusal = refusalOf(handleExpansionRequest({
        envelope: envelopeOf("cmd-draft-goal"), releaseAuthority: RELEASE, store,
      }));
      expect(refusal["code"]).toBe("EXPANSION_REQUEST_GOAL_NOT_EXECUTING");
      expect(refusal["layer"]).toBe("CURRENT_AUTHORITY");
      expect(holdAggregates(store)).toStrictEqual([]);
    }, (store) => {
      // The bootstrap prefix a goal needs, and then the goal alone: no plan, no graph.
      driveThrough(store, "goal.create");
      seedActivationWorldWithoutGraph(store);
    });
  });

  it("refuses a parent node the current graph does not contain, and writes nothing", () => {
    withFileStore((store) => {
      const refusal = refusalOf(handleExpansionRequest({
        envelope: envelopeOf("cmd-no-node", payloadOf({ parentNodeRef: "node-not-in-graph" })),
        releaseAuthority: RELEASE,
        store,
      }));
      expect(refusal["code"]).toBe("EXPANSION_REQUEST_PARENT_NODE_ABSENT");
      expect(refusal["layer"]).toBe("CURRENT_AUTHORITY");
      expect(holdAggregates(store)).toStrictEqual([]);
    });
  });

  it("survives close and reopen with exactly one selectable pair on disk", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-expansion-reopen-"));
    const storePath = join(directory, "store.sqlite");
    try {
      const opened = SqliteEventStore.openForProject(storePath, PROJECT_ID);
      let holdId = "";
      let planningRunRef = "";
      let generation = 0;
      let graphEpoch = 0;
      try {
        seedActivationWorld(opened);
        const outcome = handleExpansionRequest({
          envelope: envelopeOf(), releaseAuthority: RELEASE, store: opened,
        });
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        holdId = outcome.holdId;
        planningRunRef = outcome.planningRunRef;
        generation = outcome.generation;
        graphEpoch = outcome.graphEpoch;
      } finally {
        // Close BEFORE reopening: Windows will not let two handles share the file.
        opened.close();
      }
      const reopened = SqliteEventStore.openForProject(storePath, PROJECT_ID);
      try {
        expect(holdAggregates(reopened)).toHaveLength(1);
        expect(eventCounts(reopened, planningRunRef)).toStrictEqual({ hold: 1, run: 1 });
        const found = readCurrentExpansionRequest(reopened, {
          generation,
          goalRef: GOAL_ID,
          graphEpoch,
          holdVersion: 1,
          parentNodeRef: ACTIVATION_WORLD_NODE_KEY,
          parentRunRef: RUN_ID,
          planningRunRef,
          projectId: PROJECT_ID,
        });
        expect(found.ok).toBe(true);
        if (!found.ok) return;
        expect(found.pair.hold.holdId).toBe(holdId);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { force: true, maxRetries: 5, recursive: true });
    }
  });
});
