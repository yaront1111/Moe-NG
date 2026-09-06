import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteEventStore } from "@moe/store";
import { expect, it, vi } from "vitest";
import { startDaemon } from "../daemon-entry.js";
import type { DaemonDependencyProvider } from "../daemon-entry.js";
import fixtureProvider from "../daemon-entry-fixtures.js";
import { createStoreDependencies } from "../daemon-store-dependencies.js";
import { startControlRoomListener } from "../http/http-listener.js";
import { createDurableSchedule, DEFAULT_SCHEDULE_INTERVAL_MS } from "./durable-schedule.js";
import type { ScheduleTimer } from "./durable-schedule.js";

vi.mock("../http/http-listener.js", async (original) => ({
  ...await original<typeof import("../http/http-listener.js")>(), startControlRoomListener: vi.fn(),
}));
function listener(close = async (): Promise<void> => {}) {
  return { ok: true as const, origin: "http://127.0.0.1:1", port: 1, close,
    approvePairing: (): never => { throw new Error("not used"); } };
}

class FakeTime implements ScheduleTimer {
  time = 0;
  private nextId = 0;
  readonly handles = new Map<number, { tick: () => void; interval: number; next: number }>();
  now = (): number => this.time;
  set = (tick: () => void, interval: number): number => {
    const id = ++this.nextId;
    this.handles.set(id, { tick, interval, next: this.time + interval });
    return id;
  };
  clear = (id: unknown): void => { this.handles.delete(id as number); };
  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    while (this.handles.size > 0) {
      const due = Math.min(...[...this.handles.values()].map((arm) => arm.next));
      if (due > end) break;
      this.time = due;
      for (const arm of [...this.handles.values()]) {
        if (arm.next !== due) continue;
        arm.next += arm.interval;
        arm.tick();
      }
      await Promise.resolve();
      await Promise.resolve();
    }
    this.time = end;
  }
}

async function withSchedule(run: (s: ReturnType<typeof createDurableSchedule>, t: FakeTime,
  store: SqliteEventStore) => Promise<void>): Promise<void> {
  const store = SqliteEventStore.openEphemeralForProjectTest("schedule-test");
  const t = new FakeTime();
  let s: ReturnType<typeof createDurableSchedule> | undefined;
  try {
    s = createDurableSchedule({ store, projectId: "schedule-test", now: t.now, timer: t });
    await run(s, t, store);
  } finally { s?.release(); store.close(); }
}

it("honours an explicit interval with exact execution counts", async () => {
  await withSchedule(async (s, t) => {
    let calls = 0;
    expect(s.register("target", () => { calls++; }, 10)).toEqual({ ok: true });
    await t.advance(49); expect(calls).toBe(4);
    await t.advance(1); expect(calls).toBe(5);
  });
});

it("duplicate registration does not double the execution count", async () => {
  await withSchedule(async (s, t) => {
    let calls = 0;
    const tick = (): void => { calls++; };
    s.register("target", tick, 10); await t.advance(5); s.register("target", tick, 10);
    await t.advance(45); expect(calls).toBe(5);
  });
});

it("restart rebuild plus registration preserves the exact execution rate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "moe-schedule-"));
  let store: SqliteEventStore | undefined;
  const t = new FakeTime();
  let s: ReturnType<typeof createDurableSchedule> | undefined;
  try {
    store = SqliteEventStore.openForProject(join(dir, "store.db"), "schedule-test");
    s = createDurableSchedule({ store, projectId: "schedule-test", now: t.now, timer: t });
    let calls = 0;
    const tick = (): void => { calls++; };
    s.register("target", tick, 10); await t.advance(50);
    const before = calls; expect(before).toBe(5);
    s.release(); expect(t.handles.size).toBe(0); store.close(); store = undefined;
    store = SqliteEventStore.openForProject(join(dir, "store.db"), "schedule-test");
    s = createDurableSchedule({ store, projectId: "schedule-test", now: t.now, timer: t,
      resolve: (id) => id === "target" ? tick : null });
    await t.advance(50); expect(calls - before).toBe(before);
    const resumed = calls;
    await t.advance(5); s.register("target", tick, 10); await t.advance(45);
    expect(calls - resumed).toBe(before);
  } finally { s?.release(); store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("applies the stated default interval instead of skipping the target", async () => {
  await withSchedule(async (s, t) => {
    let calls = 0;
    expect(DEFAULT_SCHEDULE_INTERVAL_MS).toBe(60_000);
    s.register("target", () => { calls++; });
    await t.advance(180_000); expect(calls).toBe(3);
  });
});

it("release clears every timer and remains idempotent", async () => {
  await withSchedule(async (s, t) => {
    let calls = 0;
    s.register("a", () => { calls++; }, 10); s.register("b", () => { calls++; }, 20);
    await t.advance(40); expect(calls).toBe(6);
    s.release(); s.release(); await t.advance(40);
    expect(calls).toBe(6); expect(t.handles.size).toBe(0);
  });
});

it("clean replaces a changed interval without retaining an old timer", async () => {
  await withSchedule(async (s, t) => {
    let calls = 0; const tick = (): void => { calls++; };
    s.register("a", tick, 10); await t.advance(10);
    s.register("a", tick, 20); await t.advance(40);
    expect(calls).toBe(3); expect(t.handles.size).toBe(1);
  });
});

it("contains a throwing callback and executes its next tick", async () => {
  await withSchedule(async (s, t) => {
    let calls = 0;
    s.register("a", () => { if (++calls === 1) throw new Error("callback failed"); }, 10);
    await t.advance(30); expect(calls).toBe(3);
    expect(s.refusals()).toEqual([{ ok: false, id: "a", code: "SCHEDULE_CALLBACK_FAILED", layer: "DAEMON_INGRESS" }]);
  });
});

it("skips overlap across interval replacement and aborts in-flight work on release", async () => {
  await withSchedule(async (s, t) => {
    let calls = 0; let signal: AbortSignal | undefined;
    let finish = (): void => {};
    const tick = (abort: AbortSignal): Promise<void> => {
      calls++; signal = abort; return new Promise((resolve) => { finish = resolve; });
    };
    s.register("a", tick, 10); await t.advance(20);
    s.register("a", tick, 20); await t.advance(40); expect(calls).toBe(1);
    s.release(); expect(signal?.aborted).toBe(true); finish();
    await t.advance(60); expect(calls).toBe(1); expect(t.handles.size).toBe(0);
  });
});

it.each([0, -1, NaN, Infinity, 1.5, 2_147_483_648])("refuses invalid interval %s without arming", async (interval) => {
  await withSchedule(async (s, t, store) => {
    expect(s.register("a", () => {}, interval)).toMatchObject({ ok: false, code: "SCHEDULE_INPUT_INVALID", layer: "DAEMON_INGRESS" });
    expect(t.handles.size).toBe(0); expect(store.readEvents("durable-schedule/schedule-test")).toHaveLength(0);
  });
});

it("refuses registration after release", async () => {
  await withSchedule(async (s, t) => {
    s.release();
    expect(s.register("a", () => {}, 10)).toMatchObject({ ok: false, code: "SCHEDULE_RELEASED", layer: "DAEMON_INGRESS" });
    expect(t.handles.size).toBe(0);
  });
});

it("persists the default once and drops an unresolved restart visibly, then rebinds", async () => {
  await withSchedule(async (s, t, store) => {
    let calls = 0; const tick = (): void => { calls++; };
    s.register("a", tick); s.register("a", tick);
    const events = store.readEvents("durable-schedule/schedule-test");
    expect(events).toHaveLength(1);
    expect(JSON.parse(new TextDecoder().decode(events[0]?.payload))).toEqual({ id: "a", intervalMs: 60_000 });
    s.release();
    const rebuilt = createDurableSchedule({ store, projectId: "schedule-test", timer: t, now: t.now });
    try {
      expect(rebuilt.refusals()).toEqual([{ ok: false, id: "a", code: "SCHEDULE_TARGET_UNRESOLVED", layer: "DAEMON_INGRESS" }]);
      await t.advance(60_000); expect(calls).toBe(0); expect(t.handles.size).toBe(0);
      rebuilt.rebuild(() => tick); await t.advance(120_000); expect(calls).toBe(2);
    } finally { rebuilt.release(); }
  });
});

it.each(['{"id":"a","intervalMs":0}', '{', '{"id":"a","intervalMs":null}'])("malformed latest record %s never revives a prior arm", async (payload) => {
  await withSchedule(async (s, t, store) => {
    let calls = 0; const tick = (): void => { calls++; };
    s.register("a", tick, 10);
    const aggregateId = "durable-schedule/schedule-test";
    store.commit({ aggregateId, commandId: randomUUID(), commandBytes: new Uint8Array([1]),
      committedAt: new Date(t.now()).toISOString(), expectedVersion: store.getAggregateVersion(aggregateId),
      events: [{ eventId: randomUUID(), eventType: "moe.durable-schedule.registered", payload: new TextEncoder().encode(payload) }] });
    s.rebuild(() => tick); await t.advance(30);
    expect(s.refusals()).toContainEqual(expect.objectContaining({ code: "SCHEDULE_RECORD_INVALID", layer: "DAEMON_INGRESS" }));
    expect(calls).toBe(0); expect(t.handles.size).toBe(0);
  });
});

it("daemon shutdown releases schedules with zero handles and no later executions", async () => {
  await withSchedule(async (s, t) => {
    let calls = 0; s.register("a", () => { calls++; }, 10);
    vi.mocked(startControlRoomListener).mockResolvedValue(listener());
    const started = await startDaemon({ dependencies: { ...fixtureProvider, schedules: () => s } });
    if (!started.ok) throw new Error(started.code);
    try {
      await t.advance(20); expect(calls).toBe(2);
      expect(await started.shutdown()).toEqual({ ok: true }); await t.advance(30);
      expect.soft(calls).toBe(2); expect.soft(t.handles.size).toBe(0);
      expect(await started.shutdown()).toEqual({ ok: false, code: "DAEMON_ENTRY_ALREADY_STOPPED", layer: "DAEMON_ENTRY" });
    } finally { await started.shutdown(); }
  });
});

it.each(["provider", "listener", "log", "listener-throw"])("releases schedules when startup fails at %s", async (mode) => {
  await withSchedule(async (s, t) => {
    let calls = 0; s.register("a", () => { calls++; }, 10);
    const closed = vi.fn(async () => {});
    vi.mocked(startControlRoomListener).mockResolvedValue(listener(closed));
    if (mode === "listener") vi.mocked(startControlRoomListener).mockResolvedValue({ ok: false,
      code: "LISTENER_HOST_INVALID", layer: "CONTROL_ROOM_LISTENER" });
    if (mode === "listener-throw") vi.mocked(startControlRoomListener).mockRejectedValue(new Error("listener failed"));
    const deps: DaemonDependencyProvider = { ...fixtureProvider, schedules: () => s,
      provide: mode === "provider" ? () => { throw new Error("provider failed"); } : fixtureProvider.provide };
    const result = await startDaemon({ dependencies: deps,
      log: () => { if (mode === "log") throw new Error("log failed"); } });
    expect(result).toEqual(mode === "listener"
      ? { ok: false, code: "LISTENER_HOST_INVALID", layer: "CONTROL_ROOM_LISTENER" }
      : { ok: false, code: "DAEMON_ENTRY_PROVIDER_THREW", layer: "DAEMON_ENTRY" });
    await t.advance(30); expect(calls).toBe(0); expect(t.handles.size).toBe(0);
    if (mode === "log") expect(closed).toHaveBeenCalledTimes(1);
  });
});

it("the real store provider releases its one scheduler synchronously", async () => {
  const dir = mkdtempSync(join(tmpdir(), "moe-schedule-provider-")); const t = new FakeTime();
  let provider: ReturnType<typeof createStoreDependencies> | undefined;
  try {
    provider = createStoreDependencies({ projectId: "schedule-provider", principalId: "operator",
      credential: randomUUID(), storePath: join(dir, "store.db"), clock: () => new Date(t.now()).toISOString(),
      schedule: { timer: t } });
    const s = provider.schedules?.(); expect(s).toBeDefined(); expect(s).toBe(provider.schedules?.());
    let calls = 0; s?.register("a", () => { calls++; }, 10);
    await t.advance(20); expect(calls).toBe(2);
    expect(provider.close()).toBeUndefined(); provider = undefined;
    await t.advance(20); expect(calls).toBe(2); expect(t.handles.size).toBe(0);
  } finally { provider?.close(); rmSync(dir, { recursive: true, force: true }); }
});

it.each(["store", "timer", "resolver"])("reports %s failure without an armed no-op", async (mode) => {
  await withSchedule(async (s, t, store) => {
    if (mode === "resolver") { s.register("a", () => {}, 10); s.release(); }
    const failed = createDurableSchedule({ projectId: "schedule-test", now: t.now,
      store: mode === "store" ? { readEvents: () => [], commit: () => { throw new Error("store failed"); } } : store,
      timer: mode === "timer" ? { set: () => { throw new Error("timer failed"); }, clear: t.clear } : t,
      resolve: () => { throw new Error("resolver failed"); } });
    try {
      const result = mode === "resolver" ? failed.refusals()[0] : failed.register("a", () => {}, 10);
      expect(result).toMatchObject({ ok: false, layer: "DAEMON_INGRESS", code: mode === "store"
        ? "SCHEDULE_STORE_FAILED" : mode === "timer" ? "SCHEDULE_TIMER_FAILED" : "SCHEDULE_TARGET_UNRESOLVED" });
      expect(t.handles.size).toBe(0);
      expect(store.readEvents("durable-schedule/schedule-test")).toHaveLength(mode === "store" ? 0 : 1);
    } finally { failed.release(); }
  });
});

it.each(["resolver", "timer"])("reentrant release from %s cannot leak a new handle", async (mode) => {
  await withSchedule(async (s, t) => {
    if (mode === "resolver") {
      s.register("a", () => {}, 10);
      s.rebuild(() => { s.release(); return () => {}; });
    } else {
      const set = t.set; t.set = (tick, interval) => { s.release(); return set(tick, interval); };
      s.register("a", () => {}, 10);
    }
    expect(s.refusals()).toContainEqual({ ok: false, id: "a", code: "SCHEDULE_RELEASED", layer: "DAEMON_INGRESS" });
    s.release(); expect(t.handles.size).toBe(0);
  });
});

it("rejects a malformed scheduler factory before starting a listener", async () => {
  vi.mocked(startControlRoomListener).mockClear();
  const dependencies = { ...fixtureProvider };
  Reflect.set(dependencies, "schedules", () => ({}));
  expect(await startDaemon({ dependencies })).toEqual({ ok: false, code: "DAEMON_ENTRY_DEPENDENCIES_INVALID", layer: "DAEMON_ENTRY" });
  expect(startControlRoomListener).not.toHaveBeenCalled();
});
