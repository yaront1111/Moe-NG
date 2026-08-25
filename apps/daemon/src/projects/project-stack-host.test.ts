import { describe, expect, it } from "vitest";

import { PROJECT_STACK_PROTOCOL_VERSION } from "./project-stack-protocol.js";
import { runProjectStackHost } from "./project-stack-host.js";
import type {
  ProjectStackDaemonHandle,
  ProjectStackHostOptions,
  ProjectStackWrapperHandle,
} from "./project-stack-host.js";

const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const INCARNATION_ID = "22222222-2222-4222-8222-222222222222";
const ORIGIN = "http://127.0.0.1:49152";
const LABEL = "abcd-ef01-2345";
const STORE_PATH = "C:\\work\\alpha\\store.sqlite";

class ControlQueue implements AsyncIterable<string> {
  private ended = false;
  private readonly values: string[] = [];
  private readonly waiters: ((value: IteratorResult<string>) => void)[] = [];

  push(value: object | string): void {
    const line = typeof value === "string" ? value : `${JSON.stringify(value)}\n`;
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.values.push(line);
    else waiter({ done: false, value: line });
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: async (): Promise<IteratorResult<string>> => {
        const value = this.values.shift();
        if (value !== undefined) return { done: false, value };
        if (this.ended) return { done: true, value: undefined };
        return await new Promise((resolve) => { this.waiters.push(resolve); });
      },
    };
  }
}

interface Harness {
  readonly controls: ControlQueue;
  readonly frame: (index: number) => Record<string, unknown>;
  readonly lines: string[];
  readonly result: Promise<number>;
  readonly wrapper: ProjectStackWrapperHandle & { exit(code: number | null): void; readonly kills: number };
}

function wrapperHandle(): Harness["wrapper"] {
  let settle!: (value: { readonly code: number | null }) => void;
  const completed = new Promise<{ readonly code: number | null }>((resolve) => { settle = resolve; });
  let kills = 0;
  return {
    completed,
    exit: (code) => { settle({ code }); },
    get kills() { return kills; },
    kill: () => { kills += 1; settle({ code: 0 }); },
  };
}

function start(overrides: Partial<ProjectStackHostOptions> = {}): Harness {
  const controls = new ControlQueue();
  const written: string[] = [];
  const lines: string[] = [];
  const wrapper = wrapperHandle();
  const daemon: ProjectStackDaemonHandle = {
    approvePairing: () => ({ ok: true, state: "APPROVED" }),
    origin: ORIGIN,
    shutdown: async () => ({ ok: true }),
  };
  const result = runProjectStackHost({
    controls,
    incarnationId: INCARNATION_ID,
    instanceId: INSTANCE_ID,
    log: (line) => lines.push(line),
    projectId: "alpha",
    startDaemon: async () => daemon,
    startWrapper: () => wrapper,
    storePath: STORE_PATH,
    write: (line) => { written.push(line); },
    ...overrides,
  });
  const frame = (index: number): Record<string, unknown> =>
    JSON.parse(Array.prototype.at.call(written, index) ?? "null") as Record<string, unknown>;
  return { controls, frame, lines, result, wrapper };
}

const approval = () => ({
  confirmationLabel: LABEL, instanceId: INSTANCE_ID, kind: "APPROVE_PAIRING",
  schemaVersion: PROJECT_STACK_PROTOCOL_VERSION,
});
const stop = () => ({
  instanceId: INSTANCE_ID, kind: "STOP", schemaVersion: PROJECT_STACK_PROTOCOL_VERSION,
});

describe("runProjectStackHost", () => {
  it("announces READY, approves pairing privately, then proves a graceful stop", async () => {
    let shutdowns = 0;
    const harness = start({
      startDaemon: async () => ({
        approvePairing: (label) => label === LABEL
          ? ({ ok: true, state: "APPROVED" })
          : ({ code: "PAIRING_CONFIRMATION_UNKNOWN", layer: "CONTROL_ROOM_PAIRING_APPROVAL", ok: false }),
        origin: ORIGIN,
        shutdown: async () => { shutdowns += 1; return { ok: true }; },
      }),
    });
    await Promise.resolve();
    expect(harness.frame(0)).toEqual({
      incarnationId: INCARNATION_ID,
      instanceId: INSTANCE_ID,
      kind: "READY",
      origin: ORIGIN,
      projectId: "alpha",
      schemaVersion: PROJECT_STACK_PROTOCOL_VERSION,
      storePath: STORE_PATH,
    });

    harness.controls.push(approval());
    await new Promise((resolve) => { setImmediate(resolve); });
    expect(harness.frame(1)).toEqual({
      incarnationId: INCARNATION_ID,
      instanceId: INSTANCE_ID,
      kind: "PAIRING_APPROVED",
      schemaVersion: PROJECT_STACK_PROTOCOL_VERSION,
    });

    harness.controls.push(stop());
    expect(await harness.result).toBe(0);
    expect([shutdowns, harness.wrapper.kills]).toEqual([1, 1]);
    expect(harness.frame(2)).toEqual({
      exitCode: 0,
      incarnationId: INCARNATION_ID,
      instanceId: INSTANCE_ID,
      kind: "TERMINAL",
      schemaVersion: PROJECT_STACK_PROTOCOL_VERSION,
    });
    expect(JSON.stringify([harness.frame(1), harness.lines])).not.toContain(LABEL);
  });

  it("relays an approval refusal without changing its code or layer", async () => {
    const harness = start({
      startDaemon: async () => ({
        approvePairing: () => ({
          code: "PAIRING_CONFIRMATION_UNKNOWN", layer: "CONTROL_ROOM_PAIRING_APPROVAL", ok: false,
        }),
        origin: ORIGIN,
        shutdown: async () => ({ ok: true }),
      }),
    });
    await Promise.resolve();
    harness.controls.push(approval());
    await new Promise((resolve) => { setImmediate(resolve); });
    expect(harness.frame(1)).toEqual({
      code: "PAIRING_CONFIRMATION_UNKNOWN",
      incarnationId: INCARNATION_ID,
      instanceId: INSTANCE_ID,
      kind: "PAIRING_REFUSED",
      layer: "CONTROL_ROOM_PAIRING_APPROVAL",
      schemaVersion: PROJECT_STACK_PROTOCOL_VERSION,
    });
    harness.controls.push(stop());
    await harness.result;
  });

  it("fails closed and tears down when the supervisor sends a malformed frame", async () => {
    let shutdowns = 0;
    const harness = start({
      startDaemon: async () => ({
        approvePairing: () => { throw new Error("not called"); },
        origin: ORIGIN,
        shutdown: async () => { shutdowns += 1; return { ok: true }; },
      }),
    });
    await Promise.resolve();
    harness.controls.push('{"kind":"EXEC","secret":"do-not-echo"}\n');
    expect(await harness.result).toBe(1);
    expect([shutdowns, harness.wrapper.kills]).toEqual([1, 1]);
    expect(harness.lines).toEqual(["PROJECT_STACK_CONTROL_REFUSED PROJECT_STACK_PROTOCOL"]);
    expect(JSON.stringify([harness.frame(0), harness.lines])).not.toContain("do-not-echo");
  });

  it("maps a wrapper exit to terminal proof and closes the daemon", async () => {
    let shutdowns = 0;
    const harness = start({
      startDaemon: async () => ({
        approvePairing: () => { throw new Error("not called"); },
        origin: ORIGIN,
        shutdown: async () => { shutdowns += 1; return { ok: true }; },
      }),
    });
    await Promise.resolve();
    harness.wrapper.exit(7);
    expect(await harness.result).toBe(7);
    expect(shutdowns).toBe(1);
    expect(harness.frame(1)["exitCode"]).toBe(7);
  });

  it("publishes an exact start refusal and starts no wrapper when the daemon refuses", async () => {
    let wrappers = 0;
    const harness = start({
      startDaemon: async () => ({
        code: "DAEMON_ENTRY_PROVIDER_THREW", layer: "DAEMON_ENTRY", ok: false,
      }),
      startWrapper: () => { wrappers += 1; return wrapperHandle(); },
    });
    expect(await harness.result).toBe(1);
    expect(wrappers).toBe(0);
    expect(harness.frame(0)).toEqual({
      code: "DAEMON_ENTRY_PROVIDER_THREW",
      incarnationId: INCARNATION_ID,
      kind: "START_REFUSED",
      layer: "DAEMON_ENTRY",
      schemaVersion: PROJECT_STACK_PROTOCOL_VERSION,
    });
  });
});
