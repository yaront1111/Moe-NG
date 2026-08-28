import { describe, expect, it, vi } from "vitest";

// Simulate the ubuntu/macos gate: native basename is POSIX there, while the
// Windows-shaped request must still be interpreted identically on every host.
vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return { ...actual, basename: actual.posix.basename };
});

import { PassThrough } from "node:stream";

import { encodeLaunchPayload } from "./windows-launch-request.js";
import { type BrokerPipes } from "./windows-broker-process.js";
import { encodeFrame } from "./windows-frames.js";
import {
  PROJECT_STACK_ENVIRONMENT_KEYS,
  PROJECT_STACK_PROVIDER_CREDENTIAL_KEYS,
  encodeProjectStackLaunchPayload,
  openWindowsProjectStackBoundary,
} from "./windows-project-stack-boundary.js";

const REQUEST = {
  assetRoot: "C:\\Moe\\control-room",
  configPath: "C:\\Work\\alpha\\moe.config.json",
  cwd: "C:\\Moe",
  entryPath: "C:\\Moe\\apps\\daemon\\src\\projects\\project-stack-host-main.ts",
  instanceId: "11111111-1111-4111-8111-111111111111",
  storePath: "C:\\Work\\alpha\\store.sqlite",
  environment: {
    ANTHROPIC_AUTH_TOKEN: "provider-secret",
    MOE_AGENT_COMMAND: "claude",
    MOE_DAEMON_CREDENTIAL: "operator-secret",
    MOE_PROJECT_ID: "alpha",
    SYSTEMROOT: "C:\\Windows",
  },
  nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
} as const;

describe("the curated Windows project-stack request", () => {
  it("uses the dedicated locked-launch opcode and preserves contention evidence", async () => {
    let control: Uint8Array = new Uint8Array(0);
    let status: ((chunk: Uint8Array) => void) | undefined;
    let exited: ((code: number | null, signal: string | null) => void) | undefined;
    const stream = (): PassThrough => new PassThrough();
    const pipes: BrokerPipes = {
      pid: 42,
      providerStdin: stream(), providerStdout: stream(), providerStderr: stream(),
      writeControl: (bytes) => { control = bytes; },
      endControl: () => {}, closeProviderChannels: () => {}, kill: () => {}, dispose: () => {},
      onStatus: (listener) => { status = listener; },
      onExit: (listener) => { exited = listener; },
      onError: () => {},
    };
    const boundary = openWindowsProjectStackBoundary(REQUEST, {
      deps: { platform: "win32", resolveBroker: () => "C:\\Moe\\broker.exe", spawn: () => pipes },
    });
    if ("truthClass" in boundary) throw new Error(`boundary refused: ${boundary.code}`);
    expect(control[1]).toBe(3);

    const refusal = encodeFrame("STATUS", 3, Uint8Array.from([4, 1, 0, 32, 0, 0, 0]));
    if (!(refusal instanceof Uint8Array)) throw new Error("refusal fixture did not encode");
    status?.(refusal);
    exited?.(20, null);
    const outcome = await boundary.completed;
    expect(outcome).toMatchObject({
      truthClass: "UNKNOWN",
      code: "PROCESS_BOUNDARY_BROKER_REFUSED",
      layer: "BROKER_STORE_LOCK",
      brokerReason: { layer: "BROKER_STORE_LOCK", reason: 1, code: 32 },
    });
  });

  it("does not convert a healthy long-lived project into a provider timeout", async () => {
    vi.useFakeTimers();
    try {
      let ended = 0;
      let status: ((chunk: Uint8Array) => void) | undefined;
      let exited: ((code: number | null, signal: string | null) => void) | undefined;
      const stream = (): PassThrough => new PassThrough();
      const pipes: BrokerPipes = {
        pid: 42,
        providerStdin: stream(), providerStdout: stream(), providerStderr: stream(),
        writeControl: () => {}, endControl: () => { ended += 1; },
        closeProviderChannels: () => {}, kill: () => {}, dispose: () => {},
        onStatus: (listener) => { status = listener; },
        onExit: (listener) => { exited = listener; }, onError: () => {},
      };
      const boundary = openWindowsProjectStackBoundary(REQUEST, {
        deps: {
          platform: "win32", resolveBroker: () => "C:\\Moe\\broker.exe", spawn: () => pipes,
        },
      });
      if ("truthClass" in boundary) throw new Error(`boundary refused: ${boundary.code}`);

      await vi.advanceTimersByTimeAsync(30 * 60 * 1_000);
      expect(ended).toBe(0);

      const refusal = encodeFrame("STATUS", 3, Uint8Array.from([4, 1, 0, 32, 0, 0, 0]));
      if (!(refusal instanceof Uint8Array)) throw new Error("refusal fixture did not encode");
      status?.(refusal);
      exited?.(20, null);
      await boundary.completed;
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses non-Windows before resolving or spawning the broker", () => {
    let resolves = 0;
    let spawns = 0;
    const result = openWindowsProjectStackBoundary(REQUEST, {
      deps: {
        platform: "linux",
        resolveBroker: () => { resolves += 1; return "C:\\Moe\\broker.exe"; },
        spawn: () => { spawns += 1; throw new Error("must not spawn"); },
      },
    });
    expect("truthClass" in result ? result.code : "BOUNDARY_OPENED")
      .toBe("PROCESS_BOUNDARY_PLATFORM_UNSUPPORTED");
    expect([resolves, spawns]).toEqual([0, 0]);
  });

  it("refuses a forward-slash executable without normalising separators", () => {
    const result = encodeProjectStackLaunchPayload({
      ...REQUEST,
      nodeExecutable: "C:/Program Files/nodejs/node.exe",
    });
    expect(result).toEqual({
      brokerReason: null,
      code: "PROCESS_BOUNDARY_EXECUTABLE_REJECTED",
      identity: null,
      layer: "WINDOWS_PROCESS_REQUEST",
      message: "the project stack executable is not node.exe",
      truthClass: "UNKNOWN",
    });
  });

  it("admits the exact daemon/provider environment without widening provider launch", () => {
    const encoded = encodeProjectStackLaunchPayload(REQUEST);
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(encoded as Uint8Array)).toContain(REQUEST.instanceId);
    expect(new TextDecoder().decode(encoded as Uint8Array)).toContain(REQUEST.storePath);

    const rawProviderShape = {
      argv: [], cwd: REQUEST.cwd, environment: REQUEST.environment,
      executable: REQUEST.nodeExecutable,
    };
    const provider = encodeLaunchPayload(rawProviderShape);
    expect(provider).not.toBeInstanceOf(Uint8Array);
    if (provider instanceof Uint8Array) throw new Error("provider launch unexpectedly widened");
    expect(provider.code).toBe("PROCESS_BOUNDARY_ENVIRONMENT_REJECTED");
  });

  it("publishes a finite reviewed environment roster", () => {
    expect(PROJECT_STACK_ENVIRONMENT_KEYS).toContain("MOE_DAEMON_CREDENTIAL");
    expect(PROJECT_STACK_ENVIRONMENT_KEYS).toContain("ANTHROPIC_AUTH_TOKEN");
    expect(PROJECT_STACK_ENVIRONMENT_KEYS).toContain("CODEX_HOME");
    expect(PROJECT_STACK_ENVIRONMENT_KEYS).toContain("MOE_PROJECT_INSTANCE_ID");
    expect(PROJECT_STACK_ENVIRONMENT_KEYS).not.toContain("NODE_OPTIONS");
    expect(new Set(PROJECT_STACK_ENVIRONMENT_KEYS).size).toBe(PROJECT_STACK_ENVIRONMENT_KEYS.length);
    expect(PROJECT_STACK_PROVIDER_CREDENTIAL_KEYS).toEqual([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CODEX_ACCESS_TOKEN",
      "CODEX_API_KEY",
      "CODEX_HOME",
      "OPENAI_API_KEY",
    ]);
    expect(PROJECT_STACK_PROVIDER_CREDENTIAL_KEYS.every((name) =>
      PROJECT_STACK_ENVIRONMENT_KEYS.includes(name))).toBe(true);
  });

  it.each(["NODE_OPTIONS", "HTTP_PROXY", "UNREVIEWED_SECRET"])(
    "refuses unreviewed environment key %s",
    (name) => {
      const result = encodeProjectStackLaunchPayload({
        ...REQUEST,
        environment: { ...REQUEST.environment, [name]: "hostile" },
      });
      expect(result).not.toBeInstanceOf(Uint8Array);
      if (result instanceof Uint8Array) throw new Error("hostile environment was admitted");
      expect(result.code).toBe("PROCESS_BOUNDARY_ENVIRONMENT_REJECTED");
    },
  );

  it.each([
    ["non-UUID instance", { ...REQUEST, instanceId: "alpha" }],
    ["caller-injected instance environment", {
      ...REQUEST,
      environment: { ...REQUEST.environment, MOE_PROJECT_INSTANCE_ID: REQUEST.instanceId },
    }],
    ["caller-injected store", {
      ...REQUEST,
      environment: { ...REQUEST.environment, MOE_STORE_PATH: "C:\\Other\\store.sqlite" },
    }],
  ])("refuses %s before launch", (_name, request) => {
    const result = encodeProjectStackLaunchPayload(request);
    expect(result).not.toBeInstanceOf(Uint8Array);
    if (result instanceof Uint8Array) throw new Error("invalid instance binding was admitted");
    expect(result.code).toBe(_name === "non-UUID instance"
      ? "PROCESS_BOUNDARY_REQUEST_MALFORMED"
      : "PROCESS_BOUNDARY_ENVIRONMENT_REJECTED");
  });

  it.each([
    ["relative", "store.sqlite"],
    ["UNC", "\\\\server\\share\\store.sqlite"],
    ["device namespace", "\\\\?\\C:\\Work\\alpha\\store.sqlite"],
    ["DOS device", "C:\\Work\\NUL.sqlite"],
  ])("refuses a %s store path before the broker exists", (_name, storePath) => {
    const result = encodeProjectStackLaunchPayload({ ...REQUEST, storePath });
    expect(result).not.toBeInstanceOf(Uint8Array);
    if (result instanceof Uint8Array) throw new Error("hostile store path was admitted");
    expect(result.code).toBe("PROCESS_BOUNDARY_ARGV_REJECTED");
    expect(result.layer).toBe("WINDOWS_PROCESS_REQUEST");
    expect(result.message).not.toContain(storePath);
  });

  it("refuses a store path whose adjacent lock name would exceed classic MAX_PATH", () => {
    const storePath = `C:\\${"a".repeat(242)}`;
    expect(storePath.length).toBe(245);
    const result = encodeProjectStackLaunchPayload({ ...REQUEST, storePath });
    expect(result).not.toBeInstanceOf(Uint8Array);
    if (result instanceof Uint8Array) throw new Error("oversized lock path was admitted");
    expect(result.code).toBe("PROCESS_BOUNDARY_ARGV_REJECTED");
  });

  it("refuses a foreign entry even when every path is otherwise local and absolute", () => {
    const result = encodeProjectStackLaunchPayload({
      ...REQUEST, entryPath: "C:\\Moe\\apps\\daemon\\src\\daemon-main.ts",
    });
    expect(result).not.toBeInstanceOf(Uint8Array);
    if (result instanceof Uint8Array) throw new Error("foreign entry was admitted");
    expect(result.code).toBe("PROCESS_BOUNDARY_ARGV_REJECTED");
  });

  it("refuses a foreign executable instead of exposing an arbitrary process boundary", () => {
    const result = encodeProjectStackLaunchPayload({
      ...REQUEST, nodeExecutable: "C:\\Windows\\System32\\cmd.exe",
    });
    expect(result).not.toBeInstanceOf(Uint8Array);
    if (result instanceof Uint8Array) throw new Error("foreign executable was admitted");
    expect(result.code).toBe("PROCESS_BOUNDARY_EXECUTABLE_REJECTED");
  });
});
