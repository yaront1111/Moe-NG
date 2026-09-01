import { PassThrough, Writable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type { ProjectCatalogEntry } from "./project-catalog.js";
import {
  MAX_PROJECT_STACK_FRAME_BYTES,
  PROJECT_STACK_PROTOCOL_VERSION,
  encodeProjectStackHostFrame,
} from "./project-stack-protocol.js";
import type { ProjectStackHostFrame } from "./project-stack-protocol.js";
import {
  PROJECT_RUNTIME_SUPERVISOR_LAYER,
  createProjectRuntimeSupervisor,
} from "./project-runtime-supervisor.js";
import type {
  ProjectRuntimeBoundary,
  ProjectRuntimeBoundaryOutcome,
} from "./project-runtime-supervisor.js";

const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_INSTANCE_ID = "22222222-2222-4222-8222-222222222222";
const INCARNATION_ID = "33333333-3333-4333-8333-333333333333";
const ORIGIN = "http://127.0.0.1:49152";
const LABEL = "abcd-ef01-2345";

const ENTRY: ProjectCatalogEntry = Object.freeze({
  configPath: "C:\\work\\alpha\\moe.config.json",
  instanceId: INSTANCE_ID,
  projectId: "alpha",
  root: "C:\\work\\alpha",
  storePath: "C:\\work\\alpha\\store.sqlite",
  title: "Alpha",
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly reject: (reason: unknown) => void;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve = (_value: T): void => { throw new Error("deferred not initialized"); };
  let reject = (_reason: unknown): void => { throw new Error("deferred not initialized"); };
  const promise = new Promise<T>((settle, fail) => { resolve = settle; reject = fail; });
  return { promise, reject, resolve };
}

const identity = Object.freeze({ creationTime: 1n, pid: 42 });
const proven = (exitCode = 0): ProjectRuntimeBoundaryOutcome => Object.freeze({
  exitCode,
  identity,
  truthClass: "PROVEN" as const,
});
const unknown = (code = "PROCESS_BOUNDARY_EXIT_UNOBSERVED") => Object.freeze({
  code,
  layer: "WINDOWS_PROCESS_TRANSPORT",
  truthClass: "UNKNOWN" as const,
});

class BoundaryHarness {
  readonly completed = deferred<ProjectRuntimeBoundaryOutcome>();
  readonly started = deferred<typeof identity | ReturnType<typeof unknown>>();
  readonly stdin: Writable;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly controls: string[] = [];
  cancelCount = 0;
  closeCount = 0;

  constructor(stdin: Writable = new PassThrough()) {
    this.stdin = stdin;
    let pending = "";
    this.stdin.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        this.controls.push(pending.slice(0, newline + 1));
        pending = pending.slice(newline + 1);
      }
    });
  }

  boundary(): ProjectRuntimeBoundary {
    return {
      cancel: () => { this.cancelCount += 1; },
      close: async () => {
        this.closeCount += 1;
        return await this.completed.promise;
      },
      completed: this.completed.promise,
      providerStderr: this.stderr,
      providerStdin: this.stdin,
      providerStdout: this.stdout,
      started: this.started.promise,
    };
  }

  emit(frame: ProjectStackHostFrame): void {
    const encoded = encodeProjectStackHostFrame(frame);
    if (!encoded.ok) throw new Error(encoded.code);
    this.stdout.write(encoded.line);
  }

  ready(overrides: Partial<Extract<ProjectStackHostFrame, { kind: "READY" }>> = {}): void {
    this.started.resolve(identity);
    this.emit({
      incarnationId: INCARNATION_ID,
      instanceId: INSTANCE_ID,
      kind: "READY",
      origin: ORIGIN,
      projectId: "alpha",
      schemaVersion: PROJECT_STACK_PROTOCOL_VERSION,
      storePath: ENTRY.storePath,
      ...overrides,
    });
  }

  finish(outcome: ProjectRuntimeBoundaryOutcome, terminalExit?: number): void {
    if (terminalExit !== undefined) {
      this.emit({
        exitCode: terminalExit,
        incarnationId: INCARNATION_ID,
        instanceId: INSTANCE_ID,
        kind: "TERMINAL",
        schemaVersion: PROJECT_STACK_PROTOCOL_VERSION,
      });
    }
    this.stdout.end();
    this.stderr.end();
    this.completed.resolve(outcome);
  }
}

function supervisor(harness: BoundaryHarness, timeoutMs = 50) {
  return createProjectRuntimeSupervisor({
    openBoundary: () => harness.boundary(),
    timeoutMs,
  });
}

async function running(harness: BoundaryHarness, timeoutMs = 50) {
  const runtime = supervisor(harness, timeoutMs);
  const started = runtime.start(ENTRY);
  expect(runtime.list([ENTRY])[0]?.lifecycle).toBe("STARTING");
  harness.ready();
  expect(await started).toEqual({
    code: "PROJECT_RUNTIME_STARTED", layer: PROJECT_RUNTIME_SUPERVISOR_LAYER, ok: true,
  });
  expect(runtime.list([ENTRY])).toEqual([{
    instanceId: INSTANCE_ID, lifecycle: "RUNNING", projectId: "alpha",
    root: ENTRY.root, title: "Alpha",
  }]);
  return runtime;
}

describe("project runtime start and identity", () => {
  it("publishes STARTING synchronously and RUNNING only after the matching READY frame", async () => {
    const harness = new BoundaryHarness();
    const runtime = supervisor(harness);
    const started = runtime.start(ENTRY);
    expect(runtime.list([ENTRY])[0]?.lifecycle).toBe("STARTING");
    harness.started.resolve(identity);
    await Promise.resolve();
    expect(runtime.list([ENTRY])[0]?.lifecycle).toBe("STARTING");
    harness.emit({
      incarnationId: INCARNATION_ID, instanceId: INSTANCE_ID, kind: "READY", origin: ORIGIN,
      projectId: "alpha", schemaVersion: PROJECT_STACK_PROTOCOL_VERSION,
      storePath: "c:/WORK/alpha/store.sqlite",
    });
    expect(await started).toEqual({
      code: "PROJECT_RUNTIME_STARTED", layer: PROJECT_RUNTIME_SUPERVISOR_LAYER, ok: true,
    });
    expect(runtime.list([ENTRY])[0]?.lifecycle).toBe("RUNNING");
  });

  it.each([
    ["instance", { instanceId: OTHER_INSTANCE_ID }],
    ["project", { projectId: "other" }],
    ["store", { storePath: "C:\\work\\other\\store.sqlite" }],
  ])("fails closed when READY carries a foreign %s identity", async (_name, override) => {
    const harness = new BoundaryHarness();
    const runtime = supervisor(harness);
    const started = runtime.start(ENTRY);
    harness.ready(override);
    expect(await started).toEqual({
      code: "PROJECT_RUNTIME_READY_MISMATCH", layer: PROJECT_RUNTIME_SUPERVISOR_LAYER, ok: false,
    });
    expect(runtime.list([ENTRY])[0]?.lifecycle).toBe("UNKNOWN");
    expect(harness.cancelCount).toBe(1);
  });

  it("preserves a valid host start refusal without exposing its detail", async () => {
    const harness = new BoundaryHarness();
    const runtime = supervisor(harness);
    const started = runtime.start(ENTRY);
    harness.started.resolve(identity);
    harness.emit({
      code: "PROJECT_STACK_CONFIG_MISMATCH", incarnationId: INCARNATION_ID,
      kind: "START_REFUSED", layer: "PROJECT_STACK_HOST",
      schemaVersion: PROJECT_STACK_PROTOCOL_VERSION,
    });
    expect(await started).toEqual({
      code: "PROJECT_STACK_CONFIG_MISMATCH", layer: "PROJECT_STACK_HOST", ok: false,
    });
    harness.finish(proven(1));
    await vi.waitFor(() => { expect(runtime.list([ENTRY])[0]?.lifecycle).toBe("FAILED"); });
  });

  it("preserves a synchronous Windows-boundary refusal and creates no active store claim", async () => {
    let opens = 0;
    const runtime = createProjectRuntimeSupervisor({
      openBoundary: () => {
        opens += 1;
        return unknown("PROCESS_BOUNDARY_PLATFORM_UNSUPPORTED");
      },
    });
    expect(await runtime.start(ENTRY)).toEqual({
      code: "PROCESS_BOUNDARY_PLATFORM_UNSUPPORTED",
      layer: "WINDOWS_PROCESS_TRANSPORT",
      ok: false,
    });
    expect(runtime.list([ENTRY])[0]?.lifecycle).toBe("UNKNOWN");
    expect(await runtime.start(ENTRY)).toMatchObject({ ok: false });
    expect(opens).toBe(2);
  });

  it("reserves a canonical Windows store before awaiting and rejects duplicate active starts", async () => {
    const first = new BoundaryHarness();
    const second = new BoundaryHarness();
    const opened: BoundaryHarness[] = [];
    const runtime = createProjectRuntimeSupervisor({
      openBoundary: () => (opened.push(opened.length === 0 ? first : second), opened.at(-1)!.boundary()),
    });
    const pending = runtime.start(ENTRY);
    expect(await runtime.start({
      ...ENTRY,
      configPath: "C:\\work\\beta\\moe.config.json",
      instanceId: OTHER_INSTANCE_ID,
      projectId: "beta",
      root: "C:\\work\\beta",
      storePath: "c:/WORK/alpha/STORE.sqlite",
      title: "Beta",
    })).toEqual({
      code: "PROJECT_RUNTIME_STORE_ACTIVE", layer: PROJECT_RUNTIME_SUPERVISOR_LAYER, ok: false,
    });
    expect(await runtime.start(ENTRY)).toEqual({
      code: "PROJECT_RUNTIME_INSTANCE_ACTIVE", layer: PROJECT_RUNTIME_SUPERVISOR_LAYER, ok: false,
    });
    expect(opened).toEqual([first]);
    first.ready();
    await pending;
  });

  it("does not apply a live lifecycle to a supplied catalog identity that drifted", async () => {
    const harness = new BoundaryHarness();
    const runtime = await running(harness);
    expect(runtime.list([{ ...ENTRY, projectId: "replacement" }])[0]?.lifecycle).toBe("UNKNOWN");
    expect(runtime.list([{ ...ENTRY, storePath: "C:\\work\\replacement\\store.sqlite" }])[0]?.lifecycle)
      .toBe("UNKNOWN");
  });

  it("turns a rejected boundary-start promise into a stable secret-free refusal", async () => {
    const harness = new BoundaryHarness();
    const runtime = supervisor(harness);
    const started = runtime.start(ENTRY);
    harness.started.reject(new Error("credential=must-not-surface"));
    const result = await started;
    expect(result).toEqual({
      code: "PROJECT_RUNTIME_BOUNDARY_REFUSED", layer: PROJECT_RUNTIME_SUPERVISOR_LAYER, ok: false,
    });
    expect(JSON.stringify(result)).not.toContain("must-not-surface");
    expect(runtime.list([ENTRY])[0]?.lifecycle).toBe("UNKNOWN");
  });
});

describe("project runtime completion and stop", () => {
  it("maps an unexpected proven exit to FAILED and an unproven completion to UNKNOWN", async () => {
    const failedHarness = new BoundaryHarness();
    const failed = await running(failedHarness);
    failedHarness.finish(proven(7), 7);
    await vi.waitFor(() => { expect(failed.list([ENTRY])[0]?.lifecycle).toBe("FAILED"); });

    const unknownHarness = new BoundaryHarness();
    const uncertain = await running(unknownHarness);
    unknownHarness.finish(unknown());
    await vi.waitFor(() => { expect(uncertain.list([ENTRY])[0]?.lifecycle).toBe("UNKNOWN"); });
  });

  it("enters STOPPING before I/O and reaches STOPPED only after proven Job completion", async () => {
    const harness = new BoundaryHarness();
    const runtime = await running(harness);
    const stopped = runtime.stop(INSTANCE_ID);
    expect(runtime.list([ENTRY])[0]?.lifecycle).toBe("STOPPING");
    await vi.waitFor(() => { expect(harness.controls).toHaveLength(1); });
    expect(JSON.parse(harness.controls[0] ?? "{}")).toEqual({
      instanceId: INSTANCE_ID, kind: "STOP", schemaVersion: PROJECT_STACK_PROTOCOL_VERSION,
    });
    harness.emit({
      exitCode: 0, incarnationId: INCARNATION_ID, instanceId: INSTANCE_ID, kind: "TERMINAL",
      schemaVersion: PROJECT_STACK_PROTOCOL_VERSION,
    });
    await Promise.resolve();
    expect(runtime.list([ENTRY])[0]?.lifecycle).toBe("STOPPING");
    harness.finish(proven());
    expect(await stopped).toEqual({
      code: "PROJECT_RUNTIME_STOPPED", layer: PROJECT_RUNTIME_SUPERVISOR_LAYER, ok: true,
    });
    expect(runtime.list([ENTRY])[0]?.lifecycle).toBe("STOPPED");
  });

  it("bounds graceful stop, cancels the Job boundary, and leaves unproven death UNKNOWN", async () => {
    const harness = new BoundaryHarness();
    const runtime = await running(harness, 5);
    expect(await runtime.stop(INSTANCE_ID)).toEqual({
      code: "PROJECT_RUNTIME_STOP_TIMEOUT", layer: PROJECT_RUNTIME_SUPERVISOR_LAYER, ok: false,
    });
    expect(runtime.list([ENTRY])[0]?.lifecycle).toBe("UNKNOWN");
    expect(harness.cancelCount).toBeGreaterThan(0);
    expect(harness.closeCount).toBeGreaterThan(0);
  });

  it("bounds a STOP write whose Writable callback never fires", async () => {
    const stalledInput = new Writable({
      write(_chunk, _encoding, _callback): void {
        // Hostile transport: it accepts the bytes but never acknowledges them.
      },
    });
    const harness = new BoundaryHarness(stalledInput);
    const runtime = await running(harness, 5);
    const observed = await Promise.race([
      runtime.stop(INSTANCE_ID),
      new Promise<"TEST_TIMEOUT">((resolve) => {
        setTimeout(() => { resolve("TEST_TIMEOUT"); }, 100);
      }),
    ]);

    expect(observed).toEqual({
      code: "PROJECT_RUNTIME_STOP_TIMEOUT", layer: PROJECT_RUNTIME_SUPERVISOR_LAYER, ok: false,
    });
    expect(runtime.list([ENTRY])[0]?.lifecycle).toBe("UNKNOWN");
    expect(harness.cancelCount).toBe(1);
    expect(harness.closeCount).toBe(1);
  });

  it("rejects lifecycle overlap without writing a second control", async () => {
    const harness = new BoundaryHarness();
    const runtime = await running(harness);
    const stopping = runtime.stop(INSTANCE_ID);
    expect(await runtime.stop(INSTANCE_ID)).toEqual({
      code: "PROJECT_RUNTIME_OPERATION_ACTIVE", layer: PROJECT_RUNTIME_SUPERVISOR_LAYER, ok: false,
    });
    await vi.waitFor(() => { expect(harness.controls).toHaveLength(1); });
    harness.finish(proven(), 0);
    await stopping;
  });

  it("turns a rejected completion promise into UNKNOWN without throwing", async () => {
    const harness = new BoundaryHarness();
    const runtime = await running(harness);
    const stopping = runtime.stop(INSTANCE_ID);
    harness.completed.reject(new Error("credential=must-not-surface"));
    const result = await stopping;
    expect(result).toEqual({
      code: "PROJECT_RUNTIME_BOUNDARY_REFUSED", layer: PROJECT_RUNTIME_SUPERVISOR_LAYER, ok: false,
    });
    expect(JSON.stringify(result)).not.toContain("must-not-surface");
    expect(runtime.list([ENTRY])[0]?.lifecycle).toBe("UNKNOWN");
  });

  it("does not launder proven completion before the host channel closes", async () => {
    const harness = new BoundaryHarness();
    const runtime = await running(harness, 5);
    const stopping = runtime.stop(INSTANCE_ID);
    harness.completed.resolve(proven());
    expect(await stopping).toEqual({
      code: "PROJECT_RUNTIME_PROTOCOL_VIOLATION",
      layer: PROJECT_RUNTIME_SUPERVISOR_LAYER,
      ok: false,
    });
    expect(runtime.list([ENTRY])[0]?.lifecycle).toBe("UNKNOWN");
  });

  it("refuses a malformed PROVEN shape instead of treating it as death proof", async () => {
    const harness = new BoundaryHarness();
    const runtime = await running(harness);
    const stopping = runtime.stop(INSTANCE_ID);
    harness.stdout.end();
    harness.completed.resolve({ ...proven(), exitCode: Number.NaN } as ProjectRuntimeBoundaryOutcome);
    expect(await stopping).toMatchObject({ code: "PROJECT_RUNTIME_PROTOCOL_VIOLATION", ok: false });
    expect(runtime.list([ENTRY])[0]?.lifecycle).toBe("UNKNOWN");
  });
});

describe("project runtime plain-origin open and private pairing approval", () => {
  it("opens only a running project and returns its plain origin without control I/O", async () => {
    const harness = new BoundaryHarness();
    const runtime = supervisor(harness);
    expect(await runtime.open(INSTANCE_ID)).toMatchObject({
      code: "PROJECT_RUNTIME_NOT_RUNNING", ok: false,
    });
    const started = runtime.start(ENTRY);
    harness.ready();
    await started;
    expect(await runtime.open(INSTANCE_ID)).toEqual({
      code: "PROJECT_RUNTIME_OPENED", layer: PROJECT_RUNTIME_SUPERVISOR_LAYER,
      ok: true, origin: ORIGIN,
    });
    expect(harness.controls).toEqual([]);
    expect(JSON.stringify(runtime.list([ENTRY]))).not.toContain(ORIGIN);
  });

  it("approves only through an instance-bound private frame and emits no label back", async () => {
    const harness = new BoundaryHarness();
    const runtime = await running(harness);
    const approval = runtime.approvePairing(INSTANCE_ID, LABEL);
    await vi.waitFor(() => { expect(harness.controls).toHaveLength(1); });
    expect(JSON.parse(harness.controls[0] ?? "{}")).toEqual({
      confirmationLabel: LABEL,
      instanceId: INSTANCE_ID,
      kind: "APPROVE_PAIRING",
      schemaVersion: PROJECT_STACK_PROTOCOL_VERSION,
    });
    const response: ProjectStackHostFrame = {
      incarnationId: INCARNATION_ID, instanceId: INSTANCE_ID, kind: "PAIRING_APPROVED",
      schemaVersion: PROJECT_STACK_PROTOCOL_VERSION,
    };
    harness.emit(response);
    expect(JSON.stringify(response)).not.toContain(LABEL);
    expect(await approval).toEqual({
      code: "PROJECT_RUNTIME_PAIRING_APPROVED", layer: PROJECT_RUNTIME_SUPERVISOR_LAYER, ok: true,
    });
  });

  it("preserves a correlated approval refusal and blocks overlapping stop", async () => {
    const harness = new BoundaryHarness();
    const runtime = await running(harness);
    const approval = runtime.approvePairing(INSTANCE_ID, LABEL);
    expect(await runtime.stop(INSTANCE_ID)).toMatchObject({
      code: "PROJECT_RUNTIME_OPERATION_ACTIVE", ok: false,
    });
    harness.emit({
      code: "PAIRING_CONFIRMATION_UNKNOWN", incarnationId: INCARNATION_ID,
      instanceId: INSTANCE_ID, kind: "PAIRING_REFUSED",
      layer: "CONTROL_ROOM_PAIRING_APPROVAL", schemaVersion: PROJECT_STACK_PROTOCOL_VERSION,
    });
    expect(await approval).toEqual({
      code: "PAIRING_CONFIRMATION_UNKNOWN", layer: "CONTROL_ROOM_PAIRING_APPROVAL", ok: false,
    });
    expect(runtime.list([ENTRY])[0]?.lifecycle).toBe("RUNNING");
  });

  it("fails closed on an approval result from another project instance", async () => {
    const harness = new BoundaryHarness();
    const runtime = await running(harness);
    const approval = runtime.approvePairing(INSTANCE_ID, LABEL);
    harness.emit({
      incarnationId: INCARNATION_ID, instanceId: OTHER_INSTANCE_ID, kind: "PAIRING_APPROVED",
      schemaVersion: PROJECT_STACK_PROTOCOL_VERSION,
    });
    expect(await approval).toMatchObject({ code: "PROJECT_RUNTIME_PROTOCOL_VIOLATION", ok: false });
    expect(runtime.list([ENTRY])[0]?.lifecycle).toBe("UNKNOWN");
    expect(harness.cancelCount).toBe(1);
  });
});

describe("project runtime hostile channels", () => {
  it("bounds stdout frames, fails closed on malformed and extra frames, and drains stderr", async () => {
    const oversizedHarness = new BoundaryHarness();
    const oversized = supervisor(oversizedHarness);
    const pending = oversized.start(ENTRY);
    oversizedHarness.started.resolve(identity);
    oversizedHarness.stderr.write("credential=must-not-surface");
    oversizedHarness.stdout.write(Buffer.alloc(MAX_PROJECT_STACK_FRAME_BYTES + 1, 0x78));
    expect(await pending).toEqual({
      code: "PROJECT_STACK_PROTOCOL_FRAME_TOO_LARGE",
      layer: "PROJECT_STACK_PROTOCOL",
      ok: false,
    });
    expect(JSON.stringify(oversized.list([ENTRY]))).not.toContain("must-not-surface");
    expect(oversizedHarness.cancelCount).toBe(1);

    const extraHarness = new BoundaryHarness();
    const extra = await running(extraHarness);
    extraHarness.ready();
    await vi.waitFor(() => { expect(extra.list([ENTRY])[0]?.lifecycle).toBe("UNKNOWN"); });
    expect(extraHarness.cancelCount).toBe(1);
  });
});

describe("project runtime supervisor shutdown", () => {
  it("cancels every active project before awaiting and marks only proven teardown STOPPED", async () => {
    const alpha = new BoundaryHarness();
    const beta = new BoundaryHarness();
    const boundaries = [alpha, beta];
    let opened = 0;
    const runtime = createProjectRuntimeSupervisor({
      openBoundary: () => boundaries[opened++]!.boundary(),
      timeoutMs: 50,
    });
    const betaEntry = Object.freeze({
      ...ENTRY,
      configPath: "C:\\work\\beta\\moe.config.json",
      instanceId: OTHER_INSTANCE_ID,
      projectId: "beta",
      root: "C:\\work\\beta",
      storePath: "C:\\work\\beta\\store.sqlite",
      title: "Beta",
    });
    const alphaStarted = runtime.start(ENTRY);
    alpha.ready();
    await alphaStarted;
    const betaStarted = runtime.start(betaEntry);
    beta.ready({ instanceId: OTHER_INSTANCE_ID, projectId: "beta", storePath: betaEntry.storePath });
    await betaStarted;

    const shutdown = runtime.shutdown();
    expect(runtime.list([ENTRY, betaEntry]).map((item) => item.lifecycle))
      .toEqual(["STOPPING", "STOPPING"]);
    expect([alpha.cancelCount, beta.cancelCount]).toEqual([1, 1]);
    expect([alpha.closeCount, beta.closeCount]).toEqual([1, 1]);
    alpha.finish(proven());
    beta.finish(unknown());
    expect(await shutdown).toEqual({
      code: "PROJECT_RUNTIME_SHUTDOWN_UNPROVEN",
      layer: PROJECT_RUNTIME_SUPERVISOR_LAYER,
      ok: false,
    });
    expect(runtime.list([ENTRY, betaEntry]).map((item) => item.lifecycle))
      .toEqual(["STOPPED", "UNKNOWN"]);
    expect(JSON.stringify(await shutdown)).not.toContain(ORIGIN);
    expect(JSON.stringify(await shutdown)).not.toContain(LABEL);
  });

  it("bounds a hung close and leaves the runtime UNKNOWN", async () => {
    const harness = new BoundaryHarness();
    const runtime = await running(harness, 5);
    expect(await runtime.shutdown()).toEqual({
      code: "PROJECT_RUNTIME_SHUTDOWN_UNPROVEN",
      layer: PROJECT_RUNTIME_SUPERVISOR_LAYER,
      ok: false,
    });
    expect(runtime.list([ENTRY])[0]?.lifecycle).toBe("UNKNOWN");
    expect(harness.cancelCount).toBe(1);
    expect(harness.closeCount).toBe(1);
  });

  it("keeps proven teardown STOPPED when it interrupts an in-flight approval", async () => {
    const harness = new BoundaryHarness();
    const runtime = await running(harness);
    const opening = runtime.approvePairing(INSTANCE_ID, LABEL);
    const shutdown = runtime.shutdown();
    harness.finish(proven());
    expect(await shutdown).toMatchObject({ code: "PROJECT_RUNTIME_SHUTDOWN", ok: true });
    expect(await opening).toMatchObject({ ok: false });
    expect(runtime.list([ENTRY])[0]?.lifecycle).toBe("STOPPED");
  });

  it("does not let a late READY overwrite a teardown already proven STOPPED", async () => {
    const harness = new BoundaryHarness();
    const runtime = supervisor(harness);
    const starting = runtime.start(ENTRY);
    const shutdown = runtime.shutdown();
    harness.completed.resolve(proven());
    harness.ready();
    harness.stdout.end();
    harness.stderr.end();
    expect(await shutdown).toMatchObject({ code: "PROJECT_RUNTIME_SHUTDOWN", ok: true });
    expect(await starting).toMatchObject({ code: "PROJECT_RUNTIME_EXITED_BEFORE_READY", ok: false });
    expect(runtime.list([ENTRY])[0]?.lifecycle).toBe("STOPPED");
  });
});

describe("project runtime completion wait", () => {
  it("refuses an unknown instance without opening authority", async () => {
    const harness = new BoundaryHarness();
    const runtime = supervisor(harness);
    expect(await runtime.wait(OTHER_INSTANCE_ID)).toEqual({
      code: "PROJECT_RUNTIME_INSTANCE_UNKNOWN",
      layer: PROJECT_RUNTIME_SUPERVISOR_LAYER,
      ok: false,
    });
    expect(harness.cancelCount).toBe(0);
    expect(harness.closeCount).toBe(0);
  });

  it("waits for natural proven completion and returns only the exact exit code", async () => {
    const harness = new BoundaryHarness();
    const runtime = await running(harness);
    let settled = false;
    const completion = runtime.wait(INSTANCE_ID).finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(runtime.list([ENTRY])[0]?.lifecycle).toBe("RUNNING");
    harness.finish(proven(23), 23);
    const result = await completion;
    expect(result).toEqual({
      code: "PROJECT_RUNTIME_COMPLETED",
      exitCode: 23,
      layer: PROJECT_RUNTIME_SUPERVISOR_LAYER,
      ok: true,
    });
    expect(JSON.stringify(result)).not.toContain("pid");
    expect(JSON.stringify(result)).not.toContain(ORIGIN);
    expect(JSON.stringify(result)).not.toContain(LABEL);
  });

  it("preserves an unproven boundary refusal without an exit code", async () => {
    const harness = new BoundaryHarness();
    const runtime = await running(harness);
    const completion = runtime.wait(INSTANCE_ID);
    harness.finish(unknown("PROCESS_BOUNDARY_EXIT_UNOBSERVED"));
    expect(await completion).toEqual({
      code: "PROCESS_BOUNDARY_EXIT_UNOBSERVED",
      layer: "WINDOWS_PROCESS_TRANSPORT",
      ok: false,
    });
  });
});
