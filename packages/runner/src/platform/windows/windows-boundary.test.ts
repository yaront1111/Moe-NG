import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";

import { openWindowsProcessBoundary, type WindowsBoundaryDeps } from "./windows-boundary.js";
import { resolveBrokerBinary } from "./windows-broker-path.js";
import { drainBrokerDiagnostics, type BrokerPipes } from "./windows-broker-process.js";
import { encodeFrame, FRAME_HEADER_BYTES } from "./windows-frames.js";
import {
  type WindowsProcessOutcome,
  type WindowsProcessUnknown,
} from "./windows-process-contract.js";

const GOOD = {
  executable: "C:\\Windows\\System32\\PING.EXE",
  argv: ["-n", "1"],
  cwd: "C:\\Windows\\Temp",
  environment: {},
};

const HOSTILE_WINDOWS_COMPONENTS: readonly (readonly [string, string])[] = Object.freeze([
  ...["<", ">", '"', "|", "?", "*"].map(
    (character) => [`invalid-${character.charCodeAt(0)}`, `bad${character}name.exe`] as const,
  ),
  ...Array.from({ length: 31 }, (_, index) => [
    `control-${String(index + 1).padStart(2, "0")}`,
    `bad${String.fromCharCode(index + 1)}name.exe`,
  ] as const),
  ["console-input-device", "CONIN$"],
  ["console-output-device", "CONOUT$"],
]);

// ---------------------------------------------------------------------------
// A scripted broker. Every call it receives is recorded, so a test can prove
// what was NOT done — which is the only way to assert "no process was created".
// ---------------------------------------------------------------------------

interface Recorder {
  readonly calls: string[];
  /** The CONTROL frames as written, so an arm can read what was actually encoded. */
  readonly controlFrames: Uint8Array[];
  readonly deps: WindowsBoundaryDeps;
  readonly providerStdout: PassThrough;
  emitStatus(bytes: Uint8Array): void;
  exit(code: number | null, signal?: string | null): void;
  fail(error: Error): void;
}

const recorder = (options: {
  platform?: string;
  broker?: string | WindowsProcessUnknown;
  writeFailure?: Error;
} = {}) => {
  const calls: string[] = [];
  const controlFrames: Uint8Array[] = [];
  let onStatus: ((chunk: Uint8Array) => void) | null = null;
  let onExit: ((code: number | null, signal: string | null) => void) | null = null;
  let onError: ((error: Error) => void) | null = null;
  const providerStdin = new PassThrough();
  const providerStdout = new PassThrough();
  const providerStderr = new PassThrough();

  const pipes: BrokerPipes = {
    pid: 4242,
    providerStdin,
    providerStdout,
    providerStderr,
    writeControl(bytes) {
      if (options.writeFailure !== undefined) throw options.writeFailure;
      controlFrames.push(Uint8Array.from(bytes));
      calls.push(`writeControl:${bytes.length}`);
    },
    endControl() {
      calls.push("endControl");
    },
    closeProviderChannels() {
      calls.push("closeProviderChannels");
      providerStdin.end();
      providerStdout.destroy();
      providerStderr.destroy();
    },
    onStatus(listener) {
      onStatus = listener;
    },
    onExit(listener) {
      onExit = listener;
    },
    onError(listener) {
      onError = listener;
    },
    kill() {
      calls.push("kill");
    },
    dispose() {
      calls.push("dispose");
      providerStdin.destroy();
      providerStdout.destroy();
      providerStderr.destroy();
    },
  };

  const state: Recorder = {
    calls,
    controlFrames,
    providerStdout,
    deps: {
      platform: options.platform ?? "win32",
      resolveBroker: () => {
        calls.push("resolveBroker");
        return options.broker ?? "C:\\broker\\moe-windows-job-broker.exe";
      },
      spawn: (executable: string) => {
        calls.push(`spawn:${executable}`);
        return pipes;
      },
    },
    emitStatus(bytes) {
      onStatus?.(bytes);
    },
    exit(code, signal = null) {
      onExit?.(code, signal);
    },
    fail(error) {
      onError?.(error);
    },
  };
  return state;
};

const frame = (opcode: number, payload: readonly number[]): Uint8Array => {
  const encoded = encodeFrame("STATUS", opcode, Uint8Array.from(payload));
  if (!(encoded instanceof Uint8Array)) throw new Error("the fixture frame did not encode");
  return encoded;
};

const u32 = (value: number): readonly number[] => [
  value & 0xff,
  (value >>> 8) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 24) & 0xff,
];

const u64 = (value: bigint): readonly number[] =>
  Array.from({ length: 8 }, (_, index) => Number((value >> BigInt(index * 8)) & 0xffn));

const CREATION_TIME = 134309515541692727n;
const started = (pid = 4242, creationTime = CREATION_TIME): Uint8Array =>
  frame(1, [...u32(pid), ...u64(creationTime)]);
const completedExited = (code: number): Uint8Array => frame(2, [1, ...u32(code)]);
const completedUnknown = (reason: number): Uint8Array => frame(2, [2, ...u32(reason)]);
const refused = (layer: number, reason: number, code: number): Uint8Array =>
  frame(3, [layer, reason & 0xff, (reason >>> 8) & 0xff, ...u32(code)]);

const unknownOf = (value: unknown): WindowsProcessUnknown => {
  const outcome = value as WindowsProcessOutcome;
  if (outcome.truthClass !== "UNKNOWN") throw new Error("expected an UNKNOWN outcome");
  return outcome;
};

// ---------------------------------------------------------------------------

describe("the gates run in order, and each proves what it did NOT reach", () => {
  it("refuses a non-Windows platform with zero resolution and zero process calls", () => {
    const fake = recorder({ platform: "linux" });
    const failure = unknownOf(openWindowsProcessBoundary(GOOD, { deps: fake.deps }));
    expect(failure.code).toBe("PROCESS_BOUNDARY_PLATFORM_UNSUPPORTED");
    expect(failure.layer).toBe("WINDOWS_PROCESS_REQUEST");
    // The EMPTY log is the assertion. A source read could not prove this.
    expect(fake.calls).toEqual([]);
  });

  it("refuses a malformed request before the broker is even located", () => {
    const fake = recorder();
    const failure = unknownOf(
      openWindowsProcessBoundary({ ...GOOD, executable: "\\\\server\\share\\x.exe" }, {
        deps: fake.deps,
      }),
    );
    expect(failure.code).toBe("PROCESS_BOUNDARY_EXECUTABLE_REJECTED");
    expect(failure.layer).toBe("WINDOWS_PROCESS_REQUEST");
    expect(fake.calls).toEqual([]);
  });

  it("refuses an argv array whose iterator disagrees with its validated entries", () => {
    const fake = recorder();
    const argv = ["safe"];
    Object.defineProperty(argv, Symbol.iterator, {
      value: function* hostileIterator() {
        yield "bad\u0000argument";
      },
    });
    const failure = unknownOf(openWindowsProcessBoundary(
      { ...GOOD, argv },
      { deps: fake.deps },
    ));
    expect(failure.code).toBe("PROCESS_BOUNDARY_ARGV_REJECTED");
    expect(failure.layer).toBe("WINDOWS_PROCESS_REQUEST");
    expect(fake.calls).toEqual([]);
  });

  it.each(HOSTILE_WINDOWS_COMPONENTS)(
    "refuses hostile Windows component %s in both path positions before resolution",
    (_, component) => {
      for (const field of ["executable", "cwd"] as const) {
        const fake = recorder();
        const failure = unknownOf(openWindowsProcessBoundary(
          { ...GOOD, [field]: `C:\\Windows\\${component}` },
          { deps: fake.deps },
        ));
        expect(failure.code).toBe(
          field === "executable"
            ? "PROCESS_BOUNDARY_EXECUTABLE_REJECTED"
            : "PROCESS_BOUNDARY_CWD_REJECTED",
        );
        expect(failure.layer).toBe("WINDOWS_PROCESS_REQUEST");
        expect(fake.calls).toEqual([]);
      }
    },
  );

  it("generates every invalid Win32 character, control, and console device case", () => {
    expect(HOSTILE_WINDOWS_COMPONENTS.length).toBe(39);
  });

  it("refuses a hostile request proxy before resolution instead of throwing", () => {
    const fake = recorder();
    const hostile = new Proxy(GOOD, {
      ownKeys: () => { throw new Error("hostile ownKeys"); },
    });
    const failure = unknownOf(openWindowsProcessBoundary(hostile, { deps: fake.deps }));
    expect(failure.code).toBe("PROCESS_BOUNDARY_REQUEST_MALFORMED");
    expect(failure.layer).toBe("WINDOWS_PROCESS_REQUEST");
    expect(fake.calls).toEqual([]);
  });

  it("pins an environment proxy refusal to the environment arm before resolution", () => {
    const fake = recorder();
    const environment = new Proxy({}, {
      ownKeys: () => { throw new Error("hostile ownKeys"); },
    });
    const failure = unknownOf(openWindowsProcessBoundary(
      { ...GOOD, environment },
      { deps: fake.deps },
    ));
    expect(failure.code).toBe("PROCESS_BOUNDARY_ENVIRONMENT_REJECTED");
    expect(failure.layer).toBe("WINDOWS_PROCESS_REQUEST");
    expect(fake.calls).toEqual([]);
  });

  it("refuses an unresolvable broker without spawning anything", () => {
    const unresolved = unknownOf(
      openWindowsProcessBoundary(GOOD, {
        deps: recorder({
          broker: unknownOf(
            openWindowsProcessBoundary(GOOD, { deps: recorder({ platform: "linux" }).deps }),
          ),
        }).deps,
      }),
    );
    // The injected resolution failure is returned verbatim, not reclassified.
    expect(unresolved.code).toBe("PROCESS_BOUNDARY_PLATFORM_UNSUPPORTED");
  });

  it("stops at resolution when the broker binary is missing, and never spawns", () => {
    const fake = recorder();
    const missing: WindowsProcessUnknown = {
      truthClass: "UNKNOWN",
      code: "PROCESS_BOUNDARY_BROKER_UNRESOLVED",
      layer: "WINDOWS_PROCESS_RESOLUTION",
      message: "absent",
      identity: null,
      brokerReason: null,
    };
    const deps = { ...fake.deps, resolveBroker: () => {
      fake.calls.push("resolveBroker");
      return missing;
    } };
    const failure = unknownOf(openWindowsProcessBoundary(GOOD, { deps }));
    expect(failure.code).toBe("PROCESS_BOUNDARY_BROKER_UNRESOLVED");
    expect(failure.layer).toBe("WINDOWS_PROCESS_RESOLUTION");
    expect(fake.calls).toEqual(["resolveBroker"]);
    // NEVER a shell or taskkill fallback: an unresolvable broker FAILS.
    expect(fake.calls.some((call) => call.startsWith("spawn"))).toBe(false);
  });

  it("returns an immutable resolution-layer UNKNOWN when process creation throws", () => {
    const fake = recorder();
    const deps: WindowsBoundaryDeps = {
      ...fake.deps,
      spawn: (executable) => {
        fake.calls.push(`spawn:${executable}`);
        throw new Error("synthetic create failure");
      },
    };
    const failure = unknownOf(openWindowsProcessBoundary(GOOD, { deps }));
    expect(failure.code).toBe("PROCESS_BOUNDARY_BROKER_SPAWN_FAILED");
    expect(failure.layer).toBe("WINDOWS_PROCESS_RESOLUTION");
    expect(Object.isFrozen(failure)).toBe(true);
    expect(fake.calls).toEqual([
      "resolveBroker",
      "spawn:C:\\broker\\moe-windows-job-broker.exe",
    ]);
  });
});

describe("a launched run is driven to a terminal outcome", () => {
  const open = (fake: Recorder) => {
    const boundary = openWindowsProcessBoundary(GOOD, { deps: fake.deps });
    if (!("completed" in boundary)) throw new Error(`the boundary refused: ${boundary.code}`);
    return boundary;
  };

  it("resolves the started identity and then a proven exit", async () => {
    const fake = recorder();
    const boundary = open(fake);
    expect(fake.calls[0]).toBe("resolveBroker");
    expect(fake.calls[1]).toBe("spawn:C:\\broker\\moe-windows-job-broker.exe");
    expect(fake.calls[2]?.startsWith("writeControl:")).toBe(true);

    fake.emitStatus(started());
    await expect(boundary.started).resolves.toEqual({ pid: 4242, creationTime: CREATION_TIME });

    fake.emitStatus(completedExited(0));
    fake.exit(0);
    const outcome = await boundary.completed;
    expect(outcome.truthClass).toBe("PROVEN");
    if (outcome.truthClass !== "PROVEN") return;
    expect(outcome.exitCode).toBe(0);
    expect(outcome.identity).toEqual({ pid: 4242, creationTime: CREATION_TIME });
    expect(fake.calls).toContain("dispose");
  });

  it("does not report completion until the broker process has exited", async () => {
    const fake = recorder();
    const boundary = open(fake);
    let completed = false;
    const outcome = boundary.completed.then((value) => {
      completed = true;
      return value;
    });

    fake.emitStatus(started());
    fake.emitStatus(completedExited(0));
    await Promise.resolve();
    expect(completed).toBe(false);

    fake.exit(0);
    await expect(outcome).resolves.toMatchObject({ truthClass: "PROVEN", exitCode: 0 });
  });

  it("keeps provider output readable until the broker closes after natural completion", async () => {
    const fake = recorder();
    const boundary = open(fake);
    fake.emitStatus(started());
    fake.emitStatus(completedExited(0));
    const closing = boundary.close();
    expect(fake.providerStdout.destroyed).toBe(false);
    fake.exit(0);
    await closing;
    expect(fake.providerStdout.destroyed).toBe(true);
  });

  it("keeps the identity but refuses to prove an exit the broker could not observe", async () => {
    const fake = recorder();
    const boundary = open(fake);
    fake.emitStatus(started());
    fake.emitStatus(completedUnknown(2));
    fake.exit(0);
    const failure = unknownOf(await boundary.completed);
    expect(failure.code).toBe("PROCESS_BOUNDARY_EXIT_UNOBSERVED");
    expect(failure.layer).toBe("WINDOWS_PROCESS_TRANSPORT");
    expect(failure.identity).toEqual({ pid: 4242, creationTime: CREATION_TIME });
  });

  // main.rs exits EXIT_UNOBSERVED (21) for a run whose end it could not
  // observe. When that exit reaches Node with no COMPLETED frame, the code is
  // the only evidence, and it must not collapse into "the broker exited".
  it("reads a frameless exit 21 after a started frame as the exact unobserved exit", async () => {
    const fake = recorder();
    const boundary = open(fake);
    fake.emitStatus(started());
    await boundary.started;
    fake.exit(21);
    const failure = unknownOf(await boundary.completed);
    expect(failure.code).toBe("PROCESS_BOUNDARY_EXIT_UNOBSERVED");
    expect(failure.layer).toBe("WINDOWS_PROCESS_TRANSPORT");
    expect(failure.identity).toEqual({ pid: 4242, creationTime: CREATION_TIME });
    expect(failure.brokerReason).toBeNull();
  });

  it("keeps a frameless exit 21 with no started frame as a plain broker exit", async () => {
    const fake = recorder();
    const boundary = open(fake);
    fake.exit(21);
    const failure = unknownOf(await boundary.completed);
    expect(failure.code).toBe("PROCESS_BOUNDARY_BROKER_EXITED");
    expect(failure.identity).toBeNull();
    expect(failure.message).toContain("exit 21");
  });

  // A descriptor refusal exits REFUSAL_BASE + ordinal BEFORE fd1 can carry a
  // frame, so the exit code is its only wire. Ordinal 2 is CountExceedsBlock.
  it("reads a frameless exit 12 with no frames as a BROKER_DESCRIPTOR refusal, reason 2", async () => {
    const fake = recorder();
    const boundary = open(fake);
    fake.exit(12);
    const failure = unknownOf(await boundary.completed);
    expect(failure.code).toBe("PROCESS_BOUNDARY_BROKER_REFUSED");
    expect(failure.layer).toBe("BROKER_DESCRIPTOR");
    expect(failure.identity).toBeNull();
    expect(failure.brokerReason).toEqual({ layer: "BROKER_DESCRIPTOR", reason: 2, code: 0 });
    expect(Object.isFrozen(failure.brokerReason)).toBe(true);
    expect(unknownOf(await boundary.started).code).toBe("PROCESS_BOUNDARY_BROKER_REFUSED");
  });

  // main.rs closes its descriptors LAST and exits the close's refusal code even
  // after a COMPLETED frame on a READY run. The frame is the proof; the code
  // that follows it must never rewrite that proof.
  it("never lets a descriptor exit code override a received completed frame", async () => {
    const fake = recorder();
    const boundary = open(fake);
    fake.emitStatus(started());
    fake.emitStatus(completedExited(0));
    fake.exit(12);
    const outcome = await boundary.completed;
    expect(outcome.truthClass).toBe("PROVEN");
    if (outcome.truthClass !== "PROVEN") return;
    expect(outcome.exitCode).toBe(0);
  });

  it("keeps a descriptor-band exit after a started frame as a plain broker exit", async () => {
    const fake = recorder();
    const boundary = open(fake);
    fake.emitStatus(started());
    fake.exit(12);
    const failure = unknownOf(await boundary.completed);
    expect(failure.code).toBe("PROCESS_BOUNDARY_BROKER_EXITED");
    expect(failure.identity).toEqual({ pid: 4242, creationTime: CREATION_TIME });
    expect(failure.brokerReason).toBeNull();
  });

  // EXIT_LAUNCH_REFUSED (20) says only that nothing ran; the reason travelled
  // as a REFUSED frame, and without one the code is not a descriptor ordinal.
  it.each([
    [20, null, "exit 20, signal none"],
    [null, "SIGTERM", "exit none, signal SIGTERM"],
  ])("names exit %s and signal %s in a plain broker exit", async (code, signal, expected) => {
    const fake = recorder();
    const boundary = open(fake);
    fake.exit(code, signal);
    const failure = unknownOf(await boundary.completed);
    expect(failure.code).toBe("PROCESS_BOUNDARY_BROKER_EXITED");
    expect(failure.layer).toBe("WINDOWS_PROCESS_TRANSPORT");
    expect(failure.brokerReason).toBeNull();
    expect(failure.message).toContain(expected);
  });

  it("carries a native refusal's layer and its layer-local ordinal across the wire", async () => {
    const fake = recorder();
    const boundary = open(fake);
    // layer 3 is RefusalLayer::Native; ordinal 10 is NativeOp::AssignProcessToJob.
    fake.emitStatus(refused(3, 10, 87));
    fake.exit(1);
    const failure = unknownOf(await boundary.completed);
    expect(failure.code).toBe("PROCESS_BOUNDARY_BROKER_REFUSED");
    expect(failure.layer).toBe("BROKER_NATIVE");
    expect(failure.brokerReason).toEqual({ layer: "BROKER_NATIVE", reason: 10, code: 87 });
  });

  it("turns a broker channel failure into the transport layer's exact UNKNOWN", async () => {
    const fake = recorder();
    const boundary = open(fake);
    fake.fail(new Error("synthetic pipe failure"));
    fake.exit(1);
    const failure = unknownOf(await boundary.completed);
    expect(failure.code).toBe("PROCESS_BOUNDARY_CHANNEL_FAILED");
    expect(failure.layer).toBe("WINDOWS_PROCESS_TRANSPORT");
    expect(Object.isFrozen(failure)).toBe(true);
  });

  it("keeps a synchronous control-write failure awaitable and closes the spawned broker", async () => {
    const fake = recorder({ writeFailure: new Error("synthetic write failure") });
    const opened = openWindowsProcessBoundary(GOOD, { deps: fake.deps });
    expect("completed" in opened).toBe(true);
    if (!("completed" in opened)) return;
    fake.exit(1);
    const failure = unknownOf(await opened.completed);
    expect(failure.code).toBe("PROCESS_BOUNDARY_CHANNEL_FAILED");
    expect(failure.layer).toBe("WINDOWS_PROCESS_TRANSPORT");
    expect(fake.calls).toContain("endControl");
    expect(fake.calls).toContain("closeProviderChannels");
    expect(fake.calls).toContain("dispose");
  });

  it("reads a status frame split across chunk boundaries", async () => {
    const fake = recorder();
    const boundary = open(fake);
    for (const byte of started()) {
      fake.emitStatus(Uint8Array.of(byte));
    }
    await expect(boundary.started).resolves.toEqual({ pid: 4242, creationTime: CREATION_TIME });
  });

  it("refuses an unusable started identity instead of publishing it", async () => {
    const fake = recorder();
    const boundary = open(fake);
    fake.emitStatus(started(0, 0n));
    fake.exit(1);

    const failure = unknownOf(await boundary.started);
    expect(failure.code).toBe("PROCESS_BOUNDARY_IDENTITY_UNPROVEN");
    expect(failure.layer).toBe("WINDOWS_PROCESS_TRANSPORT");
    expect(unknownOf(await boundary.completed).code).toBe(
      "PROCESS_BOUNDARY_IDENTITY_UNPROVEN",
    );
  });

  it("cancels by closing the control channel, which the broker reads as CANCEL", async () => {
    const fake = recorder();
    const boundary = open(fake);
    fake.emitStatus(started());
    boundary.cancel();
    expect(fake.calls).toContain("endControl");
    fake.emitStatus(completedExited(1));
    fake.exit(0);
    const outcome = await boundary.completed;
    expect(outcome.truthClass).toBe("PROVEN");
  });
});

const NATIVE_OPERATIONS = Object.freeze([
  "CreateJobObject",
  "SetInformation",
  "QueryInformation",
  "TerminateJob",
  "QueryAccounting",
  "CloseHandle",
  "InitAttributeList",
  "SetJobListAttribute",
  "SetHandleListAttribute",
  "CreateProcess",
  "AssignProcessToJob",
  "IsProcessInJob",
  "QueryProcessId",
  "QueryCreationTime",
  "ResumeThread",
  "WaitForProcess",
  "QueryExitCode",
  "TerminateProcess",
  "QueryImageName",
] as const);

describe("the native refusal sweep preserves every operation ordinal", () => {
  it.each(NATIVE_OPERATIONS.map((operation, reason) => ({ operation, reason })))(
    "$operation remains an exact BROKER_NATIVE refusal",
    async ({ reason }) => {
      const fake = recorder();
      const boundary = openWindowsProcessBoundary(GOOD, { deps: fake.deps });
      if (!("completed" in boundary)) throw new Error(`unexpected refusal: ${boundary.code}`);
      fake.emitStatus(refused(3, reason, 1200 + reason));
      fake.exit(1);

      const failure = unknownOf(await boundary.completed);
      expect(failure.code).toBe("PROCESS_BOUNDARY_BROKER_REFUSED");
      expect(failure.layer).toBe("BROKER_NATIVE");
      expect(failure.brokerReason).toEqual({
        layer: "BROKER_NATIVE",
        reason,
        code: 1200 + reason,
      });
      expect(Object.isFrozen(failure)).toBe(true);
      expect(Object.isFrozen(failure.brokerReason)).toBe(true);
    },
  );

  it("generated exactly the broker core's 19 native operations", () => {
    expect(NATIVE_OPERATIONS.length).toBe(19);
    expect(NATIVE_OPERATIONS[0]).toBe("CreateJobObject");
    expect(NATIVE_OPERATIONS[18]).toBe("QueryImageName");
  });
});

describe("the same reason ordinal cannot hide which broker layer refused", () => {
  const layers = Object.freeze([
    { wire: 1, expected: "BROKER_DESCRIPTOR" },
    { wire: 2, expected: "BROKER_PROTOCOL" },
    { wire: 3, expected: "BROKER_NATIVE" },
    { wire: 4, expected: "BROKER_STORE_LOCK" },
  ] as const);

  it.each(layers)("wire layer $wire is $expected", async ({ wire, expected }) => {
    const fake = recorder();
    const boundary = openWindowsProcessBoundary(GOOD, { deps: fake.deps });
    if (!("completed" in boundary)) throw new Error(`unexpected refusal: ${boundary.code}`);
    fake.emitStatus(refused(wire, 0, 0));
    fake.exit(1);
    const failure = unknownOf(await boundary.completed);
    expect(failure.code).toBe("PROCESS_BOUNDARY_BROKER_REFUSED");
    expect(failure.layer).toBe(expected);
    expect(failure.brokerReason).toEqual({ layer: expected, reason: 0, code: 0 });
  });

  it("generated exactly one case for each closed broker refusal layer", () => {
    expect(layers.length).toBe(4);
  });
});

describe("the broker binary is resolved deterministically", () => {
  it("finds the release broker built by the pinned toolchain", () => {
    const resolved = resolveBrokerBinary();
    if (process.platform !== "win32") {
      // ABSENT BY CONSTRUCTION off Windows, and asserted rather than skipped:
      // the broker is a Windows executable produced by a Windows-targeted
      // cargo build, and `dist/` is git-ignored, so no non-Windows checkout can
      // hold one. What must still hold there is the resolver's fail-closed
      // stance -- its own typed refusal, with the exact code and layer, and
      // never a throw or a path nothing built.
      const failure = unknownOf(resolved);
      expect(failure.code).toBe("PROCESS_BOUNDARY_BROKER_UNRESOLVED");
      expect(failure.layer).toBe("WINDOWS_PROCESS_RESOLUTION");
      return;
    }
    // On Windows the broker IS built. A missing binary must FAIL rather than
    // degrade, so this asserts the resolved path and not merely "no throw".
    expect(typeof resolved).toBe("string");
    expect(String(resolved).replace(/\\/gu, "/")).toContain(
      "dist/windows-job-native/release/moe-windows-job-broker.exe",
    );
  });

  it("returns a typed UNKNOWN rather than throwing when the root has no broker", () => {
    const failure = unknownOf(resolveBrokerBinary("C:\\nonexistent-root-for-this-test"));
    expect(failure.code).toBe("PROCESS_BOUNDARY_BROKER_UNRESOLVED");
    expect(failure.layer).toBe("WINDOWS_PROCESS_RESOLUTION");
  });
});

describe("the process seam preserves provider stdio", () => {
  it("drains diagnostics but leaves all three provider channels paused", () => {
    const pipes = Array.from({ length: 6 }, () => new PassThrough());
    drainBrokerDiagnostics(pipes);
    expect(pipes[2]?.readableFlowing).toBe(true);
    expect(pipes[3]?.readableFlowing).toBeNull();
    expect(pipes[4]?.readableFlowing).toBeNull();
    expect(pipes[5]?.readableFlowing).toBeNull();
  });

  it("loads through plain Node strip-only TypeScript without spawning", () => {
    const moduleUrl = new URL("./windows-boundary.js", import.meta.url).href;
    const script = `const m=await import(${JSON.stringify(moduleUrl)}); console.log(typeof m.openWindowsProcessBoundary);`;
    const loaded = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    expect(loaded.status).toBe(0);
    expect(loaded.stderr).toBe("");
    expect(loaded.stdout.trim()).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// THE HOST SYSTEM ROOT.
//
// Measured on task-d8650fec against the installed Claude 2.1.251 runtime: the
// daemon's launch template carries EXACTLY the provider's two selection
// variables, the broker replaces the child's environment with the encoded pairs
// alone, and Claude's Bun runtime then refuses to start — the decisive stderr
// line is `error: Bun requires the SystemRoot environment variable to be set`
// — so the physical process exits 1 while every gate above it reported success.
// No flag or value was rejected: `--model claude-opus-5` and `--effort high`
// were accepted.
//
// `SystemRoot` is therefore a HOST fact, not caller data. It is read from the
// host environment the caller hands in through the internal `hostEnvironment`
// option, judged before the request is encoded, and injected under the
// UNCHANGED allowlist. A caller that spells it itself is refused rather than
// trusted, overwritten or duplicated.
// ---------------------------------------------------------------------------

/** The daemon launch-template producer's environment, spelled as it produces it. */
const PRODUCER_ENVIRONMENT = Object.freeze({
  ANTHROPIC_MODEL: "claude-opus-5",
  CLAUDE_CODE_EFFORT_LEVEL: "high",
});

interface DecodedLaunch {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environment: readonly (readonly [string, string])[];
}

/**
 * Reads back what was WRITTEN, rather than re-encoding what was expected: a
 * fixture that re-ran the encoder would be a fixed point and could not see a
 * value the encoder itself dropped or rewrote.
 */
function decodeControlLaunch(frameBytes: Uint8Array): DecodedLaunch {
  const view = frameBytes.subarray(FRAME_HEADER_BYTES);
  const decoder = new TextDecoder();
  let offset = 0;
  const u16 = (): number => {
    const value = (view[offset] ?? 0) | ((view[offset + 1] ?? 0) << 8);
    offset += 2;
    return value;
  };
  const str = (): string => {
    const length = u16();
    const text = decoder.decode(view.subarray(offset, offset + length));
    offset += length;
    return text;
  };
  const executable = str();
  const argv = Array.from({ length: u16() }, () => str());
  const cwd = str();
  const environment = Array.from({ length: u16() }, () => [str(), str()] as const);
  if (offset !== view.length) throw new Error("the control payload was not consumed exactly");
  return { argv, cwd, environment, executable };
}

/** Every host-environment shape that cannot yield exactly one usable SystemRoot. */
const UNUSABLE_HOST_ROOTS: readonly (readonly [string, () => unknown])[] = Object.freeze([
  ["absent", () => ({ ComSpec: "C:\\Windows\\System32\\cmd.exe" })],
  ["ambiguous-case", () => ({ SystemRoot: "C:\\Windows", SYSTEMROOT: "C:\\Windows" })],
  ["ambiguous-case-divergent", () => ({ SystemRoot: "C:\\Windows", systemroot: "C:\\WinNT" })],
  ["accessor", () => {
    const host: Record<string, unknown> = {};
    Object.defineProperty(host, "SystemRoot", { enumerable: true, get: () => "C:\\Windows" });
    return host;
  }],
  ["hostile-proxy", () => new Proxy({ SystemRoot: "C:\\Windows" }, {
    ownKeys: () => { throw new Error("hostile ownKeys"); },
  })],
  ["empty", () => ({ SystemRoot: "" })],
  // THE DIVERGENCE FIXTURE. Every other request field is valid and every later
  // port accepts, so `Windows` is refused by the local-absolute-path guard
  // ALONE: it is bounded, NUL-free, equals-free text that the encoder and the
  // allowlist both accept, so no downstream fence can answer this code at this
  // layer in its place. Loosen that one guard and this arm opens.
  ["relative", () => ({ SystemRoot: "Windows" })],
  ["relative-rooted", () => ({ SystemRoot: "\\Windows" })],
  ["traversal", () => ({ SystemRoot: "C:\\Windows\\..\\Users" })],
  ["not-a-record", () => "C:\\Windows"],
  ["null", () => null],
  ["array", () => ["C:\\Windows"]],
  ["non-text", () => ({ SystemRoot: 42 })],
]);

describe("the host SystemRoot is injected as a host fact, never taken from the caller", () => {
  it("encodes exactly the producer's two selection pairs plus the canonical SystemRoot", async () => {
    const fake = recorder();
    const request = { ...GOOD, environment: { ...PRODUCER_ENVIRONMENT } };
    const boundary = openWindowsProcessBoundary(request, {
      deps: fake.deps,
      hostEnvironment: {
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
        MOE_BOOTSTRAP_CREDENTIAL: "must-not-travel",
        Path: "C:\\Windows\\System32",
        SystemRoot: "C:\\Windows",
        TEMP: "C:\\Users\\someone\\AppData\\Local\\Temp",
        USERPROFILE: "C:\\Users\\someone",
      },
    });
    if (!("completed" in boundary)) throw new Error(`the boundary refused: ${boundary.code}`);

    const frame = fake.controlFrames[0];
    if (frame === undefined) throw new Error("no control frame was written");
    const decoded = decodeControlLaunch(frame);
    // EXACTLY these three, in this order: the caller's two, then the host fact.
    expect(decoded.environment.map(([name, value]) => `${name}=${value}`)).toEqual([
      "ANTHROPIC_MODEL=claude-opus-5",
      "CLAUDE_CODE_EFFORT_LEVEL=high",
      "SystemRoot=C:\\Windows",
    ]);
    // Nothing else the host happened to be carrying travelled with it.
    for (const forbidden of ["PATH", "TEMP", "COMSPEC", "USERPROFILE", "MOE_BOOTSTRAP_CREDENTIAL"]) {
      expect(decoded.environment.some(([name]) => name.toUpperCase() === forbidden)).toBe(false);
    }
    expect(decoded.executable).toBe(GOOD.executable);
    expect(decoded.argv).toEqual([...GOOD.argv]);
    expect(decoded.cwd).toBe(GOOD.cwd);
    // The caller's own record was never mutated on its way through.
    expect(request.environment).toEqual({ ...PRODUCER_ENVIRONMENT });

    fake.emitStatus(started());
    fake.emitStatus(completedExited(0));
    fake.exit(0);
    await expect(boundary.completed).resolves.toMatchObject({ truthClass: "PROVEN" });
  });

  it("generates every unusable host-root shape", () => {
    expect(UNUSABLE_HOST_ROOTS.length).toBe(13);
    expect(UNUSABLE_HOST_ROOTS.length).toBeGreaterThan(0);
    expect(new Set(UNUSABLE_HOST_ROOTS.map(([name]) => name)).size)
      .toBe(UNUSABLE_HOST_ROOTS.length);
  });

  it.each(UNUSABLE_HOST_ROOTS)(
    "refuses the %s host root at the environment gate, before resolution or spawn",
    (_name, build) => {
      const fake = recorder();
      const failure = unknownOf(openWindowsProcessBoundary(
        { ...GOOD, environment: { ...PRODUCER_ENVIRONMENT } },
        { deps: fake.deps, hostEnvironment: build() },
      ));
      expect(failure.code).toBe("PROCESS_BOUNDARY_ENVIRONMENT_REJECTED");
      expect(failure.layer).toBe("WINDOWS_PROCESS_REQUEST");
      // The EMPTY log is the assertion: no broker was located and none was spawned.
      expect(fake.calls).toEqual([]);
      expect(fake.controlFrames).toEqual([]);
    },
  );

  it("refuses a caller that spells SystemRoot itself, in any case, rather than trusting it", () => {
    for (const spelling of ["SystemRoot", "SYSTEMROOT", "systemroot"]) {
      const fake = recorder();
      const failure = unknownOf(openWindowsProcessBoundary(
        { ...GOOD, environment: { ...PRODUCER_ENVIRONMENT, [spelling]: "C:\\Windows" } },
        { deps: fake.deps, hostEnvironment: { SystemRoot: "C:\\Windows" } },
      ));
      expect(failure.code).toBe("PROCESS_BOUNDARY_ENVIRONMENT_REJECTED");
      expect(failure.layer).toBe("WINDOWS_PROCESS_REQUEST");
      expect(fake.calls).toEqual([]);
      expect(fake.controlFrames).toEqual([]);
    }
  });

  it("leaves the raw boundary untouched when no host environment is supplied", async () => {
    const fake = recorder();
    const boundary = openWindowsProcessBoundary(
      { ...GOOD, environment: { ...PRODUCER_ENVIRONMENT } },
      { deps: fake.deps },
    );
    if (!("completed" in boundary)) throw new Error(`the boundary refused: ${boundary.code}`);
    const frame = fake.controlFrames[0];
    if (frame === undefined) throw new Error("no control frame was written");
    // No SystemRoot: a direct caller (claude-host-runtime, the security lane)
    // does not silently gain a second injection.
    expect(decodeControlLaunch(frame).environment.map(([name]) => name)).toEqual([
      "ANTHROPIC_MODEL", "CLAUDE_CODE_EFFORT_LEVEL",
    ]);

    fake.emitStatus(started());
    fake.emitStatus(completedExited(0));
    fake.exit(0);
    await expect(boundary.completed).resolves.toMatchObject({ truthClass: "PROVEN" });
  });
});
