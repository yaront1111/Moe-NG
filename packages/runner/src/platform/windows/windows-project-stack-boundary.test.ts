import { describe, expect, it, vi } from "vitest";

// Simulate the ubuntu/macos gate: native basename is POSIX there, while the
// Windows-shaped request must still be interpreted identically on every host.
vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return { ...actual, basename: actual.posix.basename };
});

import { PassThrough } from "node:stream";

import { ALLOWED_ENVIRONMENT_KEYS, encodeLaunchPayload } from "./windows-launch-request.js";
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

const FOUNDATION_SEAL_ENVIRONMENT = Object.freeze({
  MOE_FOUNDATION_WORKSPACE_CATALOG: "workspace-catalog-fixture",
  MOE_PROJECT_CONFIGURATION_DIGEST: "a".repeat(64),
  MOE_VERIFICATION_CATALOG: "verification-catalog-fixture",
});
const RUNTIME_PIN_ENVIRONMENT = Object.freeze({ MOE_RUNTIME_PIN_ROOT: "C:\\Moe\\runtime-pin" });

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

  it("launches the stack entry under plain node: the decoded argv, by value, carries no flag", () => {
    // Plain strip-only node loads this entry (project-stack-host-main.test.ts proves it), so a
    // transform flag regrown ahead of it would only mask what that arm guards.
    const encoded = encodeProjectStackLaunchPayload(REQUEST);
    if (!(encoded instanceof Uint8Array)) throw new Error(`launch refused: ${encoded.code}`);
    const bytes: Uint8Array = encoded;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;
    const count = (): number => { const value = view.getUint16(offset, true); offset += 2; return value; };
    const text = (): string => {
      const length = count();
      const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset, offset + length));
      offset += length;
      return value;
    };
    expect(text()).toBe(REQUEST.storePath);
    expect(text()).toBe(REQUEST.nodeExecutable);
    expect(Array.from({ length: count() }, text)).toEqual([
      REQUEST.entryPath, `--config=${REQUEST.configPath}`, `--asset-root=${REQUEST.assetRoot}`,
    ]);
    expect(text()).toBe(REQUEST.cwd);
    for (let fields = count() * 2; fields > 0; fields -= 1) text();
    // Every byte accounted for, so the argv above was read on the record's own boundaries.
    expect(offset).toBe(bytes.length);
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

  it("carries the Foundation daemon inputs without widening provider launch", () => {
    const environment = {
      ...REQUEST.environment, ...FOUNDATION_SEAL_ENVIRONMENT, ...RUNTIME_PIN_ENVIRONMENT,
    };
    const encoded = encodeProjectStackLaunchPayload({ ...REQUEST, environment });
    expect(encoded).toBeInstanceOf(Uint8Array);
    const payload = new TextDecoder().decode(encoded as Uint8Array);
    expect(payload).toContain(REQUEST.instanceId);
    expect(payload).toContain(REQUEST.storePath);
    const sealEntries = Object.entries(FOUNDATION_SEAL_ENVIRONMENT);
    expect(sealEntries).toHaveLength(3);
    const daemonEntries = [...sealEntries, ...Object.entries(RUNTIME_PIN_ENVIRONMENT)];
    for (const [name] of daemonEntries) {
      expect(payload).toContain(name);
    }

    for (const [name, value] of daemonEntries) {
      const provider = encodeLaunchPayload({
        argv: [], cwd: REQUEST.cwd,
        environment: { SYSTEMROOT: REQUEST.environment.SYSTEMROOT, [name]: value },
        executable: REQUEST.nodeExecutable,
      });
      expect(provider).not.toBeInstanceOf(Uint8Array);
      if (provider instanceof Uint8Array) throw new Error(`provider launch widened for ${name}`);
      expect(provider.code).toBe("PROCESS_BOUNDARY_ENVIRONMENT_REJECTED");
      expect(provider.layer).toBe("WINDOWS_PROCESS_REQUEST");
    }
  });

  it("carries compiled-node host settings without widening provider launch", () => {
    const settings = {
      MOE_NODE_WORKSPACE: "C:\\Work\\alpha",
      MOE_NODE_TEST_COMMAND: "pnpm run verify:project",
    };
    const encoded = encodeProjectStackLaunchPayload({
      ...REQUEST, environment: { ...REQUEST.environment, ...settings },
    });
    expect(encoded).toBeInstanceOf(Uint8Array);
    const payload = new TextDecoder().decode(encoded as Uint8Array);
    for (const [name, value] of Object.entries(settings)) {
      expect(payload).toContain(name);
      expect(payload).toContain(value);
      const provider = encodeLaunchPayload({
        argv: [], cwd: REQUEST.cwd, executable: REQUEST.nodeExecutable,
        environment: { SYSTEMROOT: REQUEST.environment.SYSTEMROOT, [name]: value },
      });
      expect(provider).toMatchObject({
        code: "PROCESS_BOUNDARY_ENVIRONMENT_REJECTED", layer: "WINDOWS_PROCESS_REQUEST",
      });
    }
  });

  it("carries the verifier database knobs through the launch payload — the hop that dropped them live", () => {
    // UnAI 2026-09-18: start.ps1 set all four, the CLI had them, the wrapper never did — the
    // native broker's environment is exactly this roster. A key missing here is a silent policy.
    const settings = {
      MOE_VERIFIER_DB_CA_VAR: "UNAI_DATABASE_CA_PATH",
      MOE_VERIFIER_DB_IMAGE: "pgvector/pgvector:pg17",
      MOE_VERIFIER_DB_TLS: "1",
      MOE_VERIFIER_DB_URL_VARS: "DATABASE_URL,UNAI_MIGRATION_DATABASE_URL",
    };
    const encoded = encodeProjectStackLaunchPayload({
      ...REQUEST, environment: { ...REQUEST.environment, ...settings },
    });
    expect(encoded).toBeInstanceOf(Uint8Array);
    const payload = new TextDecoder().decode(encoded as Uint8Array);
    for (const [name, value] of Object.entries(settings)) {
      expect(payload).toContain(name);
      expect(payload).toContain(value);
      // The generic provider boundary still refuses them: the roster is the ONLY way through.
      expect(encodeLaunchPayload({
        argv: [], cwd: REQUEST.cwd, executable: REQUEST.nodeExecutable,
        environment: { SYSTEMROOT: REQUEST.environment.SYSTEMROOT, [name]: value },
      })).toMatchObject({ code: "PROCESS_BOUNDARY_ENVIRONMENT_REJECTED", layer: "WINDOWS_PROCESS_REQUEST" });
    }
  });

  it("publishes a finite reviewed environment roster", () => {
    expect(PROJECT_STACK_ENVIRONMENT_KEYS).toEqual([
      ...ALLOWED_ENVIRONMENT_KEYS,
      ...PROJECT_STACK_PROVIDER_CREDENTIAL_KEYS,
      "MOE_AGENT_COMMAND", "MOE_AGENT_SILENCE_MS", "MOE_AGENT_TIMEOUT_MS", "MOE_DAEMON_CREDENTIAL",
      "MOE_FOUNDATION_WORKSPACE_CATALOG",
      // Whether the daemon may answer an exhausted review itself, and how often per node. The
      // wrapper reads both at startup, so off this roster the owner could state the policy and
      // nothing would reach the process that enforces it.
      "MOE_GOVERNANCE_MAX_DECISIONS", "MOE_GOVERNANCE_MODE",
      "MOE_NODE_SPECS_DIR", "MOE_NODE_TEST_COMMAND",
      "MOE_NODE_TREES", "MOE_NODE_WORKSPACE", "MOE_OPERATOR_CHANNEL",
      "MOE_PRINCIPAL_ID", "MOE_PROJECT_CATALOG",
      "MOE_PROJECT_CONFIGURATION_DIGEST", "MOE_PROJECT_ID", "MOE_PROJECT_INSTANCE_ID",
      "MOE_RUNTIME_PIN_ROOT", "MOE_STORE_PATH", "MOE_VERIFICATION_CATALOG",
      // The verifier's disposable database (image, URL variable names, TLS, CA variable). Read by
      // the wrapper at startup; measured off this roster on UnAI 2026-09-18 the operator's start
      // script set all four and the wrapper still provisioned plain postgres + DATABASE_URL.
      "MOE_VERIFIER_DB_CA_VAR", "MOE_VERIFIER_DB_IMAGE", "MOE_VERIFIER_DB_TLS",
      "MOE_VERIFIER_DB_URL_VARS",
      "MOE_WRAPPER_INTERVAL_MS", "MOE_WRAPPER_MAX_AGENTS", "MOE_WRAPPER_MAX_ITEM_ATTEMPTS",
      "MOE_WRAPPER_ONCE",
    ]);
    expect(PROJECT_STACK_ENVIRONMENT_KEYS).not.toContain("NODE_OPTIONS");
    expect(new Set(PROJECT_STACK_ENVIRONMENT_KEYS).size).toBe(PROJECT_STACK_ENVIRONMENT_KEYS.length);
    // CLAUDE_CONFIG_DIR is the claude sign-in's relocation directory, the exact analogue of
    // CODEX_HOME beside it: without it a relocated sign-in was refused MOE_UP_ENV_MISSING
    // and a defaulted one never reached the seats (measured 2026-09-13).
    expect(PROJECT_STACK_PROVIDER_CREDENTIAL_KEYS).toEqual([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CONFIG_DIR",
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
