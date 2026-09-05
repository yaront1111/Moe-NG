import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import { createStoreDependencies } from "../daemon-store-dependencies.js";
import { readSessionLedger } from "../identity/session-read-model.js";
import { readWorkClaimLedger } from "../work/work-claim-services.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_PROVIDER_PAUSE_MS, PROVIDER_PAUSED_OUTCOME, createProviderPauseGate,
} from "./agent-provider-pause.js";
import { AgentProcessFailureError } from "./agent-spawn-contract.js";
import type { SeatExitReading, SeatExitReport } from "./agent-spawn-contract.js";
import { createAgentWrapperStaffing } from "./agent-wrapper-staffing.js";
import { createAgentWrapper } from "./agent-wrapper.js";
import { readProviderPause } from "./provider-pause-ledger.js";
import { SEAT_EXIT_KINDS } from "./seat-exit-classifier.js";

/**
 * The gate is the WRAPPER'S READING of one seat exit, tested over a REAL store:
 * a limit exit must park the provider, refund the item's attempt and leave a
 * durable record. Ordinary contained failures retain their charged attempt.
 *
 * Both provider lines are copied VERBATIM from child 1's committed fixtures in
 * seat-exit-classifier.test.ts — never retyped from memory.
 */
const LIMIT_LINE = "You've hit your session limit · resets 12:10am Asia/Jerusalem";
/** claude/rate-limit carries a DURATION, so child 1 classifies it PROVIDER_LIMIT with resetAt NULL. */
const DURATION_LIMIT_LINE = "Fast limit reached and temporarily disabled · resets in 5m";
/** A LATER instant than the session limit's, so a recomputed reset differs from a reused one. */
const WEEKLY_LIMIT_LINE = "You've hit your weekly limit · resets Sep 8, 10:46am (Asia/Jerusalem)";
const WEEKLY_RESET_AT = "2026-09-08T07:46:00.000Z";
/** Child 1's own anchor instant, so the parsed reset is the exact value its arms pin. */
const EXIT_AT = "2026-09-03T18:04:00.000Z";
const PARSED_RESET_AT = "2026-09-03T21:10:00.000Z";
const PROJECT_ID = "proj-pause-gate";

const sandboxes: string[] = [];
const stores: SqliteEventStore[] = [];
afterEach(() => {
  while (stores.length > 0) {
    try { stores.pop()?.close(); } catch { /* a closed store must not mask a failure */ }
  }
  while (sandboxes.length > 0) {
    const sandbox = sandboxes.pop();
    if (sandbox === undefined) continue;
    try { rmSync(sandbox, { force: true, recursive: true }); } catch { /* best effort */ }
  }
});

function freshStore(projectId: string): SqliteEventStore {
  const sandbox = mkdtempSync(join(tmpdir(), "moe-pause-gate-"));
  sandboxes.push(sandbox);
  const store = SqliteEventStore.openForProject(join(sandbox, "store.sqlite"), projectId);
  stores.push(store);
  return store;
}

interface Harness {
  readonly gate: ReturnType<typeof createProviderPauseGate>;
  readonly logs: string[];
  readonly setNow: (value: number) => void;
  readonly store: SqliteEventStore;
}

function harness(): Harness {
  const store = freshStore(PROJECT_ID);
  const logs: string[] = [];
  let now = Date.parse(EXIT_AT);
  const gate = createProviderPauseGate({
    clock: () => now,
    log: (line) => { logs.push(line); },
    projectId: PROJECT_ID,
    provider: "claude",
    store,
  });
  return { gate, logs, setNow: (value) => { now = value; }, store };
}

const report = (overrides: Partial<SeatExitReport> = {}): SeatExitReport => ({
  exitCode: 1, signal: null, tail: [LIMIT_LINE], ...overrides,
});

/**
 * The REAL store, presented one version ahead for the seat-exit aggregate only — the
 * shape of a concurrent wrapper writing that aggregate between the ledger's version
 * read and its commit. The store itself still decides and still refuses; nothing here
 * fabricates a disposition.
 */
function withStaleSeatExitVersion(store: SqliteEventStore): SqliteEventStore {
  return new Proxy(store, {
    get(target, property, receiver): unknown {
      if (property === "getAggregateVersion") {
        return (aggregateId: string): number => {
          const observed = target.getAggregateVersion(aggregateId);
          return aggregateId.startsWith("seat-exit:") ? observed + 1 : observed;
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

interface DecodedSeatExit {
  readonly kind: string;
  readonly lastLine: string | null;
  readonly sessionId: string;
}

/** Every seat-exit record a project holds, oldest first, read back off the store. */
function seatExitRecordsIn(store: SqliteEventStore, projectId: string): DecodedSeatExit[] {
  const decoded: DecodedSeatExit[] = [];
  let cursor = 0n;
  for (;;) {
    const page = store.readCommandDecisionsAfter(cursor, 200);
    for (const decision of page.items) {
      if (decision.commandKind !== "internal.wrapper.seat_exit"
        || decision.key.projectId !== projectId
        || decision.effectDisposition !== "EFFECTS_COMMITTED") continue;
      const record = JSON.parse(new TextDecoder().decode(decision.resultBytes)) as DecodedSeatExit;
      decoded.push({ kind: record.kind, lastLine: record.lastLine, sessionId: record.sessionId });
    }
    if (!page.hasMore || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return decoded;
}

describe("createProviderPauseGate", () => {
  it("parks the provider on a limit exit with a parsed reset, and refunds the attempt", () => {
    const { gate, logs, store } = harness();
    const refund = vi.fn();

    const reading: SeatExitReading = gate.exitObserver("sess-1", "item-7", refund)(report());

    expect(reading).toBe("PROVIDER_LIMIT");
    expect(refund).toHaveBeenCalledTimes(1);
    expect(seatExitRecords(store)).toEqual([
      { kind: "PROVIDER_LIMIT", lastLine: LIMIT_LINE, sessionId: "sess-1" },
    ]);
    expect(readProviderPause(store, PROJECT_ID, "claude", EXIT_AT)).toMatchObject({
      cause: { lastLine: LIMIT_LINE, workItemId: "item-7" },
      provider: "claude",
      resetAt: PARSED_RESET_AT,
      since: EXIT_AT,
    });
    expect(logs).toEqual([
      `[wrapper] provider limit: claude paused until ${PARSED_RESET_AT} (${LIMIT_LINE})`,
    ]);
    expect(gate.paused(Date.parse(EXIT_AT)))
      .toEqual({ provider: "claude", resetAt: PARSED_RESET_AT, since: EXIT_AT });
    // The pause is over AT the reset instant, not after it.
    expect(gate.paused(Date.parse(PARSED_RESET_AT))).toBeNull();
  });

  it("falls back to the bounded default when the limit line names no instant", () => {
    const { gate, logs, store } = harness();
    const refund = vi.fn();
    const expected = new Date(Date.parse(EXIT_AT) + DEFAULT_PROVIDER_PAUSE_MS).toISOString();

    expect(gate.exitObserver("sess-1", "item-7", refund)(report({ tail: [DURATION_LIMIT_LINE] })))
      .toBe("PROVIDER_LIMIT");

    expect(readProviderPause(store, PROJECT_ID, "claude", EXIT_AT)?.resetAt).toBe(expected);
    expect(logs).toEqual([
      `[wrapper] provider limit: claude paused until ${expected}`
      + ` (DEFAULT_PROVIDER_PAUSE_MS) (${DURATION_LIMIT_LINE})`,
    ]);
    expect(refund).toHaveBeenCalledTimes(1);
  });

  it("reuses a live pause's reset, so a second limit exit neither extends nor shortens it", () => {
    const { gate, setNow, store } = harness();
    const first = vi.fn();
    const second = vi.fn();
    const third = vi.fn();

    gate.exitObserver("sess-1", "item-7", first)(report());
    const laterMs = Date.parse(EXIT_AT) + 60_000;
    const later = new Date(laterMs).toISOString();
    setNow(laterMs);

    // A LATER-resetting line must not EXTEND the live window. Its own instant
    // (WEEKLY_RESET_AT) is what a gate without the reuse rule would record.
    expect(gate.exitObserver("sess-2", "item-8", second)(report({ tail: [WEEKLY_LIMIT_LINE] })))
      .toBe("PROVIDER_LIMIT");
    expect(second).toHaveBeenCalledTimes(1);
    expect(WEEKLY_RESET_AT).not.toBe(PARSED_RESET_AT);
    expect(readProviderPause(store, PROJECT_ID, "claude", later)).toMatchObject({
      cause: { lastLine: WEEKLY_LIMIT_LINE, workItemId: "item-8" },
      resetAt: PARSED_RESET_AT,
      since: later,
    });

    // And an instant-less line must not SHORTEN it to the bounded default either.
    const evenLaterMs = laterMs + 60_000;
    setNow(evenLaterMs);
    gate.exitObserver("sess-3", "item-9", third)(report({ tail: [DURATION_LIMIT_LINE] }));
    const defaulted = new Date(evenLaterMs + DEFAULT_PROVIDER_PAUSE_MS).toISOString();
    expect(defaulted).not.toBe(PARSED_RESET_AT);
    expect(readProviderPause(store, PROJECT_ID, "claude", new Date(evenLaterMs).toISOString()))
      .toMatchObject({ resetAt: PARSED_RESET_AT });
    // Reused, so the default token is never printed for a limit inside a live pause.
    expect(gate.paused(evenLaterMs)?.resetAt).toBe(PARSED_RESET_AT);
  });

  it("collapses two seats that hit the limit in the SAME instant onto one window", () => {
    // maxAgents > 1: both exits read the same clock, so both derive the same pause
    // command id. The ledger replays rather than double-writing, and the read still
    // answers the one window both seats are waiting on.
    const { gate, logs, store } = harness();
    const first = vi.fn();
    const second = vi.fn();

    expect(gate.exitObserver("sess-1", "item-7", first)(report())).toBe("PROVIDER_LIMIT");
    expect(gate.exitObserver("sess-2", "item-8", second)(report())).toBe("PROVIDER_LIMIT");

    // Both items get their attempt back; neither seat is charged for the provider.
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    // Two seat exits are two distinct records; the pause is ONE window.
    expect(seatExitRecords(store).map((entry) => entry.sessionId)).toEqual(["sess-1", "sess-2"]);
    expect(readProviderPause(store, PROJECT_ID, "claude", EXIT_AT)).toMatchObject({
      cause: { workItemId: "item-7" },
      resetAt: PARSED_RESET_AT,
      since: EXIT_AT,
    });
    expect(gate.paused(Date.parse(EXIT_AT))?.resetAt).toBe(PARSED_RESET_AT);
    // Announced once per seat: the operator sees both refusals, one window.
    expect(logs).toEqual([
      `[wrapper] provider limit: claude paused until ${PARSED_RESET_AT} (${LIMIT_LINE})`,
      `[wrapper] provider limit: claude paused until ${PARSED_RESET_AT} (${LIMIT_LINE})`,
    ]);
  });

  it("reads an ordinary crash as FAILED: no refund, no pause, record kept", () => {
    const { gate, logs, store } = harness();
    const refund = vi.fn();

    expect(gate.exitObserver("sess-1", "item-7", refund)(
      report({ tail: ["TypeError: boom", "    at main (x.ts:1:1)"] }),
    )).toBe("FAILED");

    expect(refund).not.toHaveBeenCalled();
    expect(seatExitRecords(store)).toEqual([
      { kind: "FAILED", lastLine: "    at main (x.ts:1:1)", sessionId: "sess-1" },
    ]);
    expect(readProviderPause(store, PROJECT_ID, "claude", EXIT_AT)).toBeNull();
    expect(gate.paused(Date.parse(EXIT_AT))).toBeNull();
    expect(logs).toEqual([]);
  });

  it("reads exit 0 as COMPLETED even when the tail carries the limit line", () => {
    const { gate, store } = harness();
    const refund = vi.fn();

    expect(gate.exitObserver("sess-1", "item-7", refund)(report({ exitCode: 0 }))).toBe("COMPLETED");

    expect(refund).not.toHaveBeenCalled();
    expect(seatExitRecords(store)).toEqual([
      { kind: "COMPLETED", lastLine: LIMIT_LINE, sessionId: "sess-1" },
    ]);
    expect(readProviderPause(store, PROJECT_ID, "claude", EXIT_AT)).toBeNull();
  });

  it("replays rather than double-writing when one seat exit is observed twice", () => {
    const { gate, logs, store } = harness();
    const refund = vi.fn();
    const observer = gate.exitObserver("sess-1", "item-7", refund);

    expect(observer(report())).toBe("PROVIDER_LIMIT");
    expect(observer(report())).toBe("PROVIDER_LIMIT");

    // Same session at the same instant derives the same command id, so child 1's ledger
    // REPLAYS it: one record, not two, and no refusal to report.
    expect(seatExitRecords(store)).toEqual([
      { kind: "PROVIDER_LIMIT", lastLine: LIMIT_LINE, sessionId: "sess-1" },
    ]);
    expect(logs.filter((line) => line.includes("not recorded"))).toEqual([]);
    expect(readProviderPause(store, PROJECT_ID, "claude", EXIT_AT)?.resetAt).toBe(PARSED_RESET_AT);
  });

  it("logs the exact refusal code when the ledger refuses the seat exit, and still pauses", () => {
    const store = freshStore(PROJECT_ID);
    const logs: string[] = [];
    const gate = createProviderPauseGate({
      clock: () => Date.parse(EXIT_AT),
      log: (line) => { logs.push(line); },
      projectId: PROJECT_ID,
      provider: "claude",
      // A concurrent wrapper moved this seat's aggregate between the version read and the
      // commit. The REAL store still decides: it observes the tail, sees the presented
      // version is stale, and rejects — the code below is production's, not the double's.
      store: withStaleSeatExitVersion(store),
    });
    const refund = vi.fn();

    const reading = gate.exitObserver("sess-1", "item-7", refund)(report());

    expect(reading).toBe("PROVIDER_LIMIT");
    expect(logs).toContain("[wrapper] seat exit not recorded: EXPECTED_VERSION_CONFLICT");
    // A record the ledger refused must not cost the item its attempt or its pause.
    expect(refund).toHaveBeenCalledTimes(1);
    expect(readProviderPause(store, PROJECT_ID, "claude", EXIT_AT)?.resetAt).toBe(PARSED_RESET_AT);
    expect(seatExitRecords(store)).toEqual([]);
  });

  it("keeps the wrapper running when the observer itself throws, and says so", () => {
    const { gate, logs } = harness();
    const exploding = {
      exitCode: 1,
      signal: null,
      get tail(): readonly string[] { throw new Error("kaboom"); },
    } as unknown as SeatExitReport;

    expect(gate.exitObserver("sess-1", "item-7", vi.fn())(exploding)).toBe("FAILED");
    expect(logs).toEqual(["[wrapper] seat exit observer failed: kaboom"]);
  });

  it("names a reading for every kind child 1 can classify", () => {
    // Enumerated through the TYPE, so a kind added upstream without a reading here
    // is a red set-equality, not a silently unhandled branch.
    const readings: Record<SeatExitReading, true> = {
      COMPLETED: true, FAILED: true, PROVIDER_LIMIT: true,
    };
    expect(new Set<string>(Object.keys(readings))).toEqual(new Set<string>(SEAT_EXIT_KINDS));
    expect(PROVIDER_PAUSED_OUTCOME).toBe("PROVIDER_PAUSED");
    expect(DEFAULT_PROVIDER_PAUSE_MS).toBe(30 * 60 * 1000);
  });
});

/** A deferred whose settlement the test owns, standing in for one seat's lifetime. */
function deferred(): {
  promise: Promise<SeatExitReport | void>;
  reject: (error: unknown) => void;
  resolve: (value?: SeatExitReport) => void;
} {
  let reject!: (error: unknown) => void;
  let resolve!: (value?: SeatExitReport) => void;
  const promise = new Promise<SeatExitReport | void>((res, rej) => {
    reject = rej;
    resolve = (value) => { res(value); };
  });
  // Nothing else observes this handle, so an unobserved rejection must not escape.
  void promise.catch(() => undefined);
  return { promise, reject, resolve };
}

describe("staffing exit hook", () => {
  const staffed = async (
    onExit: ((report: SeatExitReport) => SeatExitReading) | undefined,
  ): Promise<{
    cleanups: boolean[];
    exit: ReturnType<typeof deferred>;
    staffing: ReturnType<typeof createAgentWrapperStaffing>;
  }> => {
    const staffing = createAgentWrapperStaffing(undefined);
    const cleanups: boolean[] = [];
    const exit = deferred();
    const report = await staffing.start({
      claimAggregateVersion: 1,
      cleanupAuthority: (released) => { cleanups.push(released); return []; },
      kind: "project.register",
      onExit,
      request: {
        credential: "agent-secret-0001",
        expiresAt: "2026-09-04T00:00:00.000Z",
        kind: "project.register",
        mission: "dispatch it",
        sessionId: "sess-1",
        workItemId: "item-7",
        workspace: null,
      },
      sessionId: "sess-1",
      spawnAgent: async () => ({ exit: exit.promise, ok: true as const, pid: 909_090 }),
      workItemId: "item-7",
    });
    expect(report.outcome).toBe("SPAWNED");
    return { cleanups, exit, staffing };
  };

  it("drops the process failure when the exit reads PROVIDER_LIMIT", async () => {
    const { cleanups, exit, staffing } = await staffed(() => "PROVIDER_LIMIT");

    exit.reject(new AgentProcessFailureError("EXIT_NONZERO", 1, null, [LIMIT_LINE]));
    await expect(staffing.settle()).resolves.toBeUndefined();

    expect(staffing.failureOutcome()).toBeNull();
    // Task rail 2: the existing release path ran EXACTLY once, and with `true`.
    expect(cleanups).toEqual([true]);
  });

  it("releases staffing after a contained FAILED attempt", async () => {
    const { cleanups, exit, staffing } = await staffed(() => "FAILED");

    exit.reject(new AgentProcessFailureError("EXIT_NONZERO", 1, null, ["TypeError: boom"]));
    await expect(staffing.settle()).resolves.toBeUndefined();

    expect(staffing.failureOutcome()).toBeNull();
    expect(cleanups).toEqual([true]);
  });

  it("releases staffing after a contained failure without an observer", async () => {
    const { cleanups, exit, staffing } = await staffed(undefined);

    exit.reject(new AgentProcessFailureError("EXIT_NONZERO", 1, null, ["TypeError: boom"]));
    await expect(staffing.settle()).resolves.toBeUndefined();

    expect(staffing.failureOutcome()).toBeNull();
    expect(cleanups).toEqual([true]);
  });

  it("hands the observer the resolved report verbatim on a clean exit", async () => {
    const seen: SeatExitReport[] = [];
    const { cleanups, exit, staffing } = await staffed((r) => { seen.push(r); return "COMPLETED"; });

    exit.resolve({ exitCode: 0, signal: null, tail: ["done"] });
    await expect(staffing.settle()).resolves.toBeUndefined();

    expect(seen).toEqual([{ exitCode: 0, signal: null, tail: ["done"] }]);
    expect(cleanups).toEqual([true]);
  });

  it("reads a void resolution from a legacy stub as a clean exit", async () => {
    const seen: SeatExitReport[] = [];
    const { exit, staffing } = await staffed((r) => { seen.push(r); return "COMPLETED"; });

    exit.resolve();
    await expect(staffing.settle()).resolves.toBeUndefined();

    expect(seen).toEqual([{ exitCode: 0, signal: null, tail: [] }]);
  });

  it("records BOTH failures when the observer itself throws", async () => {
    const { cleanups, exit, staffing } = await staffed(() => { throw new Error("kaboom"); });

    exit.reject(new AgentProcessFailureError("EXIT_NONZERO", 1, null, [LIMIT_LINE]));
    await expect(staffing.settle()).rejects.toThrowError(
      "AGENT_EXIT_OBSERVER_FAILED:UNEXPECTED_ERROR|AGENT_PROCESS_FAILED:EXIT_NONZERO:1",
    );

    expect(staffing.failureOutcome()).toBe(
      "AGENT_EXIT_OBSERVER_FAILED:UNEXPECTED_ERROR|AGENT_PROCESS_FAILED:EXIT_NONZERO:1",
    );
    expect(cleanups).toEqual([true]);
  });
});

const seatExitRecords = (store: SqliteEventStore): DecodedSeatExit[] =>
  seatExitRecordsIn(store, PROJECT_ID);

/**
 * The whole loop, over the REAL provider and store: a limit exit must park the
 * provider, hand the item's attempt back, release the claim and close the session
 * through the EXISTING cleanup, and let the pass at the reset staff again.
 */
describe("createAgentWrapper with a provider pause", () => {
  const OPERATOR = "wrapper-operator-credential";
  const CHILD_PID = 909_090;
  // The provider authenticates sessions against the REAL clock, so the injected
  // clock starts at now and only ever moves forward.
  const NOW = Date.now();

  interface WrapperHarness {
    readonly dispose: () => void;
    readonly exits: ReturnType<typeof deferred>[];
    readonly logs: string[];
    readonly reader: SqliteEventStore;
    readonly setNow: (value: number) => void;
    readonly spawns: number;
    readonly wrapper: ReturnType<typeof createAgentWrapper>;
  }

  function wrapperHarness(projectId: string): WrapperHarness {
    const sandbox = mkdtempSync(join(tmpdir(), "moe-pause-wrapper-"));
    const storePath = join(sandbox, "store.db");
    const isolated = createStoreDependencies({
      credential: OPERATOR, principalId: "operator-local", projectId, storePath,
    });
    const port = isolated.affordances?.();
    if (port === undefined) throw new Error("provider serves no affordances");
    const reader = SqliteEventStore.openForProject(storePath, projectId);
    const logs: string[] = [];
    const exits: ReturnType<typeof deferred>[] = [];
    const state = { spawns: 0 };
    let now = NOW;
    let suffix = 0;
    const wrapper = createAgentWrapper({
      affordances: port,
      claimTtlMs: 60_000,
      clock: () => now,
      deps: isolated.provide(),
      maxAgents: 1,
      maxItemAttempts: 1,
      mintSecret: () => `pause-${String(suffix += 1).padStart(4, "0")}${"0".repeat(28)}`,
      operatorCredential: OPERATOR,
      providerPause: createProviderPauseGate({
        clock: () => now,
        log: (line) => { logs.push(line); },
        projectId,
        provider: "claude",
        store: reader,
      }),
      spawnAgent: async () => {
        state.spawns += 1;
        const exit = deferred();
        exits.push(exit);
        return { exit: exit.promise, ok: true as const, pid: CHILD_PID };
      },
    });
    return {
      dispose: () => {
        reader.close();
        isolated.close();
        rmSync(sandbox, { force: true, recursive: true });
      },
      exits,
      logs,
      reader,
      setNow: (value) => { now = value; },
      get spawns(): number { return state.spawns; },
      wrapper,
    };
  }

  /** Staffs one seat and answers what the wrapper reported for it. */
  async function staffOne(harness: WrapperHarness): Promise<{
    readonly exit: ReturnType<typeof deferred>;
    readonly sessionId: string;
    readonly workItemId: string;
  }> {
    const report = await harness.wrapper.runOnce();
    const staffed = report.spawned[0];
    expect(staffed).toMatchObject({ outcome: "SPAWNED" });
    const exit = harness.exits[harness.exits.length - 1];
    const sessionId = staffed?.sessionId;
    if (sessionId === null || sessionId === undefined || staffed === undefined
      || exit === undefined) throw new Error("nothing staffed");
    return { exit, sessionId, workItemId: staffed.workItemId };
  }

  const nowIso = (ms: number): string => new Date(ms).toISOString();

  it("parks staffing until the reset, refunds the attempt, and releases the seat", async () => {
    const projectId = "proj-pause-wrapper-limit";
    const harness = wrapperHarness(projectId);
    try {
      const seat = await staffOne(harness);
      expect(harness.spawns).toBe(1);

      seat.exit.reject(
        new AgentProcessFailureError("EXIT_NONZERO", 1, null, ["hello", LIMIT_LINE]),
      );
      // A PROVIDER_LIMIT exit is NOT the wrapper's failure, so settle resolves.
      await expect(harness.wrapper.settle()).resolves.toBeUndefined();

      const pause = readProviderPause(harness.reader, projectId, "claude", nowIso(NOW));
      if (pause === null) throw new Error("no pause recorded");
      expect(pause).toMatchObject({
        cause: { lastLine: LIMIT_LINE, workItemId: seat.workItemId },
        provider: "claude",
      });
      expect(harness.logs).toEqual([
        `[wrapper] provider limit: claude paused until ${pause.resetAt} (${LIMIT_LINE})`,
      ]);
      expect(seatExitRecordsIn(harness.reader, projectId)).toEqual([
        { kind: "PROVIDER_LIMIT", lastLine: LIMIT_LINE, sessionId: seat.sessionId },
      ]);
      // The EXISTING exit cleanup did both; the gate never releases anything (task rail 2).
      expect(readWorkClaimLedger(harness.reader, projectId).claims.get(seat.workItemId))
        .toMatchObject({ status: "RELEASED" });
      expect(readSessionLedger(harness.reader, projectId).sessions.get(seat.sessionId))
        .toMatchObject({ status: "CLOSED" });

      const resetMs = Date.parse(pause.resetAt);
      // Instants taken as FRACTIONS of the real window, so the arm is deterministic
      // whatever wall-clock time the suite runs at.
      const span = resetMs - NOW;
      expect(span).toBeGreaterThan(0);
      for (const fraction of [0.25, 0.5, 0.75]) {
        harness.setNow(NOW + Math.floor(span * fraction));
        expect(await harness.wrapper.runOnce()).toEqual({
          active: 0,
          paused: { provider: "claude", resetAt: pause.resetAt, since: pause.since },
          spawned: [],
          surfaceOutcome: "PROVIDER_PAUSED",
        });
      }
      expect(harness.spawns).toBe(1);

      // At the reset the provider is free. maxItemAttempts is 1 and the attempt was
      // charged at the first spawn, so staffing here IS the refund: without it this
      // pass answers STAFFING_ATTEMPTS_EXHAUSTED.
      harness.setNow(resetMs);
      const again = await harness.wrapper.runOnce();
      // The SAME item is staffed again — a different item would prove nothing.
      expect(again.spawned[0])
        .toMatchObject({ outcome: "SPAWNED", workItemId: seat.workItemId });
      expect(again.paused).toBeUndefined();
      expect(harness.spawns).toBe(2);
    } finally {
      harness.dispose();
    }
  });

  it("records an ordinary crash without pausing or refunding its attempt", async () => {
    const projectId = "proj-pause-wrapper-failed";
    const harness = wrapperHarness(projectId);
    try {
      const seat = await staffOne(harness);

      seat.exit.reject(new AgentProcessFailureError(
        "EXIT_NONZERO", 1, null, ["TypeError: boom", "    at main (x.ts:1:1)"],
      ));
      await expect(harness.wrapper.settle()).resolves.toBeUndefined();

      const next = await harness.wrapper.runOnce();
      expect(next.surfaceOutcome).toBe("SURFACE");
      expect(next.spawned).toContainEqual({
        kind: "policy.install", outcome: "STAFFING_ATTEMPTS_EXHAUSTED", refusal: null,
        sessionId: null, workItemId: seat.workItemId,
      });
      expect(harness.spawns).toBe(2);
      expect(next.spawned[1]).toMatchObject({
        outcome: "SPAWNED", workItemId: `project.register@${projectId}`,
      });
      expect(seatExitRecordsIn(harness.reader, projectId)).toEqual([
        { kind: "FAILED", lastLine: "    at main (x.ts:1:1)", sessionId: seat.sessionId },
      ]);
      expect(readProviderPause(harness.reader, projectId, "claude", nowIso(NOW))).toBeNull();
      expect(harness.logs).toEqual([]);
      harness.exits[1]?.resolve();
      await harness.wrapper.settle();
    } finally {
      harness.dispose();
    }
  });

  it("parks for the bounded default when the limit line names no instant", async () => {
    const projectId = "proj-pause-wrapper-default";
    const harness = wrapperHarness(projectId);
    try {
      const seat = await staffOne(harness);
      const expected = nowIso(NOW + DEFAULT_PROVIDER_PAUSE_MS);

      seat.exit.reject(
        new AgentProcessFailureError("EXIT_NONZERO", 1, null, [DURATION_LIMIT_LINE]),
      );
      await expect(harness.wrapper.settle()).resolves.toBeUndefined();

      expect(readProviderPause(harness.reader, projectId, "claude", nowIso(NOW))?.resetAt)
        .toBe(expected);
      expect(harness.logs).toEqual([
        `[wrapper] provider limit: claude paused until ${expected}`
        + ` (DEFAULT_PROVIDER_PAUSE_MS) (${DURATION_LIMIT_LINE})`,
      ]);

      harness.setNow(Date.parse(expected) - 1);
      expect((await harness.wrapper.runOnce()).surfaceOutcome).toBe(PROVIDER_PAUSED_OUTCOME);
      expect(harness.spawns).toBe(1);

      harness.setNow(Date.parse(expected));
      expect((await harness.wrapper.runOnce()).spawned[0]).toMatchObject({ outcome: "SPAWNED" });
      expect(harness.spawns).toBe(2);
    } finally {
      harness.dispose();
    }
  });

  it("records a clean exit as COMPLETED and parks nothing", async () => {
    const projectId = "proj-pause-wrapper-clean";
    const harness = wrapperHarness(projectId);
    try {
      const seat = await staffOne(harness);

      seat.exit.resolve({ exitCode: 0, signal: null, tail: ["done"] });
      await expect(harness.wrapper.settle()).resolves.toBeUndefined();

      expect(seatExitRecordsIn(harness.reader, projectId)).toEqual([
        { kind: "COMPLETED", lastLine: "done", sessionId: seat.sessionId },
      ]);
      expect(readProviderPause(harness.reader, projectId, "claude", nowIso(NOW))).toBeNull();
      expect(readSessionLedger(harness.reader, projectId).sessions.get(seat.sessionId))
        .toMatchObject({ status: "CLOSED" });
      expect(harness.logs).toEqual([]);
    } finally {
      harness.dispose();
    }
  });
});
