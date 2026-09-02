/**
 * Durable-store hostile-caller coverage.
 *
 * This is deliberately not disaster-recovery fault coverage.  The fault lane
 * asks whether interrupted execution leaves coherent state; this security lane
 * asks whether forged, stale, replayed, or racing caller input is denied by the
 * production boundary that owns the decision.  Race gates hold hostile callers
 * at admission; this file never performs a crash-point sweep.
 */

import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { afterAll, describe, expect, it } from "vitest";

import { DurableStoreError, SqliteEventStore } from "../../packages/store/src/index.js";
import { storeUnavailable } from "../../apps/daemon/src/recovery/recovery-completion-evidence.js";

import { BOUNDARY_ROSTER } from "./boundary-roster.security.js";
import { assertRefusedWith, cleanupHostileRoots, hostileRoot, probeRacing } from "./hostile-harness.js";
import type { RaceOutcome, RefusalExpectation } from "./hostile-harness.js";
import {
  DURABLE_BOUNDARY_NAMES,
  DURABLE_CLOSURE_PHASES,
  DURABLE_STORE_CLOSURE_NAMES,
  durableClosureCases,
  hostileAfterCases,
  hostileBeforeCases,
  hostileRaceCases,
  runClosureCase,
  runRefusalCase,
  safeBoundaryLookupRace,
} from "./durable-store-boundary-scenarios.js";
import type { RaceCase } from "./durable-store-boundary-scenarios.js";
import {
  projectCatalogAcceptedControl,
  projectCatalogRace,
} from "./project-catalog-durable-scenarios.js";
import {
  SEEDED_IMPORT_ROWS,
  importShadowClosedStore,
  importShadowMidReadCommit,
  importShadowMissingRow,
  importShadowRoot,
} from "./import-shadow-boundary-scenarios.js";
import {
  REASON_VARIANTS,
  closeSafeBoundaryStores,
  safeBoundaryKeyDivergence,
  safeBoundaryObservedControl,
  safeBoundaryRace,
  safeBoundaryReasonSweep,
} from "./safe-boundary-observation-scenarios.js";
import {
  SAFE_BOUNDARY_OBSERVATION_LAYER, SAFE_BOUNDARY_REASON_CODES,
} from "../../apps/daemon/src/work/safe-boundary-observation.js";
import { RECENT_DURABLE_HOSTILE_CASES } from "./recent-durable-hostile-cases.js";
import { RECENT_DELIVERY_V2_DURABLE_CASES } from "./recent-delivery-v2-hostile-cases.js";

/** Every table-backed recent durable case, in one roster so a table registered here
 *  is also the table `recentNames` is derived from below. */
const RECENT_DURABLE_CASES = Object.freeze([
  ...RECENT_DURABLE_HOSTILE_CASES,
  ...RECENT_DELIVERY_V2_DURABLE_CASES,
]);

afterAll(() => {
  // Handles first, roots after: a held SQLite handle IS the EPERM a retry cannot fix, and in
  // a `fileParallelism: false` lane one leaked handle takes every file scheduled after this.
  closeSafeBoundaryStores();
  cleanupHostileRoots();
});

const rosterNames = BOUNDARY_ROSTER
  .filter((entry) => entry.axis === "durable-store")
  .map((entry) => entry.constant)
  .sort();

interface RaceWorkerResult {
  readonly code?: string;
  readonly disposition?: string;
}

interface RaceWorkerHandle {
  readonly preOpenReady: Promise<void>;
  readonly ready: Promise<void>;
  readonly result: Promise<RaceWorkerResult>;
  readonly worker: Worker;
}

interface RaceCaseResult {
  readonly admittedSides: number;
  readonly durableEvents: number;
  readonly outcome: RaceOutcome<RaceWorkerResult, RaceWorkerResult>;
  readonly refusal: unknown;
  readonly winner: string;
  readonly winnerPayloads: readonly string[];
}

function startRaceWorker(databasePath: string, gate: SharedArrayBuffer, suffix: string): RaceWorkerHandle {
  const worker = new Worker(
    new URL("../../packages/store/src/sqlite-event-store-race-worker.mjs", import.meta.url),
    {
      execArgv: ["--experimental-strip-types"],
      workerData: {
        commandBytes: `command-${suffix}`,
        commandId: `cmd-${suffix}`,
        committedAt: "2026-08-16T00:00:00.000Z",
        databasePath,
        eventId: `evt-${suffix}`,
        gate,
      },
    },
  );
  let ready!: () => void;
  let preOpenReady!: () => void;
  let resolveResult!: (value: RaceWorkerResult) => void;
  let rejectAll!: (error: Error) => void;
  const preOpen = new Promise<void>((resolve, reject) => { preOpenReady = resolve; rejectAll = reject; });
  const opened = new Promise<void>((resolve, reject) => {
    ready = resolve;
    const prior = rejectAll;
    rejectAll = (error) => { prior(error); reject(error); };
  });
  const result = new Promise<RaceWorkerResult>((resolve, reject) => {
    resolveResult = resolve;
    const prior = rejectAll;
    rejectAll = (error) => { prior(error); reject(error); };
  });
  worker.on("message", (message: unknown) => {
    if (message === null || typeof message !== "object" || !("kind" in message)) return;
    if (message.kind === "PREOPEN_READY") preOpenReady();
    else if (message.kind === "READY") ready();
    else if (message.kind === "RESULT") resolveResult(message as RaceWorkerResult);
  });
  worker.on("error", rejectAll);
  worker.on("exit", (code) => { if (code !== 0) rejectAll(new Error(`race worker exited with ${code}`)); });
  void preOpen.catch(() => undefined);
  void opened.catch(() => undefined);
  void result.catch(() => undefined);
  return { preOpenReady: preOpen, ready: opened, result, worker };
}

const fulfilled = (outcome: RaceOutcome<RaceWorkerResult, RaceWorkerResult>): RaceWorkerResult[] => {
  if (outcome.left.status === "rejected") throw outcome.left.reason;
  if (outcome.right.status === "rejected") throw outcome.right.reason;
  return [outcome.left.value, outcome.right.value];
};

async function runRaceCase(hostileCase: RaceCase): Promise<RaceCaseResult> {
  const root = hostileRoot(`race-${hostileCase.boundary.toLowerCase()}`);
  const databasePath = join(root, "events.sqlite");
  const initializer = SqliteEventStore.openForProject(databasePath, "moe-test-project");
  try { initializer.getAggregateVersion("race-schema-probe"); }
  finally { initializer.close(); }
  const gate = new SharedArrayBuffer(8);
  const gateView = new Int32Array(gate);
  const left = startRaceWorker(databasePath, gate, "left");
  const right = startRaceWorker(databasePath, gate, "right");
  const bound = { label: hostileCase.boundary, timeoutMs: 5_000 } as const;
  try {
    await probeRacing(bound, () => left.preOpenReady, () => right.preOpenReady);
    Atomics.store(gateView, 0, 1); Atomics.notify(gateView, 0, 2);
    await probeRacing(bound, () => left.ready, () => right.ready);
    Atomics.store(gateView, 1, 1); Atomics.notify(gateView, 1, 2);
    const outcome = await probeRacing(bound, () => left.result, () => right.result);
    const sides = fulfilled(outcome);
    const admittedSides = sides.filter((side) => side.disposition === "COMMITTED").length;
    const refused = sides.filter((side) => side.code !== undefined);
    if (refused.length !== 1 || refused[0]?.code !== "EXPECTED_VERSION_CONFLICT") {
      throw new Error(`race refusal was not EXPECTED_VERSION_CONFLICT: ${JSON.stringify(sides)}`);
    }
    const reader = SqliteEventStore.openForProject(databasePath, "moe-test-project");
    try {
      const events = reader.readEvents("goal-race");
      const winnerPayloads = events.map((event) => text(event.payload));
      const refusal = storeUnavailable(new DurableStoreError(refused[0].code, "hostile writer lost"));
      return { admittedSides, durableEvents: events.length, outcome, refusal: refusal.upstream,
        winner: winnerPayloads[0] ?? "", winnerPayloads };
    } finally { reader.close(); }
  } finally {
    Atomics.store(gateView, 0, 1); Atomics.notify(gateView, 0, 2);
    Atomics.store(gateView, 1, 1); Atomics.notify(gateView, 1, 2);
    await Promise.allSettled([left.worker.terminate(), right.worker.terminate()]);
  }
}

/**
 * The import-shadow read owns no writer, so the two-worker version race above cannot reach
 * it and its arm is graded SEPARATELY rather than through a fabricated `RaceOutcome`. Its
 * race is the one a pure reader loses: a real commit from a second connection landing
 * between the horizon it opened on and the horizon it closed on. Every value asserted here
 * is read back off the live store after the read returned.
 */
const IMPORT_SHADOW_RACE_CASES = hostileRaceCases
  .filter((entry) => entry.boundary === "IMPORT_SHADOW_READ_LAYER");
/**
 * The safe-boundary observation is graded separately for the opposite reason to the import
 * shadow's: it owns a writer, but byte-identical concurrent writers converge to one durable
 * row and both callers succeed. The two-worker runner asserts `EXPECTED_VERSION_CONFLICT`
 * and one admission on a store it opened itself, so neither half of it fits.
 */
const SAFE_BOUNDARY_RACE_CASES = hostileRaceCases
  .filter((entry) => entry.boundary === "SAFE_BOUNDARY_OBSERVATION_LAYER");
const SAFE_BOUNDARY_LOOKUP_RACE_CASES = hostileRaceCases
  .filter((entry) => entry.boundary === "SAFE_BOUNDARY_LOOKUP_LAYER");
const PROJECT_CATALOG_RACE_CASES = hostileRaceCases
  .filter((entry) => entry.boundary === "PROJECT_CATALOG_LAYER");
const WORKER_RACE_CASES = hostileRaceCases.filter((entry) =>
  entry.boundary !== "IMPORT_SHADOW_READ_LAYER"
  && entry.boundary !== "SAFE_BOUNDARY_LOOKUP_LAYER"
  && entry.boundary !== "SAFE_BOUNDARY_OBSERVATION_LAYER"
  && entry.boundary !== "PROJECT_CATALOG_LAYER");

function requiredRaceRefusal(hostileCase: RaceCase): RefusalExpectation {
  if (hostileCase.expected === undefined) {
    throw new Error(`${hostileCase.boundary} has no refusing race outcome`);
  }
  return hostileCase.expected;
}

function gradeImportShadowRace(hostileCase: RaceCase): void {
  const outcome = importShadowMidReadCommit(importShadowRoot("race"));
  // TWO horizons, and they DIFFER: the reader really re-read, and the racing commit really
  // moved the store. Without both, HORIZON_DRIFT could be reported by a reader that never
  // looked twice.
  expect(outcome.horizons).toHaveLength(2);
  expect(outcome.horizons[0]).not.toStrictEqual(outcome.horizons[1]);
  assertRefusedWith(outcome.refusal, requiredRaceRefusal(hostileCase));
  expect(outcome.durableEvents).toBe(hostileCase.expectedDurableEvents);
  expect(outcome.seededRecords).toBe(SEEDED_IMPORT_ROWS);
  expect(outcome.durableComplete).toBe(true);
  // Same anti-echo pair as the AFTER arm: production freezes its refusals, and this one
  // quotes BOTH horizons the store actually moved between. Neither operand is written down.
  expect(outcome.refusalFrozen).toBe(true);
  expect(outcome.refusalDetail)
    .toContain(`from ${outcome.horizons[0] ?? ""} to ${outcome.horizons[1] ?? ""}`);
}

/**
 * The safe-boundary race, graded on the DURABLE state rather than on what either caller was
 * told. Both callers derive the same observation identity from the same durable run and race
 * for `expectedVersion 0` on one aggregate; EXACTLY ONE may own it (task-f8ea0a2f). The
 * defect this replaced was the opposite of a lost write — a SECOND ADMISSION, handed out by
 * byte-equality replay to a caller that had written nothing.
 */
function gradeSafeBoundaryRace(hostileCase: RaceCase): void {
  const outcome = safeBoundaryRace();
  // Order-independent: the assertion is on the multiset, never which caller committed.
  expect(outcome.sides).toHaveLength(2);
  expect(outcome.admittedSides).toBe(1);
  const winner = (outcome.sides as readonly Record<string, unknown>[])
    .find((side) => side["ok"] === true);
  expect(winner?.["disposition"]).toBe("COMMITTED");
  assertRefusedWith(outcome.refusal, requiredRaceRefusal(hostileCase));
  // The store's OWN code survives the wrap: a flattened refusal names no upstream authority.
  expect(outcome.upstreamCode).toBe("EXPECTED_VERSION_CONFLICT");
  expect(outcome.durableRecords).toBe(hostileCase.expectedDurableEvents);
  expect(outcome.durableComplete).toBe(true);
}

/**
 * The lookup is a pure reader. Its first side captures a horizon, then a real observation lands
 * from another connection before the scan; production must return bounded ABSENT rather than a
 * torn row. A second reader after the commit must return the newest certified observation.
 */
function gradeSafeBoundaryLookupRace(hostileCase: RaceCase): void {
  const outcome = safeBoundaryLookupRace();
  expect(outcome.sides).toHaveLength(2);
  expect(outcome.admittedSides).toBe(1);
  assertRefusedWith(outcome.refusal, requiredRaceRefusal(hostileCase));
  expect(outcome.newestObservationRef).toMatch(/^[0-9a-f]{64}$/u);
  expect(outcome.durableRecords).toBe(hostileCase.expectedDurableEvents);
  expect(outcome.durableComplete).toBe(true);
}

async function gradeProjectCatalogRace(hostileCase: RaceCase): Promise<void> {
  const outcome = await projectCatalogRace(hostileRoot("race-project-catalog"));
  expect(outcome.sides).toHaveLength(2);
  expect(outcome.admittedSides).toBe(0);
  for (const side of outcome.sides) assertRefusedWith(side, requiredRaceRefusal(hostileCase));
  expect(outcome.durableRecords).toBe(hostileCase.expectedDurableEvents);
  expect(outcome.durableComplete).toBe(true);
}

describe("durable-store roster coverage", () => {
  it("takes the durable-store subset from the committed roster in both directions", () => {
    // 15 -> 16 on 2026-08-20: SAFE_BOUNDARY_OBSERVATION_LAYER (producer task-ded026d6,
    // roster entry and arms task-120403f7). Counted off the roster's committed bytes by the
    // set assertion below; this literal is what makes a silently-shrunk subset redden.
    // 16 -> 17 for the atomic project catalog, including preservation and concurrent-hostile
    // writer controls over the real filesystem implementation.
    // 17 -> 18 on 2026-08-27: attempt-keyed safe-boundary lookup, including its bounded
    // mid-scan reader race and delegated observation-reader provenance.
    expect(DURABLE_BOUNDARY_NAMES).toHaveLength(18);
    const recentNames = [...new Set(RECENT_DURABLE_CASES.map((entry) => entry.boundary))];
    expect([...DURABLE_BOUNDARY_NAMES, ...recentNames].sort()).toStrictEqual(rosterNames);
  });

  it.each(DURABLE_BOUNDARY_NAMES)("generates hostile BEFORE and AFTER cases for %s", (boundary) => {
    expect(hostileBeforeCases.filter((entry) => entry.boundary === boundary).length).toBeGreaterThan(0);
    expect(hostileAfterCases.filter((entry) => entry.boundary === boundary).length).toBeGreaterThan(0);
    expect(hostileRaceCases.filter((entry) => entry.boundary === boundary).length).toBeGreaterThan(0);
  });
});

describe("recent durable readers refuse hostile input on all three arms", () => {
  for (const hostileCase of RECENT_DURABLE_CASES) {
    it(`${hostileCase.arm} ${hostileCase.boundary}`, async () => {
      const outcome = await hostileCase.run();
      if (hostileCase.arm === "RACE") {
        const sides = outcome as readonly [unknown, unknown];
        expect(sides).toHaveLength(2);
        for (const side of sides) assertRefusedWith(side, hostileCase.expected);
        return;
      }
      assertRefusedWith(outcome, hostileCase.expected);
    });
  }
});

/**
 * THE POSITIVE CONTROL FOR THE IMPORT-SHADOW ARMS.
 *
 * Every other assertion about this boundary is a refusal, and a refusal-only subject cannot
 * distinguish a reader that fails closed from a driver that hands back the expectation it
 * was given. This asks the same driver, on the same seeded import, for the answer no echo
 * can fabricate: an ACCEPTANCE whose entity count `projectDaemonImportShadow` derived from
 * the importer's own committed bytes. Mutate the driver to stop calling
 * `readImportShadowProjection` and this is what reddens.
 */
describe("the import-shadow read admits what it should", () => {
  it("ACCEPT IMPORT_SHADOW_READ_LAYER: an intact committed import projects real entities", () => {
    const outcome = importShadowMissingRow(importShadowRoot("control"));
    expect(outcome.acceptedOk).toBe(true);
    // EXACTLY three, not "at least": two CLAIM entities plus the one RELATED link the second
    // corpus record declares. A >= would stay green if the mapper started dropping the link.
    expect(outcome.acceptedEntities).toBe(SEEDED_IMPORT_ROWS + 1);
    expect(outcome.durableRecords).toBe(SEEDED_IMPORT_ROWS);
  });

  /**
   * The refusal TUPLE cannot police its own driver: a hand-built object carrying the same
   * code and layer satisfies it exactly. Measured, not assumed -- echoing the AFTER refusal
   * left every tuple assertion green. These two operands are the ones an echo has to earn:
   * production FREEZES what `refuseImportShadow` builds, and it quotes the aggregateSequence
   * the surviving row actually carries, a number read back out of the store rather than
   * written down anywhere in this lane.
   */
  /**
   * The BEFORE arm's own provenance check. `readEvents` on a closed handle answers the SAME
   * IMPORT_SHADOW_STORE_UNREADABLE from a DIFFERENT branch, so the tuple alone cannot claim
   * the horizon read is the gate that answered -- only the detail can.
   */
  it("ACCEPT IMPORT_SHADOW_READ_LAYER: the closed reader refuses at the horizon, not later", () => {
    const outcome = importShadowClosedStore(importShadowRoot("closed-provenance"));
    expect(outcome.refusalFrozen).toBe(true);
    expect(outcome.refusalDetail).toMatch(/^horizon unreadable: /u);
  });

  it("ACCEPT IMPORT_SHADOW_READ_LAYER: the refusal is production's own frozen object, naming the real hole", () => {
    const outcome = importShadowMissingRow(importShadowRoot("provenance"));
    expect(outcome.refusalFrozen).toBe(true);
    expect(outcome.holeAt).toBeGreaterThan(1);
    expect(outcome.refusalDetail).toContain(`aggregateSequence ${String(outcome.holeAt)}`);
  });
});

describe("the project catalog admits canonical durable bytes", () => {
  it("ACCEPT PROJECT_CATALOG_LAYER: an atomic save round-trips one exact catalog", async () => {
    const outcome = await projectCatalogAcceptedControl(hostileRoot("control-project-catalog"));
    expect(outcome.ok).toBe(true);
    expect(outcome.persisted).toBe(true);
    expect(outcome.entries).toBe(0);
  });
});

/**
 * THE POSITIVE CONTROLS FOR THE SAFE-BOUNDARY ARMS.
 *
 * Both hostile arms above are refusals, and a writer that refuses everything explains them
 * equally well while holding no rule. These drive the SAME production writer over records
 * that are LEGAL and COMMITTED, where the boundary is not proven for one reason each — the
 * answer is a durable `false` naming its clause, which is a fact the release path needs, not
 * a refusal. Nothing here recomputes the predicate: every value is read back off what
 * production wrote.
 */
describe("the safe-boundary observation records what it should", () => {
  const proofs = safeBoundaryReasonSweep();

  it("ACCEPT SAFE_BOUNDARY_OBSERVATION_LAYER: generates one arranged variant per reason code", () => {
    // A sweep that silently produced NOTHING would satisfy every set assertion below while
    // testing nothing at all, so the generated count is pinned before any outcome is read.
    expect(REASON_VARIANTS.length).toBeGreaterThan(0);
    expect(proofs).toHaveLength(REASON_VARIANTS.length);
  });

  it("ACCEPT SAFE_BOUNDARY_OBSERVATION_LAYER: every declared reason code is REACHABLE", () => {
    // Both directions against production's OWN frozen vocabulary: a reason code that can no
    // longer be produced reddens, and a code produced that the vocabulary does not declare
    // reddens too. Neither operand is hand-written here.
    const observed = [...new Set(proofs.map((proof) => String(proof.reasonCode)))].sort();
    expect(observed).toStrictEqual([...SAFE_BOUNDARY_REASON_CODES].sort());
  });

  it("ACCEPT SAFE_BOUNDARY_OBSERVATION_LAYER: a present record that fails a clause is FALSE", () => {
    expect(proofs.filter((proof) => proof.observed !== false)).toStrictEqual([]);
  });

  /**
   * The one case no refusal and no recorded `false` can stand in for. Without it, a predicate
   * hard-wired to answer false would satisfy every assertion in this file — and the arm that
   * makes it subtle is `{kind: "UNOBSERVED"}`, which is NON-NULL: an `exit !== null` predicate
   * answers TRUE on the one value that denies observation, and would be caught only here and
   * by the `unobserved` variant disagreeing with it.
   */
  it("ACCEPT SAFE_BOUNDARY_OBSERVATION_LAYER: a run the host DID see is recorded TRUE", () => {
    const control = safeBoundaryObservedControl();
    expect(control.observed).toBe(true);
    expect(control.reasonCode).toBeNull();
  });
});

/**
 * TASK-F8 — THE DIVERGENCE ARM: command-key ownership is the ONLY thing separating these two
 * calls, and the fixture proves that at the seam instead of asserting it in prose.
 *
 * Every other fence is arranged OPEN. The input is canonical (INPUT_MALFORMED cannot answer),
 * the run is seeded readable and observed (RUN_UNREADABLE cannot), nothing is read back
 * (OBSERVATION_ABSENT/UNREADABLE cannot). Loosen the one guard — let byte equality stand in
 * for ownership — and the single admission below becomes two.
 */
describe("TASK-F8 distinct command keys cannot both own one observation", () => {
  const divergence = safeBoundaryKeyDivergence();
  const commitInputs = divergence.commitInputs as unknown as readonly Record<string, unknown>[];
  const keyOf = (input: Record<string, unknown>): Record<string, unknown> =>
    input["key"] as Record<string, unknown>;
  /** Everything EXCEPT the one varied field, so a fixture that drifted a second field is a
   *  failure here rather than a silent second explanation for the refusal below. */
  const normalized = (input: Record<string, unknown>): Record<string, unknown> =>
    ({ ...input, key: { ...keyOf(input), commandId: "NORMALIZED" } });

  it("TASK-F8 varies exactly one field of the two production commit inputs", () => {
    // Nonzero first: a fixture that reached the store ZERO times would satisfy every
    // set comparison below while proving nothing.
    expect(commitInputs).toHaveLength(2);
    const [left, right] = commitInputs as [Record<string, unknown>, Record<string, unknown>];
    expect(keyOf(left)["commandId"]).not.toStrictEqual(keyOf(right)["commandId"]);
    // Same aggregate, same expectedVersion, same request bytes, same committed bytes, same
    // events, same correlation id — read off what production built, never restated here.
    expect(normalized(left)).toStrictEqual(normalized(right));
  });

  it("TASK-F8 admits exactly one caller and writes exactly one durable observation", () => {
    expect(divergence.admittedSides).toBe(1);
    const winner = (divergence.sides as readonly Record<string, unknown>[])
      .find((side) => side["ok"] === true);
    expect(winner?.["disposition"]).toBe("COMMITTED");
    expect(divergence.durableRecords).toBe(1);
    expect(divergence.durableComplete).toBe(true);
  });

  it("TASK-F8 refuses the loser under its own layer, keeping the store conflict upstream", () => {
    assertRefusedWith(divergence.refusal, {
      code: "SAFE_BOUNDARY_COMMIT_CONFLICT", layer: SAFE_BOUNDARY_OBSERVATION_LAYER,
    });
    expect(divergence.upstreamCode).toBe("EXPECTED_VERSION_CONFLICT");
  });
});

describe("hostile durable-store races", () => {
  it("splits the race arms into the four runners with nothing left over", () => {
    expect(IMPORT_SHADOW_RACE_CASES).toHaveLength(1);
    expect(SAFE_BOUNDARY_LOOKUP_RACE_CASES).toHaveLength(1);
    expect(SAFE_BOUNDARY_RACE_CASES).toHaveLength(1);
    expect(PROJECT_CATALOG_RACE_CASES).toHaveLength(1);
    expect(WORKER_RACE_CASES).toHaveLength(DURABLE_BOUNDARY_NAMES.length - 4);
  });

  for (const hostileCase of WORKER_RACE_CASES) {
    it(`RACE ${hostileCase.boundary}: ${hostileCase.question}`, async () => {
      const result = await runRaceCase(hostileCase);
      expect(result.admittedSides).toBe(1);
      expect(result.outcome.left.status).toBe("fulfilled");
      expect(result.outcome.right.status).toBe("fulfilled");
      assertRefusedWith(result.refusal, requiredRaceRefusal(hostileCase));
      expect(result.durableEvents).toBe(hostileCase.expectedDurableEvents);
      expect(result.winnerPayloads).toStrictEqual([result.winner]);
    });
  }

  for (const hostileCase of IMPORT_SHADOW_RACE_CASES) {
    it(`RACE ${hostileCase.boundary}: ${hostileCase.question}`, () => {
      gradeImportShadowRace(hostileCase);
    });
  }

  for (const hostileCase of SAFE_BOUNDARY_RACE_CASES) {
    it(`RACE ${hostileCase.boundary}: ${hostileCase.question}`, () => {
      gradeSafeBoundaryRace(hostileCase);
    });
  }

  for (const hostileCase of SAFE_BOUNDARY_LOOKUP_RACE_CASES) {
    it(`RACE ${hostileCase.boundary}: ${hostileCase.question}`, () => {
      gradeSafeBoundaryLookupRace(hostileCase);
    });
  }

  for (const hostileCase of PROJECT_CATALOG_RACE_CASES) {
    it(`RACE ${hostileCase.boundary}: ${hostileCase.question}`, async () => {
      await gradeProjectCatalogRace(hostileCase);
    });
  }
});

describe("hostile durable-store caller input", () => {
  for (const hostileCase of [...hostileBeforeCases, ...hostileAfterCases]) {
    it(`${hostileCase.phase} ${hostileCase.boundary}: ${hostileCase.question}`, async () => {
      const result = await runRefusalCase(hostileCase);
      assertRefusedWith(result.refusal, hostileCase.expected);
      if (hostileCase.upstream !== undefined) {
        expect(result.upstream).toStrictEqual(hostileCase.upstream);
      }
      if (hostileCase.boundary === "DURABLE_STORE_LAYER") {
        expect(result.primary).toStrictEqual({
          code: "RECOVERY_COMPLETION_STORE_UNAVAILABLE",
          refusedBy: "RECOVERY_COMPLETION",
        });
      }
      expect(result.durableRecords).toBe(hostileCase.preexistingRecords);
      expect(result.durableComplete).toBe(true);
      expect([undefined, "UNKNOWN"]).toContain(result.truth);
      expect([undefined, "NONE"]).toContain(result.authority);
    });
  }
});

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const text = (value: Uint8Array): string => new TextDecoder().decode(value);

describe("changed-byte replay reads the durable answer", () => {
  for (const boundary of DURABLE_BOUNDARY_NAMES) {
    it(`CHANGED-BYTE REPLAY ${boundary} never echoes the caller record`, () => {
      const root = hostileRoot(`replay-${boundary.toLowerCase()}`);
      const store = SqliteEventStore.openForProject(join(root, "events.sqlite"), "security-project");
      const aggregateId = `security-replay:${boundary}`;
      const key = { commandId: `replay-${boundary}`, principalId: "principal", projectId: "security-project" };
      const input = {
        commandKind: `SECURITY_${boundary}`,
        correlationId: "correlation",
        decidedAt: "2026-08-16T00:00:00.000Z",
        expectedVersion: 0,
        key,
        requestBytes: bytes("stable-request"),
        targetAggregateId: aggregateId,
      } as const;
      try {
        const first = store.commitExpectedVersionDecision({
          ...input,
          committedResultBytes: bytes("durable-answer"),
          events: [{ eventId: `${key.commandId}:durable`, eventType: "DurableAnswer", payload: bytes("durable-event") }],
        });
        const replay = store.commitExpectedVersionDecision({
          ...input,
          committedResultBytes: bytes("hostile-caller-answer"),
          events: [{ eventId: `${key.commandId}:hostile`, eventType: "HostileEcho", payload: bytes("hostile-event") }],
        });
        expect(first.disposition).toBe("DECIDED");
        expect(replay.disposition).toBe("REPLAYED");
        expect(text(replay.decision.resultBytes)).toBe("durable-answer");
        expect(store.readEvents(aggregateId).map((event) => text(event.payload))).toStrictEqual(["durable-event"]);
      } finally {
        store.close();
      }
    });
  }
});

it("whole-slice invariant: hostile refusals never create fragments or authority", async () => {
  const refusalResults = [];
  for (const hostileCase of [...hostileBeforeCases, ...hostileAfterCases]) {
    refusalResults.push({ hostileCase, result: await runRefusalCase(hostileCase) });
  }
  const raceResults = [];
  for (const hostileCase of WORKER_RACE_CASES) {
    raceResults.push({ hostileCase, result: await runRaceCase(hostileCase) });
  }
  for (const hostileCase of IMPORT_SHADOW_RACE_CASES) gradeImportShadowRace(hostileCase);
  for (const hostileCase of SAFE_BOUNDARY_LOOKUP_RACE_CASES) gradeSafeBoundaryLookupRace(hostileCase);
  for (const hostileCase of SAFE_BOUNDARY_RACE_CASES) gradeSafeBoundaryRace(hostileCase);
  for (const hostileCase of PROJECT_CATALOG_RACE_CASES) await gradeProjectCatalogRace(hostileCase);
  expect(refusalResults).toHaveLength(DURABLE_BOUNDARY_NAMES.length * 2);
  expect(raceResults).toHaveLength(DURABLE_BOUNDARY_NAMES.length - 4);
  expect(IMPORT_SHADOW_RACE_CASES).toHaveLength(1);
  expect(SAFE_BOUNDARY_LOOKUP_RACE_CASES).toHaveLength(1);
  expect(SAFE_BOUNDARY_RACE_CASES).toHaveLength(1);
  expect(PROJECT_CATALOG_RACE_CASES).toHaveLength(1);
  expect(refusalResults.every(({ hostileCase, result }) =>
    result.durableComplete && result.durableRecords === hostileCase.preexistingRecords
    && (result.truth === undefined || result.truth === "UNKNOWN")
    && (result.authority === undefined || result.authority === "NONE"))).toBe(true);
  expect(raceResults.every(({ hostileCase, result }) => result.admittedSides === 1
    && result.durableEvents === hostileCase.expectedDurableEvents
    && result.winnerPayloads.length === 1 && result.winnerPayloads[0] === result.winner)).toBe(true);
}, 30_000);

/**
 * task-f8ea0a2f — the three durable-store CLOSURE subjects.
 *
 * They are deliberately NOT in `DURABLE_BOUNDARY_NAMES`: that tuple is the ADVERTISED
 * roster the master boundary scan is compared against, and task-45839f34 is the declared
 * downstream consumer that will publish these three names there once these arms exist. The
 * arms land first, so the advertisement is never ahead of the coverage. The set assertions
 * below are what makes that separation mechanical rather than a comment.
 */
describe("TASK-F8 durable-store closure subjects", { timeout: 120_000 }, () => {
  it("TASK-F8 pins the closure tuple and its generated cases as exact bidirectional sets", () => {
    expect(Object.isFrozen(DURABLE_STORE_CLOSURE_NAMES)).toBe(true);
    // THREE subjects, exactly: a fourth would be an unarmed advertisement and a missing one
    // would shrink this suite's own iteration while staying green.
    expect(DURABLE_STORE_CLOSURE_NAMES).toHaveLength(3);
    expect([...DURABLE_STORE_CLOSURE_NAMES].sort()).toStrictEqual([
      "CUTOVER_ATTEMPT_LAYER", "CUTOVER_GENERATION_SNAPSHOT_LAYER", "IMPORT_GENERATION_READ_LAYER",
    ]);
    // BOTH directions between the tuple and what the case table actually generated: a
    // one-way subset check cannot see a subject that generated no arm at all.
    const generated = [...new Set(durableClosureCases.map((entry) => entry.boundary))].sort();
    expect(generated).toStrictEqual([...DURABLE_STORE_CLOSURE_NAMES].sort());
    expect([...DURABLE_STORE_CLOSURE_NAMES].sort()).toStrictEqual(generated);
    // Still unadvertised, so task-45839f34's 18-name comparison above stays exactly as it is.
    for (const name of DURABLE_STORE_CLOSURE_NAMES) {
      expect(DURABLE_BOUNDARY_NAMES).not.toContain(name);
    }
  });

  it("TASK-F8 generates one nonzero arm per subject per phase and nothing else", () => {
    expect(DURABLE_CLOSURE_PHASES).toStrictEqual(["BEFORE", "AFTER", "RACE"]);
    expect(durableClosureCases).toHaveLength(9);
    for (const phase of DURABLE_CLOSURE_PHASES) {
      const arms = durableClosureCases.filter((entry) => entry.phase === phase);
      // Nonzero AND exact: a sweep that silently yielded zero cases passes every `for`
      // loop below without executing one of them.
      expect([phase, arms.length]).toStrictEqual([phase, 3]);
      for (const boundary of DURABLE_STORE_CLOSURE_NAMES) {
        expect([phase, boundary,
          arms.filter((entry) => entry.boundary === boundary).length]).toStrictEqual([
          phase, boundary, 1,
        ]);
      }
    }
    // Every generated arm names a distinct code within its subject: one code reused across
    // a subject's three phases would be green whichever phase actually ran.
    for (const boundary of DURABLE_STORE_CLOSURE_NAMES) {
      const codes = durableClosureCases
        .filter((entry) => entry.boundary === boundary).map((entry) => entry.expected.code);
      expect([boundary, new Set(codes).size]).toStrictEqual([boundary, 3]);
    }
  });

  for (const hostileCase of durableClosureCases) {
    it(`TASK-F8 ${hostileCase.phase} ${hostileCase.boundary}: ${hostileCase.question}`, () => {
      const result = runClosureCase(hostileCase);
      // The exact code AND the answering layer, from production's own refusal object.
      assertRefusedWith(result.refusal, hostileCase.expected);
      // The divergence control: the SAME production call with the one hostile input removed
      // ADMITS. Without it a reader that refused everything would satisfy the line above.
      expect(result.controlAdmitted).toBe(true);
      // Durable readback: a refused read neither fabricates nor destroys rows, and the
      // horizon moves only where a rival writer really landed inside the call.
      expect(result.durableComplete).toBe(true);
      expect(result.durableDelta).toBe(hostileCase.durableDelta);
      expect(result.horizonMoved).toBe(hostileCase.horizonMoved);
      expect(result.durableRecords).toBeGreaterThanOrEqual(hostileCase.minimumRecords);
      if (hostileCase.phase === "RACE" && hostileCase.boundary === "CUTOVER_ATTEMPT_LAYER") {
        // The store's own diagnosis is retained rather than restamped as the daemon's.
        expect(result.upstream).toStrictEqual({
          code: "EXPECTED_VERSION_CONFLICT", layer: "DURABLE_STORE",
        });
      }
    });
  }
});
