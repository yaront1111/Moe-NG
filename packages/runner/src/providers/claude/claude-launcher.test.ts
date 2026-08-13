import { describe, expect, it } from "vitest";

import { openWindowsProcessBoundary } from "../../platform/windows/windows-boundary.js";
import { type WindowsProcessOutcome, type WindowsProcessUnknown } from "../../platform/windows/windows-process-contract.js";
import { intakeProcessObservation } from "../../supervisor/process-observation.js";
import { prepareClaudeRuntimePin } from "./claude-runtime-pin.js";
import {
  CLAUDE_LAUNCHER_VERSION,
  CLAUDE_LAUNCH_ERROR_CODES,
  acquireWindowsLaunchLock,
  launchClaude,
  type ClaudeLaunchRequest,
  type ClaudeLauncherDependencies,
} from "./claude-launcher.js";
import { snapshotClaudeLaunchRequest } from "./claude-launcher-input.js";
import {
  CLAIM, COMMIT, DIGEST, PROCESS, PROVEN, boundaryHarness, dependencies,
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
    expect(CLAUDE_LAUNCH_ERROR_CODES).toContain("CLAUDE_LAUNCH_LOCK_UNKNOWN");
    expect(Object.isFrozen(CLAUDE_LAUNCH_ERROR_CODES)).toBe(true);
  });

  it("holds one real OS-exclusive launch lock until its lease is released", async () => {
    const identity = `launcher-test-${process.pid}-${Date.now()}`;
    const first = await acquireWindowsLaunchLock(identity);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(`first lock refused: ${first.code}`);
    try {
      const duplicate = await acquireWindowsLaunchLock(identity);
      expect(duplicate).toMatchObject({
        ok: false, code: "LAUNCH_LOCK_IDENTITY_CONFLICT", layer: "LAUNCH_LOCK",
      });
    } finally { await first.lease.release(); }
    const afterRelease = await acquireWindowsLaunchLock(identity);
    expect(afterRelease.ok).toBe(true);
    if (afterRelease.ok) await afterRelease.lease.release();
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
    expect(log).toEqual([
      "runtime", "validate", "consume", "register", "lock", "open", "register", "observe", "unlock",
    ]);
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
    expect(log).toEqual([
      "runtime", "validate", "consume", "register", "lock", "unlock",
    ]);
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

  it("contains every pre-launch authority exception before registration or provider open", async () => {
    const cases = [
      { name: "duplicate", overrides: { duplicateDelivery: {} }, layer: "LAUNCH_LOCK",
        alter: (deps: ClaudeLauncherDependencies, log: string[]) => ({ ...deps,
          resolveDuplicate: () => { log.push("duplicate"); throw new Error("duplicate port rejected"); } }) },
      { name: "activation", overrides: {}, layer: "ACTIVATION",
        alter: (deps: ClaudeLauncherDependencies, log: string[]) => ({ ...deps,
          validateCommit: () => { log.push("validate"); throw new Error("activation port rejected"); } }) },
      { name: "grant", overrides: {}, layer: "GRANT",
        alter: (deps: ClaudeLauncherDependencies, log: string[]) => ({ ...deps,
          consumeGrant: () => { log.push("consume"); throw new Error("grant port rejected"); } }) },
    ] as const;
    expect(cases.length).toBe(3);
    let ran = 0;
    for (const item of cases) {
      const log: string[] = [];
      const boundary = boundaryHarness();
      const settled = await Promise.allSettled([launchClaude(request(item.overrides), {
        platform: "win32", deps: item.alter(dependencies(boundary, log), log),
      })]);
      expect(settled).toHaveLength(1);
      expect(settled[0]?.status, item.name).toBe("fulfilled");
      if (settled[0]?.status !== "fulfilled") throw new Error(`${item.name} escaped the launcher`);
      const result = settled[0].value;
      expect({ kind: result.kind, ok: result.ok, truthClass: result.truthClass }, item.name).toEqual({
        kind: "REFUSED", ok: false, truthClass: "UNKNOWN",
      });
      const failure = failureOf(result);
      expect(failure.code, item.name).toBe("CLAUDE_LAUNCH_DEPENDENCY_THROWN");
      expect(failure.layer, item.name).toBe(item.layer);
      expect(Object.isFrozen(result), item.name).toBe(true);
      expect(log.filter((entry) => ["register", "lock", "open"].includes(entry)), item.name).toEqual([]);
      expect(boundary.requests, item.name).toHaveLength(0);
      expect(boundary.log, item.name).toEqual([]);
      ran += 1;
    }
    expect(ran).toBe(cases.length);
  });

  it("refuses prior launch registration before locking or opening the provider", async () => {
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
    expect(log).toEqual(["runtime", "validate", "consume", "register"]);
    expect(boundary.log).toEqual([]);
  });

  it("refuses an OS-exclusive lock conflict before opening the provider", async () => {
    const log: string[] = [];
    const boundary = boundaryHarness();
    const deps = { ...dependencies(boundary, log), acquireLock: async () => {
      log.push("lock");
      return Object.freeze({ ok: false as const, code: "LAUNCH_LOCK_IDENTITY_CONFLICT" as const,
        layer: "LAUNCH_LOCK" as const, message: "the OS lock is already held" });
    } };
    const result = await launchClaude(request(), { platform: "win32", deps });
    expect(failureOf(result)).toEqual({
      code: "LAUNCH_LOCK_IDENTITY_CONFLICT", layer: "LAUNCH_LOCK",
    });
    expect(log).toEqual(["runtime", "validate", "consume", "register", "lock"]);
    expect(boundary.log).toEqual([]);
  });

  it("lets only one concurrent delivery cross the real OS lock into the provider", async () => {
    let finish!: (outcome: WindowsProcessOutcome) => void;
    let opened!: () => void;
    const openedPromise = new Promise<void>((resolve) => { opened = resolve; });
    const completed = new Promise<WindowsProcessOutcome>((resolve) => { finish = resolve; });
    const identity = `concurrent-${process.pid}-${Date.now()}`;
    const claim = { ...CLAIM, lockIdentity: identity };
    const firstLog: string[] = [];
    const firstBoundary = boundaryHarness({ completed });
    const firstBase = dependencies(firstBoundary, firstLog);
    const firstDeps = { ...firstBase, acquireLock: acquireWindowsLaunchLock,
      openBoundary: (value: unknown, options?: { readonly timeoutMs?: number }) => {
        const result = firstBase.openBoundary(value, options); opened(); return result;
      } };
    const first = launchClaude(request({ claim }), { platform: "win32", deps: firstDeps });
    await openedPromise;

    const secondLog: string[] = [];
    const secondBoundary = boundaryHarness();
    let second;
    let firstResult;
    try {
      second = await launchClaude(request({ claim }), { platform: "win32", deps: {
        ...dependencies(secondBoundary, secondLog), acquireLock: acquireWindowsLaunchLock,
      } });
    } finally {
      finish(PROVEN);
      firstResult = await first;
    }
    expect(failureOf(second)).toEqual({
      code: "LAUNCH_LOCK_IDENTITY_CONFLICT", layer: "LAUNCH_LOCK",
    });
    expect(secondLog).not.toContain("open");
    expect(secondBoundary.log).toEqual([]);

    expect(firstResult.truthClass).toBe("PROVEN");
    expect(firstLog.filter((entry) => entry === "open")).toHaveLength(1);
    expect(firstBoundary.log.filter((entry) => entry === "close")).toHaveLength(1);
  });

  it("closes and unlocks when post-start durable registration refuses", async () => {
    const log: string[] = [];
    const boundary = boundaryHarness();
    const base = dependencies(boundary, log);
    let calls = 0;
    const deps = { ...base, registerLock: (registration: unknown, claim: unknown, prior: unknown) => {
      calls += 1;
      return calls === 1 ? base.registerLock(registration, claim, prior) :
        base.registerLock(registration, claim, registration);
    } };
    const result = await launchClaude(request(), { platform: "win32", deps });
    expect(failureOf(result)).toEqual({
      code: "LAUNCH_LOCK_CREDENTIAL_REUSED", layer: "LAUNCH_LOCK",
    });
    expect(log.filter((entry) => entry === "open")).toHaveLength(1);
    expect(log.filter((entry) => entry === "register")).toHaveLength(2);
    expect(boundary.log.filter((entry) => entry === "close")).toHaveLength(1);
    expect(log.filter((entry) => entry === "unlock")).toHaveLength(1);
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

  it("contains a rejected completion promise and cleans up exactly once", async () => {
    const log: string[] = [];
    const boundary = boundaryHarness({
      completed: Promise.reject(new Error("completion transport rejected")),
    });
    const result = await launchClaude(request(), {
      platform: "win32", deps: dependencies(boundary, log),
    });
    expect(failureOf(result)).toEqual({
      code: "CLAUDE_LAUNCH_BOUNDARY_THROWN", layer: "LAUNCHER",
    });
    expect(boundary.log.filter((entry) => entry === "cancel")).toHaveLength(1);
    expect(boundary.log.filter((entry) => entry === "close")).toHaveLength(1);
    expect(log.filter((entry) => entry === "unlock")).toHaveLength(1);
  });

  it("contains a rejected timer promise and cleans up exactly once", async () => {
    const log: string[] = [];
    const boundary = boundaryHarness({ completed: new Promise(() => undefined) });
    const deps = { ...dependencies(boundary, log), delay: async () => {
      throw new Error("timer transport rejected");
    } };
    const result = await launchClaude(request(), { platform: "win32", deps });
    expect(failureOf(result)).toEqual({
      code: "CLAUDE_LAUNCH_BOUNDARY_THROWN", layer: "LAUNCHER",
    });
    expect(boundary.log.filter((entry) => entry === "cancel")).toHaveLength(1);
    expect(boundary.log.filter((entry) => entry === "close")).toHaveLength(1);
    expect(log.filter((entry) => entry === "unlock")).toHaveLength(1);
  });

  it("downgrades an unproven OS-lock release after closing the provider", async () => {
    const log: string[] = [];
    const boundary = boundaryHarness();
    const deps = { ...dependencies(boundary, log), acquireLock: async () => {
      log.push("lock");
      return { ok: true as const, lease: Object.freeze({ release: async () => {
        log.push("unlock"); throw new Error("lock release rejected");
      } }) };
    } };
    const result = await launchClaude(request(), { platform: "win32", deps });
    expect(failureOf(result)).toEqual({
      code: "CLAUDE_LAUNCH_LOCK_UNKNOWN", layer: "LAUNCH_LOCK",
    });
    expect(boundary.log.filter((entry) => entry === "close")).toHaveLength(1);
    expect(log.filter((entry) => entry === "unlock")).toHaveLength(1);
  });

  it("contains post-close observation callbacks and still releases the OS lock", async () => {
    const cases = [
      { name: "process observation", alter: (deps: ClaudeLauncherDependencies) => ({ ...deps,
        observeProcess: () => { throw new Error("observation port rejected"); } }) },
      { name: "completed timestamp", alter: (deps: ClaudeLauncherDependencies) => {
        let calls = 0;
        return { ...deps, now: () => {
          calls += 1;
          if (calls === 3) throw new Error("clock rejected");
          return `2026-08-12T08:00:0${calls}.000Z`;
        } };
      } },
    ] as const;
    expect(cases.length).toBe(2);
    for (const item of cases) {
      const log: string[] = [];
      const boundary = boundaryHarness();
      const result = await launchClaude(request(), {
        platform: "win32", deps: item.alter(dependencies(boundary, log)),
      });
      expect(failureOf(result), item.name).toEqual({
        code: "CLAUDE_LAUNCH_BOUNDARY_THROWN", layer: "LAUNCHER",
      });
      expect(boundary.log.filter((entry) => entry === "close"), item.name).toHaveLength(1);
      expect(log.filter((entry) => entry === "unlock"), item.name).toHaveLength(1);
    }
  });

  it("contains a throwing stream accessor and still cancels, closes, and unlocks", async () => {
    const log: string[] = [];
    const boundary = boundaryHarness();
    Object.defineProperty(boundary.boundary, "providerStdout", {
      configurable: true, get: () => { throw new Error("stdout accessor rejected"); },
    });
    const result = await launchClaude(request(), {
      platform: "win32", deps: dependencies(boundary, log),
    });
    expect(failureOf(result)).toEqual({
      code: "CLAUDE_LAUNCH_BOUNDARY_THROWN", layer: "LAUNCHER",
    });
    expect(boundary.log.filter((entry) => entry === "cancel")).toHaveLength(1);
    expect(boundary.log.filter((entry) => entry === "close")).toHaveLength(1);
    expect(log.filter((entry) => entry === "unlock")).toHaveLength(1);
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
      expect(log.filter((entry) => entry === "unlock")).toHaveLength(1);
      ran += 1;
    }
    expect(ran).toBe(cases.length);
  });
});
