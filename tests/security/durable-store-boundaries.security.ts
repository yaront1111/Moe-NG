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
import type { RaceOutcome } from "./hostile-harness.js";
import {
  DURABLE_BOUNDARY_NAMES,
  hostileAfterCases,
  hostileBeforeCases,
  hostileRaceCases,
  runRefusalCase,
} from "./durable-store-boundary-scenarios.js";
import type { RaceCase } from "./durable-store-boundary-scenarios.js";

afterAll(cleanupHostileRoots);

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

describe("durable-store roster coverage", () => {
  it("takes the durable-store subset from the committed roster in both directions", () => {
    expect(DURABLE_BOUNDARY_NAMES).toHaveLength(14);
    expect([...DURABLE_BOUNDARY_NAMES].sort()).toStrictEqual(rosterNames);
  });

  it.each(DURABLE_BOUNDARY_NAMES)("generates hostile BEFORE and AFTER cases for %s", (boundary) => {
    expect(hostileBeforeCases.filter((entry) => entry.boundary === boundary).length).toBeGreaterThan(0);
    expect(hostileAfterCases.filter((entry) => entry.boundary === boundary).length).toBeGreaterThan(0);
    expect(hostileRaceCases.filter((entry) => entry.boundary === boundary).length).toBeGreaterThan(0);
  });
});

describe("hostile durable-store races", () => {
  for (const hostileCase of hostileRaceCases) {
    it(`RACE ${hostileCase.boundary}: ${hostileCase.question}`, async () => {
      const result = await runRaceCase(hostileCase);
      expect(result.admittedSides).toBe(1);
      expect(result.outcome.left.status).toBe("fulfilled");
      expect(result.outcome.right.status).toBe("fulfilled");
      assertRefusedWith(result.refusal, hostileCase.expected);
      expect(result.durableEvents).toBe(1);
      expect(result.winnerPayloads).toStrictEqual([result.winner]);
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
  for (const hostileCase of hostileRaceCases) raceResults.push(await runRaceCase(hostileCase));
  expect(refusalResults).toHaveLength(DURABLE_BOUNDARY_NAMES.length * 2);
  expect(raceResults).toHaveLength(DURABLE_BOUNDARY_NAMES.length);
  expect(refusalResults.every(({ hostileCase, result }) =>
    result.durableComplete && result.durableRecords === hostileCase.preexistingRecords
    && (result.truth === undefined || result.truth === "UNKNOWN")
    && (result.authority === undefined || result.authority === "NONE"))).toBe(true);
  expect(raceResults.every((result) => result.admittedSides === 1 && result.durableEvents === 1
    && result.winnerPayloads.length === 1 && result.winnerPayloads[0] === result.winner)).toBe(true);
});
