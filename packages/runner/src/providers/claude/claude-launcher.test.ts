import { describe, expect, it } from "vitest";

import { openWindowsProcessBoundary } from "../../platform/windows/windows-boundary.js";
import { type WindowsProcessOutcome, type WindowsProcessUnknown } from "../../platform/windows/windows-process-contract.js";
import { intakeProcessObservation } from "../../supervisor/process-observation.js";
import { prepareClaudeRuntimePin } from "./claude-runtime-pin.js";
import {
  CLAUDE_LAUNCHER_VERSION,
  CLAUDE_LAUNCH_ERROR_CODES,
  launchClaude,
  type ClaudeLaunchRequest,
  type ClaudeLauncherDependencies,
} from "./claude-launcher.js";
import { snapshotClaudeLaunchRequest } from "./claude-launcher-input.js";
import {
  CLAIM, COMMIT, DIGEST, PROCESS, boundaryHarness, dependencies,
  failureOf, prepared, request, runtimeRequest, sha256,
} from "./claude-launcher-test-fixtures.js";
describe("Windows Claude launcher", () => {
  it("bounds the recursive plain-data authority snapshot", () => {
    const huge = Array.from({ length: 2_049 }, (_, index) => index);
    expect(snapshotClaudeLaunchRequest(request({ effect: { huge } }))).toBeNull();
    let nested: unknown = "leaf";
    for (let depth = 0; depth < 18; depth += 1) nested = { nested };
    expect(snapshotClaudeLaunchRequest(request({ effect: nested }))).toBeNull();
  });

  it("publishes a frozen version and closed local failure vocabulary", () => {
    expect(CLAUDE_LAUNCHER_VERSION).toBe("moe-claude-launcher/1");
    expect(CLAUDE_LAUNCH_ERROR_CODES).toContain("CLAUDE_LAUNCH_PLATFORM_UNSUPPORTED");
    expect(CLAUDE_LAUNCH_ERROR_CODES).toContain("CLAUDE_LAUNCH_CLEANUP_UNKNOWN");
    expect(Object.isFrozen(CLAUDE_LAUNCH_ERROR_CODES)).toBe(true);
  });

  it("refuses a non-Windows host before reading the request or calling a port", async () => {
    const result = await launchClaude({}, { platform: "linux" });
    expect(failureOf(result)).toEqual({
      code: "CLAUDE_LAUNCH_PLATFORM_UNSUPPORTED", layer: "LAUNCHER",
    });
    expect(result.truthClass).toBe("UNSUPPORTED");
  });

  it("runs the logical gates before opening and binds exact dual-stream evidence", async () => {
    const log: string[] = [];
    const boundary = boundaryHarness({ stdout: Buffer.from("alpha"), stderr: Buffer.from("beta!") });
    const result = await launchClaude(request(), { platform: "win32", deps: dependencies(boundary, log) });
    expect(log).toEqual(["runtime", "validate", "consume", "open", "register", "observe"]);
    expect(boundary.log).toEqual(["close"]);
    expect(boundary.requests).toHaveLength(1);
    expect(Object.keys(boundary.requests[0] as object).sort()).toEqual(["argv", "cwd", "environment", "executable"]);
    expect(boundary.requests[0]).toMatchObject({ argv: ["--print", "hello"], cwd: "C:\\work" });
    expect((boundary.requests[0] as Record<string, unknown>)["shell"]).toBeUndefined();
    expect(result.kind).toBe("OBSERVED");
    if (result.kind !== "OBSERVED") throw new Error("expected observation");
    expect({ truth: result.truthClass, code: result.code, layer: result.layer }).toEqual({
      truth: "PROVEN", code: null, layer: null,
    });
    expect(result.consumedGrant.state).toBe("CONSUMED");
    expect(result.observation.stdout).toMatchObject({ byteLength: 5, sha256: sha256("alpha"), truncated: false });
    expect(result.observation.stderr).toMatchObject({ byteLength: 5, sha256: sha256("beta!"), truncated: false });
    expect(Buffer.from(result.observation.stdout.tailBase64, "base64").toString()).toBe("lpha");
    expect(result.observation.exit).toEqual({ kind: "EXITED", code: 0 });
    expect(result.observation.runtimeBindingDigest).toBe(prepared.bindingDigest);
    expect(result.observation.observationDigest).toHaveLength(64);
    expect(Object.isFrozen(result.observation.stdout)).toBe(true);
    expect(Object.isFrozen(result.observation)).toBe(true);
  });

  it("snapshots mutable authority before asynchronous runtime preparation", async () => {
    const log: string[] = [];
    const boundary = boundaryHarness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const deps = { ...dependencies(boundary, log),
      prepareRuntime: async () => { log.push("runtime"); await gate; return prepared; } };
    const attempt: Record<string, unknown> = { ...COMMIT.attempt };
    const launched = launchClaude(request({ attempt }), { platform: "win32", deps });
    attempt["state"] = "LAUNCH_REQUESTED";
    release();
    const result = await launched;
    expect(result.kind).toBe("OBSERVED");
    expect(result.truthClass).toBe("PROVEN");
  });

  it("keeps exactly-N output proven in either stream completion order", async () => {
    const cases = [false, true] as const;
    expect(cases.length).toBe(2);
    for (const stderrFirst of cases) {
      const log: string[] = [];
      const boundary = boundaryHarness({ stdout: Buffer.from("12345"), stderrFirst });
      const result = await launchClaude(request({
        limits: { stdoutBytes: 5, stderrBytes: 64, tailBytes: 5, timeoutMs: 1_000 },
      }), { platform: "win32", deps: dependencies(boundary, log) });
      expect({ truth: result.truthClass, code: result.code, layer: result.layer }).toEqual({
        truth: "PROVEN", code: null, layer: null,
      });
    }
  });

  it("adopts or exits a duplicate without preparing or opening", async () => {
    const registration = {
      lockIdentity: CLAIM.lockIdentity, wrapperIdentity: CLAIM.wrapperIdentity,
      processIdentity: "windows:4242:134309515541692727",
      bootstrapCredentialDigest: DIGEST, registeredAt: "2026-08-12T08:00:00.000Z",
    };
    const cases = [
      { lockState: "HELD", registration, kind: "ADOPTED" },
      { lockState: "RELEASED", registration: null, kind: "EXIT_BEFORE_LAUNCH" },
    ] as const;
    expect(cases.length).toBe(2);
    for (const item of cases) {
      const log: string[] = [];
      const boundary = boundaryHarness();
      const result = await launchClaude(request({
        duplicateDelivery: { claim: CLAIM, registration: item.registration, lockState: item.lockState, effectState: "ACTIVE" },
      }), { platform: "win32", deps: dependencies(boundary, log) });
      expect(result.kind).toBe(item.kind);
      expect(log).toEqual(["duplicate"]);
      expect(boundary.log).toEqual([]);
    }
  });

  it("isolates every pre-open refusal and pins its delegated code and layer", async () => {
    const unsupportedRuntime = await prepareClaudeRuntimePin({
      ...runtimeRequest,
      fs: { ...runtimeRequest.fs, hostPlatform: () => "linux" },
    });
    const hostileArgv = ["--print"];
    Object.defineProperty(hostileArgv, Symbol.iterator, { value: function* () { yield "changed"; } });
    const hostileEnvironment = {} as Record<string, string>;
    Object.defineProperty(hostileEnvironment, "PATH", { enumerable: true, get: () => "C:\\changed" });
    const hostileEffect = { ...COMMIT.intent };
    Object.defineProperty(hostileEffect, "state", { enumerable: true, get: () => "ACTIVE" });
    const cases: readonly [string, Partial<ClaudeLaunchRequest>,
      (deps: ClaudeLauncherDependencies) => ClaudeLauncherDependencies, string, string][] = [
      ["runtime", {}, (deps) => ({ ...deps, prepareRuntime: async () => unsupportedRuntime }), "CLAUDE_RUNTIME_PLATFORM_UNSUPPORTED", "RUNTIME"],
      ["commit", { attempt: { ...COMMIT.attempt, state: "LAUNCH_REQUESTED" } }, (deps) => deps, "ACTIVATION_COMMIT_INCOHERENT", "ACTIVATION"],
      ["consumed", { grant: { ...COMMIT.grant, state: "CONSUMED", version: COMMIT.grant.version + 1 } }, (deps) => deps, "GRANT_ALREADY_CONSUMED", "GRANT"],
      ["wrapper", { wrapperIdentity: "wrapper-other" }, (deps) => deps, "GRANT_WRAPPER_MISMATCH", "GRANT"],
      ["malformed", { grant: {} }, (deps) => deps, "EFFECT_GRANT_MALFORMED", "KERNEL"],
      ["argv", { argv: hostileArgv }, (deps) => deps, "CLAUDE_LAUNCH_REQUEST_MALFORMED", "LAUNCHER"],
      ["environment", { environment: hostileEnvironment }, (deps) => deps, "CLAUDE_LAUNCH_REQUEST_MALFORMED", "LAUNCHER"],
      ["nested", { effect: hostileEffect }, (deps) => deps, "CLAUDE_LAUNCH_REQUEST_MALFORMED", "LAUNCHER"],
    ];
    expect(cases.length).toBe(8);
    let ran = 0;
    for (const [, overrides, alter, code, layer] of cases) {
      const log: string[] = [];
      const boundary = boundaryHarness();
      const deps = alter(dependencies(boundary, log));
      const result = await launchClaude(request(overrides), { platform: "win32", deps });
      expect(failureOf(result)).toEqual({ code, layer });
      expect(log).not.toContain("open");
      expect(boundary.log).toEqual([]);
      ran += 1;
    }
    expect(ran).toBe(cases.length);
  });

  it("passes through a physical-boundary refusal without inventing a launch", async () => {
    const log: string[] = [];
    const boundary = boundaryHarness();
    const deps = dependencies(boundary, log);
    const refused = openWindowsProcessBoundary({}, { deps: {
      platform: "linux", resolveBroker: () => { throw new Error("unreachable"); },
      spawn: () => { throw new Error("unreachable"); },
    } });
    const result = await launchClaude(request(), {
      platform: "win32", deps: { ...deps, openBoundary: () => refused },
    });
    expect(failureOf(result)).toEqual({
      code: "PROCESS_BOUNDARY_PLATFORM_UNSUPPORTED", layer: "WINDOWS_PROCESS_REQUEST",
    });
    expect(boundary.log).toEqual([]);
  });

  it("fails closed when runtime preparation or boundary opening throws", async () => {
    const cases = [
      { code: "CLAUDE_LAUNCH_RUNTIME_THROWN", layer: "RUNTIME",
        alter: (deps: ClaudeLauncherDependencies) => ({ ...deps,
          prepareRuntime: async () => { throw new Error("runtime threw"); } }) },
      { code: "CLAUDE_LAUNCH_BOUNDARY_THROWN", layer: "LAUNCHER",
        alter: (deps: ClaudeLauncherDependencies) => ({ ...deps,
          openBoundary: () => { throw new Error("boundary threw"); } }) },
    ] as const;
    expect(cases.length).toBe(2);
    for (const item of cases) {
      const log: string[] = [];
      const boundary = boundaryHarness();
      const result = await launchClaude(request(), {
        platform: "win32", deps: item.alter(dependencies(boundary, log)),
      });
      expect(failureOf(result)).toEqual({ code: item.code, layer: item.layer });
      expect(boundary.log).toEqual([]);
    }
  });

  it("closes an opened boundary when durable registration refuses", async () => {
    const log: string[] = [];
    const boundary = boundaryHarness();
    const prior = {
      lockIdentity: CLAIM.lockIdentity, wrapperIdentity: CLAIM.wrapperIdentity,
      processIdentity: `windows:${PROCESS.pid}:${PROCESS.creationTime}`,
      bootstrapCredentialDigest: DIGEST, registeredAt: "2026-08-12T07:59:00.000Z",
    };
    const result = await launchClaude(request({ priorRegistration: prior }), {
      platform: "win32", deps: dependencies(boundary, log),
    });
    expect(failureOf(result)).toEqual({ code: "LAUNCH_LOCK_CREDENTIAL_REUSED", layer: "LAUNCH_LOCK" });
    expect(log).toContain("open");
    expect(log).toContain("register");
    expect(boundary.log).toEqual(["close"]);
  });

  it("cancels and closes when the started observation throws", async () => {
    const log: string[] = [];
    const boundary = boundaryHarness({ started: Promise.reject(new Error("start observation failed")) });
    const result = await launchClaude(request(), {
      platform: "win32", deps: dependencies(boundary, log),
    });
    expect(failureOf(result)).toEqual({ code: "CLAUDE_LAUNCH_BOUNDARY_THROWN", layer: "LAUNCHER" });
    expect(boundary.log).toEqual(["cancel", "close"]);
  });

  it("passes through process-intake refusal only after awaited cleanup", async () => {
    const log: string[] = [];
    const boundary = boundaryHarness();
    const deps = { ...dependencies(boundary, log),
      observeProcess: () => intakeProcessObservation({}, null) };
    const result = await launchClaude(request(), { platform: "win32", deps });
    expect(failureOf(result)).toEqual({ code: "PROCESS_OBSERVATION_MALFORMED", layer: "LAUNCH_LOCK" });
    expect(boundary.log).toEqual(["close"]);
  });

  it("refuses to bind exit proof from another process identity", async () => {
    const other = Object.freeze({ pid: 4343, creationTime: PROCESS.creationTime + 1n });
    const outcome: WindowsProcessOutcome = Object.freeze({ truthClass: "PROVEN", identity: other, exitCode: 0 });
    const log: string[] = [];
    const boundary = boundaryHarness({ completed: Promise.resolve(outcome), closeOutcome: outcome });
    const result = await launchClaude(request(), { platform: "win32", deps: dependencies(boundary, log) });
    expect(failureOf(result)).toEqual({
      code: "PROCESS_BOUNDARY_IDENTITY_UNPROVEN", layer: "WINDOWS_PROCESS_TRANSPORT",
    });
    if (result.kind !== "OBSERVED") throw new Error("expected UNKNOWN observation");
    expect([result.observation.reasonCode, result.observation.reasonLayer]).toEqual([
      "PROCESS_BOUNDARY_IDENTITY_UNPROVEN", "WINDOWS_PROCESS_TRANSPORT",
    ]);
  });

  it("downgrades every uncertain terminal path and awaits cleanup", async () => {
    const pending = new Promise<WindowsProcessOutcome>(() => undefined);
    const ambiguous: WindowsProcessUnknown = Object.freeze({
      truthClass: "UNKNOWN", code: "PROCESS_BOUNDARY_EXIT_UNOBSERVED",
      layer: "WINDOWS_PROCESS_TRANSPORT", message: "scripted ambiguity", identity: PROCESS,
      brokerReason: null,
    });
    const controller = new AbortController();
    const cases = [
      { name: "truncation", harness: boundaryHarness({ stdout: Buffer.from("12345") }),
        overrides: { limits: { stdoutBytes: 4, stderrBytes: 64, tailBytes: 2, timeoutMs: 1_000 } },
        options: {}, code: "CLAUDE_LAUNCH_OUTPUT_TRUNCATED", layer: "OUTPUT" },
      { name: "ambiguous-exit", harness: boundaryHarness({ completed: Promise.resolve(ambiguous), closeOutcome: ambiguous }),
        overrides: {}, options: {}, code: ambiguous.code, layer: ambiguous.layer },
      { name: "timeout", harness: boundaryHarness({ completed: pending }), overrides: {},
        options: { delay: async () => undefined }, code: "CLAUDE_LAUNCH_TIMEOUT", layer: "LAUNCHER" },
      { name: "cancel", harness: boundaryHarness({ completed: pending }), overrides: {},
        options: { signal: controller.signal }, code: "CLAUDE_LAUNCH_CANCELLED", layer: "LAUNCHER" },
      { name: "stream", harness: boundaryHarness({ completed: pending, streamError: "stderr" }), overrides: {},
        options: {}, code: "CLAUDE_LAUNCH_STREAM_ERROR", layer: "OUTPUT" },
      { name: "cleanup", harness: boundaryHarness({ closeOutcome: ambiguous }), overrides: {}, options: {},
        code: "CLAUDE_LAUNCH_CLEANUP_UNKNOWN", layer: "LAUNCHER" },
    ] as const;
    expect(cases.length).toBe(6);
    let ran = 0;
    for (const item of cases) {
      const log: string[] = [];
      const deps = { ...dependencies(item.harness, log), ...item.options };
      if (item.name === "cancel") queueMicrotask(() => controller.abort());
      const launchOptions = "signal" in item.options
        ? { platform: "win32", signal: item.options.signal, deps }
        : { platform: "win32", deps };
      const result = await launchClaude(request(item.overrides), launchOptions);
      expect(failureOf(result)).toEqual({ code: item.code, layer: item.layer });
      expect(item.harness.log.filter((entry) => entry === "close")).toHaveLength(1);
      ran += 1;
    }
    expect(ran).toBe(cases.length);
  });
});
