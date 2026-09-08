import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { Worker } from "node:worker_threads";

import { expect, it } from "vitest";

type SmokeOptions = {
  mode?: "ERROR" | "NONZERO" | "NO_RESULT";
  gate?: SharedArrayBuffer;
  directory?: (directory: string) => void;
  observe?: (worker: Worker, arm: (milliseconds: number) => void) => void;
  create?: (databasePath: string, options: SmokeOptions) => Worker;
  remove?: (directory: string) => void;
  terminate?: (worker: Worker) => Promise<number>;
};
type Outcome = { value: unknown } | { error: unknown };

function failure(code: string, details: object = {}): Error {
  return Object.assign(new Error(code), { code, layer: "STORE_SMOKE_WORKER" }, details);
}

function createWorker(databasePath: string, options: SmokeOptions): Worker {
  return new Worker(new URL("./store-entrypoint-smoke-worker.mjs", import.meta.url), {
    execArgv: ["--experimental-strip-types"],
    workerData: { databasePath, mode: options.mode, gate: options.gate },
  });
}

function watchWorker(worker: Worker) {
  const result = Promise.withResolvers<Outcome>();
  const exit = Promise.withResolvers<void>();
  let exited = false;
  let received = false;
  let value: unknown;
  let timer: ReturnType<typeof setTimeout>;
  const message = (message: unknown) => { received = true; value = message; };
  const error = (cause: unknown) => result.resolve({ error: failure("STORE_SMOKE_WORKER_ERROR", { cause }) });
  const onExit = (code: number) => {
    exited = true;
    exit.resolve();
    // A result message precedes the worker's finally/SQLite close; only exit proves teardown.
    result.resolve(code !== 0 ? { error: failure("STORE_SMOKE_NONZERO_EXIT", { exitCode: code }) }
      : !received ? { error: failure("STORE_SMOKE_NO_RESULT") } : { value });
    dispose();
  };
  const clear = () => clearTimeout(timer);
  const arm = (milliseconds: number) => {
    clear();
    if (!exited) timer = setTimeout(() => result.resolve({ error: failure("STORE_SMOKE_TIMEOUT") }), milliseconds);
  };
  const dispose = () => {
    clear();
    worker.off("message", message).off("error", error).off("exit", onExit);
  };
  worker.once("message", message).once("error", error).once("exit", onExit);
  arm(10_000);
  return { result: result.promise, exit: exit.promise, arm, clear, get exited() { return exited; } };
}

function removeDirectory(directory: string): void {
  rmSync(directory, { force: true, recursive: true });
}

async function smoke(options: SmokeOptions = {}, assertion: (value: unknown) => void = () => {}): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "moe-runtime-entrypoint-"));
  let worker: Worker | undefined;
  let lifecycle: ReturnType<typeof watchWorker> | undefined;
  const errors: unknown[] = [];
  try {
    options.directory?.(directory);
    worker = (options.create ?? createWorker)(join(directory, "store.sqlite"), options);
    lifecycle = watchWorker(worker);
    options.observe?.(worker, lifecycle.arm);
    const outcome = await lifecycle.result;
    if ("error" in outcome) throw outcome.error;
    assertion(outcome.value);
  } catch (error) { errors.push(error); }
  lifecycle?.clear();
  if (worker !== undefined && lifecycle !== undefined && !lifecycle.exited) {
    try {
      await (options.terminate?.(worker) ?? worker.terminate());
      await lifecycle.exit;
    } catch (error) { errors.push(error); }
  }
  try {
    if (worker === undefined || lifecycle?.exited) (options.remove ?? removeDirectory)(directory);
  } catch (error) { errors.push(error); }
  if (errors.length > 1) throw new AggregateError(errors, "store smoke lifecycle and cleanup failed", { cause: errors[0] });
  if (errors.length > 0) throw errors[0];
}

function makeProbe() {
  const gate = new SharedArrayBuffer(8);
  const probe = {
    gate, cells: new Int32Array(gate), directory: "", worker: undefined as Worker | undefined,
    error: undefined as unknown, events: [] as string[], runs: [] as Promise<Outcome>[],
    arm: (_milliseconds: number) => {},
  };
  const options: SmokeOptions = {
    directory: (directory) => { probe.directory = directory; },
    observe: (worker, arm) => {
      probe.worker = worker;
      probe.arm = arm;
      worker.once("message", () => probe.events.push("message"));
      worker.once("error", (error: unknown) => { probe.error = error; });
      worker.once("exit", () => probe.events.push("exit"));
    },
    remove: (directory) => { probe.events.push("remove"); removeDirectory(directory); },
    terminate: (worker) => { probe.events.push("terminate"); return worker.terminate(); },
  };
  const run = (assertion?: (value: unknown) => void) => {
    const result = smoke(options, assertion).then<Outcome, Outcome>(
      (value) => ({ value }), (error: unknown) => ({ error }),
    );
    probe.runs.push(result);
    return result;
  };
  return Object.assign(probe, { options, run });
}
type Probe = ReturnType<typeof makeProbe>;

function release(probe: Probe): void {
  Atomics.store(probe.cells, 1, 1);
  Atomics.notify(probe.cells, 1);
}

async function withProbe(body: (probe: Probe) => Promise<void>): Promise<void> {
  const probe = makeProbe();
  try {
    await body(probe);
  } finally {
    release(probe);
    if (probe.worker !== undefined && probe.worker.threadId !== -1) {
      await Worker.prototype.terminate.call(probe.worker);
    }
    probe.arm(0);
    await Promise.all(probe.runs);
    if (probe.directory !== "") removeDirectory(probe.directory);
    expect(probe.worker?.threadId ?? -1).toBe(-1);
    if (probe.directory !== "") expect(existsSync(probe.directory)).toBe(false);
  }
}

async function ready(probe: Probe): Promise<void> {
  const wait = Atomics.waitAsync(probe.cells, 0, 0, 10_000);
  expect(await wait.value, "fixture must hold its real SQLite handle before deadline injection").not.toBe("timed-out");
  expect(Atomics.load(probe.cells, 0)).toBe(1);
  await setImmediate();
  expect(probe.events).toContain("message");
}

function clean(probe: Probe): void {
  expect(existsSync(probe.directory)).toBe(false);
  expect(probe.worker?.threadId ?? -1).toBe(-1);
  if (probe.worker !== undefined) {
    expect(probe.events.indexOf("exit")).toBeGreaterThanOrEqual(0);
    expect(probe.events.indexOf("remove")).toBeGreaterThan(probe.events.indexOf("exit"));
  }
}

it("loads the public TypeScript entrypoint in Node's strip-types runtime", () => withProbe(async (probe) => {
  expect(await probe.run((result) => expect(result).toEqual({
      accessMode: "READ_ONLY_INSPECTION",
      dangerousMembers: [],
      frozen: true,
      outcome: "IMPORTED",
      ownKeys: [],
      projectId: null,
      shadowMutationRejected: true,
      writeCode: "PROJECT_SCOPE_REQUIRED",
  }))).toEqual({ value: undefined });
  clean(probe);
  expect(probe.events).not.toContain("terminate");
}), 20_000);

it("does not settle or remove after message until the held worker exits", () => withProbe(async (probe) => {
  probe.options.gate = probe.gate;
  let settled = false;
  const outcome = probe.run().then((result) => { settled = true; return result; });
  await ready(probe);
  expect(probe.events, "message must not trigger termination before gate release").not.toContain("terminate");
  expect(probe.events, "message is not exit: removal must wait").not.toContain("remove");
  expect(settled).toBe(false);
  expect(existsSync(join(probe.directory, "store.sqlite"))).toBe(true);
  release(probe);
  expect(await outcome).toEqual({ value: undefined });
  clean(probe);
  expect(probe.events).not.toContain("terminate");
}), 20_000);

it.each([
  ["ERROR", "STORE_SMOKE_WORKER_ERROR"],
  ["NONZERO", "STORE_SMOKE_NONZERO_EXIT"],
  ["NO_RESULT", "STORE_SMOKE_NO_RESULT"],
] as const)("rejects %s with its own diagnostic", (mode, code) => withProbe(async (probe) => {
  probe.options.mode = mode;
  const outcome = await probe.run();
  expect(outcome).toMatchObject({ error: { code, layer: "STORE_SMOKE_WORKER" } });
  if (mode === "ERROR") {
    expect(outcome).toMatchObject({ error: { cause: { code: "STORE_SMOKE_FIXTURE_THROW" } } });
    if ("error" in outcome) expect((outcome.error as Error).cause).toBe(probe.error);
  }
  if (mode === "NONZERO") expect(outcome).toMatchObject({ error: { exitCode: 23 } });
  expect(probe.events.includes("message")).toBe(mode !== "NO_RESULT");
  clean(probe);
}), 20_000);

it("times out only after the real store is ready and awaits termination", () => withProbe(async (probe) => {
  probe.options.gate = probe.gate;
  const outcome = probe.run();
  await ready(probe);
  probe.arm(10);
  expect(await outcome).toMatchObject({ error: { code: "STORE_SMOKE_TIMEOUT", layer: "STORE_SMOKE_WORKER" } });
  clean(probe);
  expect(probe.events.filter((event) => event === "terminate")).toHaveLength(1);
}), 20_000);

it.each(["constructor", "assertion"] as const)("preserves a throwing %s error", (phase) => withProbe(async (probe) => {
  const original = Object.assign(new Error(phase), { code: "ORIGINAL_FAILURE", cause: new Error("original cause") });
  const fail = () => { throw original; };
  if (phase === "constructor") probe.options.create = fail;
  const outcome = await probe.run(phase === "assertion" ? fail : undefined);
  expect(outcome).toEqual({ error: original });
  if ("error" in outcome) expect(outcome.error).toBe(original);
  clean(probe);
  if (phase === "constructor") expect(probe.worker).toBeUndefined();
}), 20_000);

it("removes only its unique directory, leaving a sibling intact", () => withProbe(async (probe) => {
  const sibling = mkdtempSync(join(tmpdir(), "moe-runtime-entrypoint-"));
  try {
    expect(await probe.run()).toEqual({ value: undefined });
    expect(probe.directory).not.toBe(sibling);
    expect(existsSync(sibling)).toBe(true);
    clean(probe);
  } finally { removeDirectory(sibling); }
}), 20_000);

it.each([false, true])("retains cleanup EPERM, including paired primary failure=%s", (paired) => withProbe(async (probe) => {
  const denied = Object.assign(new Error("injected removal denial"), { code: "EPERM" });
  const primary = new Error("caller assertion failed");
  probe.options.remove = () => { throw denied; };
  const outcome = await probe.run(() => { if (paired) throw primary; });
  if (!("error" in outcome)) throw new Error("cleanup failure must reject");
  if (paired) {
    expect(outcome.error).toBeInstanceOf(AggregateError);
    expect(outcome.error).toMatchObject({ cause: primary, errors: [primary, denied] });
  } else expect(outcome.error).toBe(denied);
  expect(denied.code).toBe("EPERM");
  expect(probe.worker?.threadId).toBe(-1);
  expect(existsSync(probe.directory)).toBe(true);
}), 20_000);

it("retains termination failure without removing a still-live worker's directory", () => withProbe(async (probe) => {
  const denied = Object.assign(new Error("injected termination failure"), { code: "TERMINATE_FAILED" });
  probe.options.gate = probe.gate;
  probe.options.terminate = async () => { throw denied; };
  const outcome = probe.run();
  await ready(probe);
  probe.arm(10);
  expect(await outcome).toMatchObject({ error: {
    cause: { code: "STORE_SMOKE_TIMEOUT", layer: "STORE_SMOKE_WORKER" },
    errors: [{ code: "STORE_SMOKE_TIMEOUT", layer: "STORE_SMOKE_WORKER" }, denied],
  } });
  expect(probe.events).not.toContain("remove");
  expect(probe.worker?.threadId).not.toBe(-1);
  expect(existsSync(probe.directory)).toBe(true);
}), 20_000);
