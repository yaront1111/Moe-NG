import { describe, expect, it } from "vitest";

import { openWindowsProcessBoundary,
  type WindowsProcessBoundary } from "../../platform/windows/windows-boundary.js";
import { type WindowsProcessOutcome, type WindowsProcessUnknown } from "../../platform/windows/windows-process-contract.js";
import { intakeProcessObservation } from "../../supervisor/process-observation.js";
import { prepareClaudeRuntimePin } from "./claude-runtime-pin.js";
import {
  CLAUDE_LAUNCHER_VERSION,
  CLAUDE_LAUNCH_ERROR_CODES,
  CLAUDE_LAUNCH_SELECTION_FLAGS,
  acquireWindowsLaunchLock,
  launchClaude,
  type ClaudeLaunchRequest,
  type ClaudeLauncherDependencies,
} from "./claude-launcher.js";
import { snapshotClaudeLaunchRequest } from "./claude-launcher-input.js";
import {
  CLAIM, COMMIT, DIGEST, DRIFTED_COMMIT, PROCESS, PROVEN, SELECTED_EFFORT, SELECTED_MODEL,
  SELECTION, SELECTION_ARGV, boundaryHarness, dependencies,
  failureOf, prepared, request, runtimeRequest, selectionWith, sha256,
  type BoundaryHarness,
} from "./claude-launcher-test-fixtures.js";
type ReflectionTrap = "ownKeys" | "getOwnPropertyDescriptor";
interface TrapCounter { fired: number }
function hostileProxy(target: object, trap: ReflectionTrap, counter: TrapCounter): object {
  const raise = (): never => { counter.fired += 1; throw new Error("hostile reflection trap"); };
  return new Proxy(target, trap === "ownKeys" ? { ownKeys: raise } : { getOwnPropertyDescriptor: raise });
}
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
    const counter: TrapCounter = { fired: 0 };
    const log: string[] = [];
    const boundary = boundaryHarness();
    const [settled] = await Promise.allSettled([launchClaude(hostileProxy(request(), "ownKeys", counter),
      { platform: "linux", deps: dependencies(boundary, log) })]);
    expect(settled?.status).toBe("fulfilled");
    if (settled === undefined || settled.status !== "fulfilled") throw new Error("non-Windows launch rejected");
    const result = settled.value;
    expect(failureOf(result)).toEqual({
      code: "CLAUDE_LAUNCH_PLATFORM_UNSUPPORTED", layer: "LAUNCHER",
    });
    expect(result.truthClass).toBe("UNSUPPORTED");
    expect(Object.isFrozen(result)).toBe(true);
    expect({ fired: counter.fired, deps: log, requests: boundary.requests, boundary: boundary.log })
      .toEqual({ fired: 0, deps: [], requests: [], boundary: [] });
  });

  it("contains hostile request reflection and pins the malformed launch refusal", async () => {
    const counters: TrapCounter[] = [];
    const track = (): TrapCounter => { const item = { fired: 0 }; counters.push(item); return item; };
    const cases: readonly { readonly name: string; readonly build: (counter: TrapCounter) => unknown }[] = [
      { name: "outer-own-keys", build: (c) => hostileProxy(request(), "ownKeys", c) },
      { name: "outer-descriptor", build: (c) => hostileProxy(request(), "getOwnPropertyDescriptor", c) },
      { name: "runtime-own-keys",
        build: (c) => ({ ...request(), runtime: hostileProxy({ ...runtimeRequest }, "ownKeys", c) }) },
      { name: "quoted-observation-own-keys", build: (c) => ({ ...request(),
        runtime: { ...runtimeRequest, quotedObservation: hostileProxy({}, "ownKeys", c) } }) },
      { name: "authority-own-keys",
        build: (c) => ({ ...request(), reconciliation: { nested: hostileProxy({}, "ownKeys", c) } }) },
      { name: "authority-descriptor", build: (c) => ({ ...request(),
        reconciliation: { nested: hostileProxy({ probe: "value" }, "getOwnPropertyDescriptor", c) } }) },
      { name: "argv-own-keys", build: (c) => ({ ...request(), argv: hostileProxy(["--print"], "ownKeys", c) }) },
      { name: "environment-own-keys",
        build: (c) => ({ ...request(), environment: hostileProxy({ SYSTEMROOT: "C:\\Windows" }, "ownKeys", c) }) },
      { name: "limits-own-keys", build: (c) => ({ ...request(), limits: hostileProxy(
        { stdoutBytes: 64, stderrBytes: 64, tailBytes: 4, timeoutMs: 1_000 }, "ownKeys", c) }) },
    ];
    expect(cases.length).toBe(9);
    let ran = 0;
    for (const item of cases) {
      const counter = track();
      const log: string[] = [];
      const boundary = boundaryHarness();
      const [settled] = await Promise.allSettled([launchClaude(item.build(counter),
        { platform: "win32", deps: dependencies(boundary, log) })]);
      expect({ name: item.name, status: settled?.status })
        .toEqual({ name: item.name, status: "fulfilled" });
      if (settled === undefined || settled.status !== "fulfilled") throw new Error(`${item.name} rejected`);
      const result = settled.value;
      expect({ name: item.name, kind: result.kind, ok: result.ok, truth: result.truthClass,
        code: result.code, layer: result.layer }).toEqual({ name: item.name, kind: "REFUSED", ok: false,
        truth: "UNKNOWN", code: "CLAUDE_LAUNCH_REQUEST_MALFORMED", layer: "LAUNCHER" });
      expect(Object.isFrozen(result)).toBe(true);
      if (result.kind !== "REFUSED") throw new Error(`${item.name} was not refused`);
      expect(result.message).not.toContain("hostile");
      expect(result.message).not.toContain("trap");
      expect({ name: item.name, fired: counter.fired > 0, deps: log,
        requests: boundary.requests, boundary: boundary.log })
        .toEqual({ name: item.name, fired: true, deps: [], requests: [], boundary: [] });
      ran += 1;
    }
    expect(ran).toBe(9);
    expect(counters.length).toBe(9);
    expect(counters.filter((entry) => entry.fired > 0)).toHaveLength(9);
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
    // Spelled out rather than derived from the fixture: this pins that argv
    // reaches the boundary VERBATIM, selection flags and all, so a gate that
    // rewrote or dropped an element would be caught here.
    expect(boundary.requests[0]).toMatchObject({
      argv: ["--print", "hello", "--model", "claude-opus-5-20260514", "--effort", "high"],
      cwd: "C:\\work",
    });
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
      ["runtimeDrift", { effect: DRIFTED_COMMIT.intent, attempt: DRIFTED_COMMIT.attempt,
        grant: DRIFTED_COMMIT.grant }, (deps) => deps, "PROVIDER_CAPABILITY_CHANGED", "ACTIVATION"],
      // Selection drift is refused from BOTH sides: the record can disagree with
      // argv, or argv can disagree with the record. Model and effort carry
      // separate codes so either comparison can be broken on its own and only
      // its own family reddens.
      ["selectionModelDrift", { launchSelection: selectionWith({
        selectedModelId: "claude-opus-5-20260515" }) }, (deps) => deps,
        "CLAUDE_LAUNCH_MODEL_MISMATCH", "TELEMETRY_CONFIGURATION"],
      ["argvModelAbsent", { argv: ["--print", CLAUDE_LAUNCH_SELECTION_FLAGS.effort, SELECTED_EFFORT] },
        (deps) => deps, "CLAUDE_LAUNCH_MODEL_UNPROVEN", "TELEMETRY_CONFIGURATION"],
      ["argvModelDuplicate", { argv: [...SELECTION_ARGV, CLAUDE_LAUNCH_SELECTION_FLAGS.model,
        SELECTED_MODEL] }, (deps) => deps, "CLAUDE_LAUNCH_MODEL_AMBIGUOUS", "TELEMETRY_CONFIGURATION"],
      ["argvModelAlias", { argv: [CLAUDE_LAUNCH_SELECTION_FLAGS.model, "claude-opus-5",
        CLAUDE_LAUNCH_SELECTION_FLAGS.effort, SELECTED_EFFORT] }, (deps) => deps,
        "CLAUDE_LAUNCH_MODEL_MISMATCH", "TELEMETRY_CONFIGURATION"],
      ["selectionEffortDrift", { launchSelection: selectionWith({ reasoningEffort: "low" }) },
        (deps) => deps, "CLAUDE_LAUNCH_EFFORT_MISMATCH", "TELEMETRY_CONFIGURATION"],
      ["argvEffortAbsent", { argv: [CLAUDE_LAUNCH_SELECTION_FLAGS.model, SELECTED_MODEL] },
        (deps) => deps, "CLAUDE_LAUNCH_EFFORT_UNPROVEN", "TELEMETRY_CONFIGURATION"],
      ["argvEffortDuplicate", { argv: [...SELECTION_ARGV, CLAUDE_LAUNCH_SELECTION_FLAGS.effort,
        SELECTED_EFFORT] }, (deps) => deps, "CLAUDE_LAUNCH_EFFORT_AMBIGUOUS",
        "TELEMETRY_CONFIGURATION"],
    ];
    expect(cases.length).toBe(16);
    expect(cases.map(([name]) => name)).toContain("runtimeDrift");
    expect(cases.filter(([, , , code]) => code.startsWith("CLAUDE_LAUNCH_MODEL_")).length).toBe(4);
    expect(cases.filter(([, , , code]) => code.startsWith("CLAUDE_LAUNCH_EFFORT_")).length).toBe(3);
    // All six selection codes are actually REACHED here, not merely declared.
    expect([...new Set(cases.map(([, , , code]) => code)
      .filter((code) => code.startsWith("CLAUDE_LAUNCH_MODEL_") ||
        code.startsWith("CLAUDE_LAUNCH_EFFORT_")))].sort()).toEqual([
      "CLAUDE_LAUNCH_EFFORT_AMBIGUOUS", "CLAUDE_LAUNCH_EFFORT_MISMATCH",
      "CLAUDE_LAUNCH_EFFORT_UNPROVEN", "CLAUDE_LAUNCH_MODEL_AMBIGUOUS",
      "CLAUDE_LAUNCH_MODEL_MISMATCH", "CLAUDE_LAUNCH_MODEL_UNPROVEN",
    ]);
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

  it("cuts off runtime, grant, lock and open together when the selection is unproven", async () => {
    // One assertion covering all four cutoffs the requirement names: the fixture
    // `log` records prepareRuntime, validateCommit, consumeGrant, registerLock,
    // acquireLock and openBoundary, so EXACTLY empty means none of them ran.
    const log: string[] = [];
    const boundary = boundaryHarness();
    const result = await launchClaude(request({ argv: ["--print"] }),
      { platform: "win32", deps: dependencies(boundary, log) });
    expect(failureOf(result))
      .toEqual({ code: "CLAUDE_LAUNCH_MODEL_UNPROVEN", layer: "TELEMETRY_CONFIGURATION" });
    expect(log).toEqual([]);
    expect(boundary.log).toEqual([]);
    expect(boundary.requests).toEqual([]);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("answers a malformed selection at the SELECTION layer, not the generic input layer", async () => {
    // WHICH layer answers is the point. A generic CLAUDE_LAUNCH_REQUEST_MALFORMED
    // from the request snapshot would tell a caller its request was unusable
    // somewhere, and would read identically for a bad cwd; the requirement is
    // that a selection defect is named as one, at TELEMETRY_CONFIGURATION,
    // before runtime, grant, lock or open.
    const accessor = { ...SELECTION } as unknown as Record<string, unknown>;
    Object.defineProperty(accessor, "selectedModelId",
      { enumerable: true, get: () => SELECTED_MODEL });
    let traps = 0;
    const proxied = new Proxy({ ...SELECTION }, {
      ownKeys(target: object): ArrayLike<string | symbol> {
        traps += 1;
        return Reflect.ownKeys(target);
      },
    });
    const cases: readonly (readonly [string, unknown])[] = [
      ["extra-key", { ...SELECTION, extra: "value" }],
      ["missing-key", (() => {
        const { policyDigest: _drop, ...rest } = SELECTION; return rest;
      })()],
      ["accessor", accessor],
      ["proxy", proxied],
      ["null", null],
      ["ceiling-zero", selectionWith({ concurrencyCeiling: 0 })],
    ];
    expect(cases.length).toBe(6);
    let ran = 0;
    for (const [name, launchSelection] of cases) {
      const log: string[] = [];
      const boundary = boundaryHarness();
      const result = await launchClaude(
        request({ launchSelection: launchSelection as typeof SELECTION }),
        { platform: "win32", deps: dependencies(boundary, log) });
      expect({ name, ...failureOf(result) }).toEqual({
        name, code: "CLAUDE_LAUNCH_SELECTION_MALFORMED", layer: "TELEMETRY_CONFIGURATION" });
      expect({ name, log }).toEqual({ name, log: [] });
      expect({ name, boundary: boundary.log }).toEqual({ name, boundary: [] });
      ran += 1;
    }
    expect(ran).toBe(cases.length);
    expect(traps).toBe(0);
  });

  it("launches on a hand-spelled provider-correct argv and refuses the invented flag", async () => {
    // HAND-SPELLED, not built from the production constant: a positive derived
    // from the constant would still pass if the constant named a flag the
    // provider does not read.
    const log: string[] = [];
    const boundary = boundaryHarness({ stdout: Buffer.from("ok"), stderr: Buffer.from("") });
    const result = await launchClaude(
      request({ argv: ["--print", "--model", "claude-opus-5-20260514", "--effort", "high"] }),
      { platform: "win32", deps: dependencies(boundary, log) });
    expect(result.kind).toBe("OBSERVED");
    expect(log).toContain("open");
    const refusedLog: string[] = [];
    const refusedBoundary = boundaryHarness();
    const refused = await launchClaude(
      request({ argv: ["--print", "--model", "claude-opus-5-20260514",
        "--reasoning-effort", "high"] }),
      { platform: "win32", deps: dependencies(refusedBoundary, refusedLog) });
    expect(failureOf(refused))
      .toEqual({ code: "CLAUDE_LAUNCH_EFFORT_UNPROVEN", layer: "TELEMETRY_CONFIGURATION" });
    expect(refusedLog).toEqual([]);
  });

  // The launcher forwards request.environment to the boundary verbatim, and
  // CLAUDE_CODE_EFFORT_LEVEL overrides the effort flag for that session, so a gate
  // that read argv alone would certify high while low actually launched. The two
  // arms are separate tests so each mutation drill reddens only its own family.
  it("refuses a child environment that would override the effort argv proved", async () => {
    const log: string[] = [];
    const boundary = boundaryHarness();
    const result = await launchClaude(
      request({ environment: { SYSTEMROOT: "C:\\Windows", CLAUDE_CODE_EFFORT_LEVEL: "low" } }),
      { platform: "win32", deps: dependencies(boundary, log) });
    expect(failureOf(result))
      .toEqual({ code: "CLAUDE_LAUNCH_EFFORT_MISMATCH", layer: "TELEMETRY_CONFIGURATION" });
    expect(log).toEqual([]);
    expect(boundary.requests).toEqual([]);
  });

  it("refuses a child environment that would override the model argv proved", async () => {
    const log: string[] = [];
    const boundary = boundaryHarness();
    const result = await launchClaude(
      request({ environment: { SYSTEMROOT: "C:\\Windows", ANTHROPIC_MODEL: "claude-opus-5" } }),
      { platform: "win32", deps: dependencies(boundary, log) });
    expect(failureOf(result))
      .toEqual({ code: "CLAUDE_LAUNCH_MODEL_MISMATCH", layer: "TELEMETRY_CONFIGURATION" });
    expect(log).toEqual([]);
    expect(boundary.requests).toEqual([]);
  });

  it("still launches when the child environment names the same model and effort", async () => {
    // The arm is a comparison, not a blanket ban on ever naming the variable.
    const log: string[] = [];
    const boundary = boundaryHarness({ stdout: Buffer.from("ok"), stderr: Buffer.from("") });
    const agreed = await launchClaude(
      request({ environment: { SYSTEMROOT: "C:\\Windows", CLAUDE_CODE_EFFORT_LEVEL: "high",
        ANTHROPIC_MODEL: "claude-opus-5-20260514" } }),
      { platform: "win32", deps: dependencies(boundary, log) });
    expect(agreed.kind).toBe("OBSERVED");
    expect(log).toContain("open");
  });

  it("never lets a runtime version, pinned closure or profile revision prove model or effort", async () => {
    // DoD 3 in one table: the facts that DO describe this launch — the runtime's
    // reported version, its pinned closure digest, the profile revision — are in
    // argv as bare tokens or handed in as the flag value, and none of them
    // satisfies either requirement.
    const reportedVersion = prepared.observation.reportedVersion;
    if (reportedVersion === null) throw new Error("runtime fixture reported no version");
    const cases: readonly (readonly [string, readonly string[], string])[] = [
      ["bare-runtime-version", [reportedVersion, SELECTION.profileRevisionId],
        "CLAUDE_LAUNCH_MODEL_UNPROVEN"],
      ["bare-closure-digest", [prepared.pinnedClosureDigest], "CLAUDE_LAUNCH_MODEL_UNPROVEN"],
      ["version-as-model", [CLAUDE_LAUNCH_SELECTION_FLAGS.model,
        reportedVersion, CLAUDE_LAUNCH_SELECTION_FLAGS.effort, SELECTED_EFFORT],
        "CLAUDE_LAUNCH_MODEL_MISMATCH"],
      ["profile-as-model", [CLAUDE_LAUNCH_SELECTION_FLAGS.model, SELECTION.profileRevisionId,
        CLAUDE_LAUNCH_SELECTION_FLAGS.effort, SELECTED_EFFORT], "CLAUDE_LAUNCH_MODEL_MISMATCH"],
      ["profile-as-effort", [CLAUDE_LAUNCH_SELECTION_FLAGS.model, SELECTED_MODEL,
        CLAUDE_LAUNCH_SELECTION_FLAGS.effort, SELECTION.profileRevisionId],
        "CLAUDE_LAUNCH_EFFORT_MISMATCH"],
      ["version-as-effort", [CLAUDE_LAUNCH_SELECTION_FLAGS.model, SELECTED_MODEL,
        CLAUDE_LAUNCH_SELECTION_FLAGS.effort, reportedVersion],
        "CLAUDE_LAUNCH_EFFORT_MISMATCH"],
    ];
    expect(cases.length).toBe(6);
    expect(reportedVersion.length).toBeGreaterThan(0);
    expect(SELECTION.profileRevisionId).not.toBe(SELECTED_MODEL);
    let ran = 0;
    for (const [name, argv, code] of cases) {
      const log: string[] = [];
      const boundary = boundaryHarness();
      const result = await launchClaude(request({ argv }),
        { platform: "win32", deps: dependencies(boundary, log) });
      expect({ name, ...failureOf(result) })
        .toEqual({ name, code, layer: "TELEMETRY_CONFIGURATION" });
      expect({ name, log }).toEqual({ name, log: [] });
      ran += 1;
    }
    expect(ran).toBe(cases.length);
  });

  it("echoes no selected model, effort, digest or argv element in a selection refusal", async () => {
    const secrets: readonly string[] = [
      SELECTED_MODEL, SELECTED_EFFORT, SELECTION.modelSnapshotEvidence, SELECTION.profileRevisionId,
      SELECTION.configurationDigest, SELECTION.policyDigest, SELECTION.orchestrationDigest,
      CLAUDE_LAUNCH_SELECTION_FLAGS.model, CLAUDE_LAUNCH_SELECTION_FLAGS.effort,
    ];
    expect(secrets).toHaveLength(9);
    const argvs: readonly (readonly string[])[] = [
      ["--print"],
      [...SELECTION_ARGV, CLAUDE_LAUNCH_SELECTION_FLAGS.model, SELECTED_MODEL],
      [CLAUDE_LAUNCH_SELECTION_FLAGS.model, "claude-opus-5",
        CLAUDE_LAUNCH_SELECTION_FLAGS.effort, SELECTED_EFFORT],
      [CLAUDE_LAUNCH_SELECTION_FLAGS.model, SELECTED_MODEL],
    ];
    expect(argvs).toHaveLength(4);
    let ran = 0;
    for (const argv of argvs) {
      const result = await launchClaude(request({ argv }),
        { platform: "win32", deps: dependencies(boundaryHarness(), []) });
      const serialized = JSON.stringify(result);
      expect(serialized).toContain("TELEMETRY_CONFIGURATION");
      for (const secret of secrets) {
        expect(secret.length).toBeGreaterThan(0);
        expect(serialized).not.toContain(secret);
      }
      ran += 1;
    }
    expect(ran).toBe(argvs.length);
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

  const SECRET = "secret-token";
  const PRE = ["runtime", "validate", "consume", "register", "lock"];
  const OPENED = [...PRE, "open"];
  type HostileVariant = "reflection" | "optimistic";
  const HOSTILE_VARIANTS: readonly HostileVariant[] = ["reflection", "optimistic"];

  function hostileFulfilled(
    variant: HostileVariant, optimistic: Record<string, unknown>, counter: TrapCounter,
  ): unknown {
    if (variant === "optimistic") return optimistic;
    const raise = (): never => { counter.fired += 1; throw new Error(`hostile ${SECRET}`); };
    return new Proxy({ kind: "REGISTERED", ok: true, truthClass: "PROVEN", code: "DECOY" },
      { getOwnPropertyDescriptor: raise, ownKeys: raise, has: raise, getPrototypeOf: raise });
  }

  function tracedHarness(
    log: string[], options: Parameters<typeof boundaryHarness>[0] = {},
  ): BoundaryHarness {
    const harness = boundaryHarness(options);
    const inner = harness.boundary;
    return { log: harness.log, requests: harness.requests, trigger: harness.trigger,
      boundary: { started: inner.started, completed: inner.completed,
        providerStdin: inner.providerStdin, providerStdout: inner.providerStdout,
        providerStderr: inner.providerStderr,
        cancel: () => { log.push("cancel"); inner.cancel(); },
        close: async () => { log.push("close"); return await inner.close(); } } };
  }

  interface SeamPlan {
    readonly name: string;
    readonly code: string;
    readonly layer: string;
    readonly trace: readonly string[];
    readonly optimistic: Record<string, unknown>;
    readonly overrides: Partial<ClaudeLaunchRequest>;
    build(log: string[], hostile: unknown): {
      readonly deps: ClaudeLauncherDependencies; readonly harness: BoundaryHarness;
    };
  }

  type Alter = (base: ClaudeLauncherDependencies, log: string[], hostile: unknown) =>
    Partial<ClaudeLauncherDependencies>;

  const seam = (name: string, code: string, layer: string, trace: readonly string[],
    optimistic: Record<string, unknown>, alter: Alter,
    overrides: Partial<ClaudeLaunchRequest> = {}): SeamPlan => ({
    name, code, layer, trace, optimistic, overrides,
    build: (log, hostile) => {
      const harness = tracedHarness(log);
      const base = dependencies(harness, log);
      return { harness, deps: { ...base, ...alter(base, log, hostile) } };
    },
  });

  const lifecycleSeam = (name: string, code: string, layer: string, trace: readonly string[],
    optimistic: Record<string, unknown>, key: "started" | "completed"): SeamPlan => ({
    name, code, layer, trace, optimistic, overrides: {},
    build: (log, hostile) => {
      const harness = tracedHarness(log, { [key]: Promise.resolve(hostile) } as never);
      return { harness, deps: dependencies(harness, log) };
    },
  });

  const SEAMS: readonly SeamPlan[] = [
    seam("resolveDuplicate", "CLAUDE_LAUNCH_DEPENDENCY_THROWN", "LAUNCH_LOCK", ["duplicate"],
      { kind: "ADOPTED", ok: true, processIdentity: "windows:4242:1" },
      (_base, log, hostile) => ({ resolveDuplicate: () => { log.push("duplicate"); return hostile; } }),
      { duplicateDelivery: { claim: CLAIM, registration: null, lockState: "RELEASED", effectState: "ACTIVE" } }),
    seam("prepareRuntime", "CLAUDE_LAUNCH_RUNTIME_THROWN", "RUNTIME", ["runtime"],
      { ok: true, executablePath: "C:\\claude.exe" },
      (_base, log, hostile) => ({ prepareRuntime: async () => { log.push("runtime"); return hostile; } })),
    seam("validateCommit", "CLAUDE_LAUNCH_DEPENDENCY_THROWN", "ACTIVATION", ["runtime", "validate"],
      { kind: "COHERENT", ok: true },
      (_base, log, hostile) => ({ validateCommit: () => { log.push("validate"); return hostile; } })),
    seam("consumeGrant", "CLAUDE_LAUNCH_DEPENDENCY_THROWN", "GRANT", ["runtime", "validate", "consume"],
      { kind: "CONSUMED", ok: true, versionDelta: 1 },
      (_base, log, hostile) => ({ consumeGrant: () => { log.push("consume"); return hostile; } })),
    seam("preflightRegisterLock", "CLAUDE_LAUNCH_LOCK_UNKNOWN", "LAUNCH_LOCK",
      ["runtime", "validate", "consume", "register"],
      { kind: "REGISTERED", ok: true, registration: { lockIdentity: "drill" } },
      (_base, log, hostile) => ({ registerLock: () => { log.push("register"); return hostile; } })),
    seam("acquireLock", "CLAUDE_LAUNCH_LOCK_UNKNOWN", "LAUNCH_LOCK", PRE, { ok: true },
      (_base, log, hostile) => ({ acquireLock: async () => { log.push("lock"); return hostile; } })),
    seam("openBoundary", "CLAUDE_LAUNCH_CLEANUP_UNKNOWN", "LAUNCHER", [...OPENED, "unlock"],
      { truthClass: "UNKNOWN", code: "PROCESS_BOUNDARY_BROKER_EXITED" },
      (base, _log, hostile) => ({ openBoundary: (value: unknown, options?: { readonly timeoutMs?: number }) => {
        base.openBoundary(value, options); return hostile;
      } })),
    lifecycleSeam("boundary.started", "CLAUDE_LAUNCH_BOUNDARY_THROWN", "LAUNCHER",
      [...OPENED, "cancel", "close", "unlock"], { pid: 4242 }, "started"),
    seam("postStartRegisterLock", "CLAUDE_LAUNCH_LOCK_UNKNOWN", "LAUNCH_LOCK",
      [...OPENED, "register", "cancel", "close", "unlock"],
      { kind: "REGISTERED", ok: true, registration: { lockIdentity: "drill" } },
      (base, log, hostile) => {
        let calls = 0;
        return { registerLock: (registration: unknown, claim: unknown, prior: unknown) => {
          calls += 1;
          if (calls === 1) return base.registerLock(registration, claim, prior);
          log.push("register"); return hostile;
        } };
      }),
    lifecycleSeam("boundary.completed", "CLAUDE_LAUNCH_BOUNDARY_THROWN", "LAUNCHER",
      [...OPENED, "register", "cancel", "close", "unlock"],
      { truthClass: "PROVEN", exitCode: 0 }, "completed"),
    seam("boundary.close", "CLAUDE_LAUNCH_CLEANUP_UNKNOWN", "LAUNCHER",
      [...OPENED, "register", "close", "unlock"],
      { truthClass: "PROVEN", identity: { pid: 4242 }, exitCode: 0 },
      (base, _log, hostile) => ({ openBoundary: (value: unknown, options?: { readonly timeoutMs?: number }) => {
        const opened = base.openBoundary(value, options) as WindowsProcessBoundary;
        return { started: opened.started, completed: opened.completed,
          providerStdin: opened.providerStdin, providerStdout: opened.providerStdout,
          providerStderr: opened.providerStderr, cancel: () => opened.cancel(),
          close: async () => { await opened.close(); return hostile; } };
      } })),
    seam("observeProcess", "CLAUDE_LAUNCH_BOUNDARY_THROWN", "LAUNCHER",
      [...OPENED, "register", "close", "observe", "unlock"],
      { kind: "OBSERVED", ok: true, observation: {
        processExit: { kind: "EXITED" }, proven: true, reconciliation: null } },
      (_base, log, hostile) => ({ observeProcess: () => { log.push("observe"); return hostile; } })),
  ];

  it("returns one typed refusal for every hostile fulfilled dependency result", async () => {
    // Positive control: the reflection variant really is armed, so a later
    // "fired: 0" is production never reflecting rather than a dead counter.
    const armed: TrapCounter = { fired: 0 };
    expect(() => Object.keys(hostileFulfilled("reflection", {}, armed) as object)).toThrow();
    expect(armed.fired).toBe(1);
    expect(SEAMS.length).toBe(12);
    const generated = SEAMS.flatMap((plan) => HOSTILE_VARIANTS.map((variant) => ({ plan, variant })));
    expect(generated.length).toBe(24);
    let executed = 0;
    for (const { plan, variant } of generated) {
      const label = `${plan.name}/${variant}`;
      const counter: TrapCounter = { fired: 0 };
      const log: string[] = [];
      const hostile = hostileFulfilled(variant, plan.optimistic, counter);
      const { deps, harness } = plan.build(log, hostile);
      const settled = await Promise.allSettled([
        launchClaude(request(plan.overrides), { platform: "win32", deps }),
      ]);
      expect({ label, status: settled[0]?.status }).toEqual({ label, status: "fulfilled" });
      if (settled[0]?.status !== "fulfilled") throw new Error(`${label} rejected the public promise`);
      const result = settled[0].value;
      expect({ label, kind: result.kind, ok: result.ok, truthClass: result.truthClass,
        code: result.code, layer: result.layer, frozen: Object.isFrozen(result) })
        .toEqual({ label, kind: "REFUSED", ok: false, truthClass: "UNKNOWN",
          code: plan.code, layer: plan.layer, frozen: true });
      if (result.kind !== "REFUSED") throw new Error(`${label} was not refused`);
      expect({ label, secret: result.message.includes(SECRET),
        hostile: result.message.includes("hostile") }).toEqual({ label, secret: false, hostile: false });
      expect({ label, trace: log, fired: counter.fired })
        .toEqual({ label, trace: [...plan.trace], fired: 0 });
      expect({ label, opened: harness.requests.length })
        .toEqual({ label, opened: plan.trace.includes("open") ? 1 : 0 });
      executed += 1;
    }
    expect(executed).toBe(24);
  });

  it("refuses a raw thenable and a rejected promise at every awaited port", async () => {
    const thenableCalls = { fired: 0 };
    const thenable = (value: unknown): unknown => ({
      then: (resolve: (settled: unknown) => void) => { thenableCalls.fired += 1; resolve(value); },
    });
    const rejected = (): Promise<never> => {
      const promise = Promise.reject(new Error(`port ${SECRET}`));
      promise.catch(() => undefined);
      return promise;
    };
    const lease = (log: string[], release: () => unknown): Partial<ClaudeLauncherDependencies> => ({
      acquireLock: async () => { log.push("lock"); return { ok: true, lease: { release } }; },
    });
    const wrapBoundary = (base: ClaudeLauncherDependencies,
      close: (opened: WindowsProcessBoundary) => unknown): Partial<ClaudeLauncherDependencies> => ({
      openBoundary: (value: unknown, options?: { readonly timeoutMs?: number }) => {
        const opened = base.openBoundary(value, options) as WindowsProcessBoundary;
        return { started: opened.started, completed: opened.completed,
          providerStdin: opened.providerStdin, providerStdout: opened.providerStdout,
          providerStderr: opened.providerStderr, cancel: () => opened.cancel(),
          close: () => close(opened) };
      },
    });
    const ports: readonly {
      readonly name: string; readonly code: string; readonly layer: string;
      trace(mode: "thenable" | "rejected"): readonly string[];
      build(log: string[], mode: "thenable" | "rejected"): {
        readonly deps: ClaudeLauncherDependencies; readonly harness: BoundaryHarness;
      };
    }[] = [
      { name: "prepareRuntime", code: "CLAUDE_LAUNCH_RUNTIME_THROWN", layer: "RUNTIME", trace: () => ["runtime"],
        build: (log, mode) => {
          const harness = tracedHarness(log);
          return { harness, deps: { ...dependencies(harness, log), prepareRuntime: () => {
            log.push("runtime"); return mode === "thenable" ? thenable(prepared) : rejected();
          } } };
        } },
      { name: "acquireLock", code: "CLAUDE_LAUNCH_LOCK_UNKNOWN", layer: "LAUNCH_LOCK", trace: () => PRE,
        build: (log, mode) => {
          const harness = tracedHarness(log);
          return { harness, deps: { ...dependencies(harness, log), acquireLock: () => {
            log.push("lock");
            return mode === "thenable"
              ? thenable({ ok: true, lease: { release: async () => undefined } }) : rejected();
          } } };
        } },
      { name: "boundary.started", code: "CLAUDE_LAUNCH_BOUNDARY_THROWN", layer: "LAUNCHER",
        trace: () => [...OPENED, "cancel", "close", "unlock"],
        build: (log, mode) => {
          const harness = tracedHarness(log,
            { started: (mode === "thenable" ? thenable(PROCESS) : rejected()) as never });
          return { harness, deps: dependencies(harness, log) };
        } },
      { name: "boundary.completed", code: "CLAUDE_LAUNCH_BOUNDARY_THROWN", layer: "LAUNCHER",
        trace: (mode) => mode === "thenable" ? [...OPENED, "cancel", "close", "unlock"]
          : [...OPENED, "register", "cancel", "close", "observe", "unlock"],
        build: (log, mode) => {
          const harness = tracedHarness(log,
            { completed: (mode === "thenable" ? thenable(PROVEN) : rejected()) as never });
          return { harness, deps: dependencies(harness, log) };
        } },
      { name: "boundary.close", code: "CLAUDE_LAUNCH_CLEANUP_UNKNOWN", layer: "LAUNCHER",
        trace: () => [...OPENED, "register", "close", "unlock"],
        build: (log, mode) => {
          const harness = tracedHarness(log);
          const base = dependencies(harness, log);
          return { harness, deps: { ...base, ...wrapBoundary(base, (opened) => {
            void opened.close();
            return mode === "thenable" ? thenable(PROVEN) : rejected();
          }) } };
        } },
      { name: "delay", code: "CLAUDE_LAUNCH_BOUNDARY_THROWN", layer: "LAUNCHER",
        trace: () => [...OPENED, "register", "cancel", "close", "observe", "unlock"],
        build: (log, mode) => {
          const harness = tracedHarness(log, { completed: new Promise(() => undefined) });
          return { harness, deps: { ...dependencies(harness, log),
            delay: () => (mode === "thenable" ? thenable(undefined) : rejected()) } };
        } },
      { name: "lease.release", code: "CLAUDE_LAUNCH_LOCK_UNKNOWN", layer: "LAUNCH_LOCK",
        trace: () => [...OPENED, "register", "close", "observe", "unlock"],
        build: (log, mode) => {
          const harness = tracedHarness(log);
          return { harness, deps: { ...dependencies(harness, log), ...lease(log, () => {
            log.push("unlock");
            return mode === "thenable" ? thenable(undefined) : rejected();
          }) } };
        } },
    ];
    expect(ports.length).toBe(7);
    const generated = ports.flatMap((port) =>
      (["thenable", "rejected"] as const).map((mode) => ({ port, mode })));
    expect(generated.length).toBe(14);
    let executed = 0;
    for (const { port, mode } of generated) {
      const label = `${port.name}/${mode}`;
      const log: string[] = [];
      const { deps } = port.build(log, mode);
      const settled = await Promise.allSettled([launchClaude(request(), { platform: "win32", deps })]);
      expect({ label, status: settled[0]?.status }).toEqual({ label, status: "fulfilled" });
      if (settled[0]?.status !== "fulfilled") throw new Error(`${label} rejected the public promise`);
      const result = settled[0].value;
      expect({ label, code: result.code, layer: result.layer, truthClass: result.truthClass })
        .toEqual({ label, code: port.code, layer: port.layer, truthClass: "UNKNOWN" });
      expect({ label, secret: JSON.stringify(result).includes(SECRET) })
        .toEqual({ label, secret: false });
      expect({ label, trace: log }).toEqual({ label, trace: [...port.trace(mode)] });
      executed += 1;
    }
    expect(executed).toBe(14);
    expect(thenableCalls.fired).toBe(0);
  });

  it("contains hostile launch-option and dependency capability reflection", async () => {
    const withGetter = <T extends object>(target: T, key: string, counter: TrapCounter): T => {
      Object.defineProperty(target, key, { enumerable: true, configurable: true,
        get: () => { counter.fired += 1; throw new Error(`entry ${SECRET}`); } });
      return target;
    };
    const cases: readonly { readonly name: string;
      build(counter: TrapCounter, deps: ClaudeLauncherDependencies): unknown }[] = [
      { name: "options.platform",
        build: (counter) => withGetter({ } as Record<string, unknown>, "platform", counter) },
      { name: "options.signal",
        build: (counter, deps) => withGetter({ platform: "win32", deps } as Record<string, unknown>,
          "signal", counter) },
      { name: "options.deps",
        build: (counter) => withGetter({ platform: "win32" } as Record<string, unknown>, "deps", counter) },
      { name: "deps.openBoundary",
        build: (counter, deps) => ({ platform: "win32",
          deps: withGetter({ ...deps } as unknown as Record<string, unknown>, "openBoundary", counter) }) },
      { name: "deps.observeProcess-absent",
        build: (_counter, deps) => ({ platform: "win32",
          deps: { ...deps, observeProcess: undefined } }) },
      { name: "options.signal-prototype-trap",
        build: (counter, deps) => ({ platform: "win32", deps,
          signal: new Proxy(new AbortController().signal, {
            getPrototypeOf: () => { counter.fired += 1; throw new Error(`entry ${SECRET}`); } }) }) },
    ];
    expect(cases.length).toBe(6);
    let executed = 0;
    for (const item of cases) {
      const counter: TrapCounter = { fired: 0 };
      const log: string[] = [];
      const harness = tracedHarness(log);
      const settled = await Promise.allSettled([
        launchClaude(request(), item.build(counter, dependencies(harness, log)) as never),
      ]);
      expect({ name: item.name, status: settled[0]?.status })
        .toEqual({ name: item.name, status: "fulfilled" });
      if (settled[0]?.status !== "fulfilled") throw new Error(`${item.name} rejected`);
      const result = settled[0].value;
      expect({ name: item.name, code: result.code, layer: result.layer, truthClass: result.truthClass })
        .toEqual({ name: item.name, code: "CLAUDE_LAUNCH_REQUEST_MALFORMED", layer: "LAUNCHER",
          truthClass: "UNKNOWN" });
      if (result.kind !== "REFUSED") throw new Error(`${item.name} was not refused`);
      expect({ name: item.name, secret: result.message.includes(SECRET), fired: counter.fired,
        trace: log }).toEqual({ name: item.name, secret: false, fired: 0, trace: [] });
      executed += 1;
    }
    expect(executed).toBe(6);
  });

  it("keeps cleanup ownership when a boundary stream traps its prototype", async () => {
    const counter: TrapCounter = { fired: 0 };
    const raise = (): never => { counter.fired += 1; throw new Error(`stream ${SECRET}`); };
    const log: string[] = [];
    const harness = tracedHarness(log);
    const base = dependencies(harness, log);
    const deps = { ...base, openBoundary: (value: unknown, options?: { readonly timeoutMs?: number }) => {
      const opened = base.openBoundary(value, options) as WindowsProcessBoundary;
      return { started: opened.started, completed: opened.completed,
        providerStdin: opened.providerStdin,
        providerStdout: new Proxy(opened.providerStdout, { getPrototypeOf: raise }),
        providerStderr: opened.providerStderr, cancel: () => opened.cancel(),
        close: async () => await opened.close() };
    } };
    const settled = await Promise.allSettled([launchClaude(request(), { platform: "win32", deps })]);
    expect(settled[0]?.status).toBe("fulfilled");
    if (settled[0]?.status !== "fulfilled") throw new Error("a hostile stream rejected the promise");
    const result = settled[0].value;
    expect({ kind: result.kind, code: result.code, layer: result.layer, truthClass: result.truthClass })
      .toEqual({ kind: "REFUSED", code: "CLAUDE_LAUNCH_BOUNDARY_THROWN", layer: "LAUNCHER",
        truthClass: "UNKNOWN" });
    expect(log).toEqual([...OPENED, "cancel", "close", "unlock"]);
    expect(counter.fired).toBe(0);
  });

  it("accepts a class-shaped boundary whose cleanup lives on its prototype", async () => {
    class PrototypeBoundary {
      readonly started: WindowsProcessBoundary["started"];
      readonly completed: WindowsProcessBoundary["completed"];
      readonly providerStdin: WindowsProcessBoundary["providerStdin"];
      readonly providerStdout: WindowsProcessBoundary["providerStdout"];
      readonly providerStderr: WindowsProcessBoundary["providerStderr"];
      private readonly inner: WindowsProcessBoundary;
      constructor(inner: WindowsProcessBoundary) {
        this.inner = inner;
        this.started = inner.started;
        this.completed = inner.completed;
        this.providerStdin = inner.providerStdin;
        this.providerStdout = inner.providerStdout;
        this.providerStderr = inner.providerStderr;
      }
      cancel(): void { this.inner.cancel(); }
      async close(): Promise<WindowsProcessOutcome> { return await this.inner.close(); }
    }
    const log: string[] = [];
    const harness = boundaryHarness({ stdout: Buffer.from("alpha") });
    const base = dependencies(harness, log);
    const deps = { ...base, openBoundary: (value: unknown, options?: { readonly timeoutMs?: number }) =>
      new PrototypeBoundary(base.openBoundary(value, options) as WindowsProcessBoundary) };
    const result = await launchClaude(request(), { platform: "win32", deps });
    expect({ kind: result.kind, truthClass: result.truthClass, code: result.code })
      .toEqual({ kind: "OBSERVED", truthClass: "PROVEN", code: null });
    expect(harness.log).toEqual(["close"]);
    expect(log.filter((entry) => entry === "unlock")).toHaveLength(1);
  });
});

/**
 * A coherent activation for runtime A must not be able to launch pinned runtime
 * B. The drifted fixture is a fully COHERENT activation that simply names a
 * different runtime, so `validateCommit` has nothing to say about it and the
 * refusal can only come from the binding guard.
 */
describe("the prepared runtime is bound to the committed activation", () => {
  const encoded = (value: string): string => JSON.stringify(value).slice(1, -1);
  const drifted = (): ClaudeLaunchRequest => request({
    effect: DRIFTED_COMMIT.intent,
    attempt: DRIFTED_COMMIT.attempt,
    grant: DRIFTED_COMMIT.grant,
  });

  it("refuses a coherent activation that names a runtime the wrapper did not prepare", async () => {
    const log: string[] = [];
    const boundary = boundaryHarness();
    const result = await launchClaude(drifted(), { platform: "win32", deps: dependencies(boundary, log) });
    expect(failureOf(result)).toEqual({ code: "PROVIDER_CAPABILITY_CHANGED", layer: "ACTIVATION" });
    // Exact equality, never `not.toContain("open")`: this single assertion says
    // the guard ran AFTER runtime preparation and validateCommit and BEFORE
    // consume, the durable preflight, the OS lock and openBoundary.
    expect(log).toEqual(["runtime", "validate"]);
    expect(boundary.log).toEqual([]);
    expect(boundary.requests).toEqual([]);
  });

  it("separates the two ACTIVATION refusals by code, because the layer cannot", async () => {
    const drift = await launchClaude(drifted(),
      { platform: "win32", deps: dependencies(boundaryHarness(), []) });
    const incoherent = await launchClaude(
      request({ attempt: { ...COMMIT.attempt, state: "LAUNCH_REQUESTED" } }),
      { platform: "win32", deps: dependencies(boundaryHarness(), []) },
    );
    expect(failureOf(drift)).toEqual({ code: "PROVIDER_CAPABILITY_CHANGED", layer: "ACTIVATION" });
    expect(failureOf(incoherent)).toEqual({ code: "ACTIVATION_COMMIT_INCOHERENT", layer: "ACTIVATION" });
    expect(failureOf(drift).layer).toBe(failureOf(incoherent).layer);
    expect(failureOf(drift).code).not.toBe(failureOf(incoherent).code);
  });

  it("echoes no runtime path, digest operand, grant id or bootstrap credential", async () => {
    const result = await launchClaude(drifted(),
      { platform: "win32", deps: dependencies(boundaryHarness(), []) });
    const serialized = JSON.stringify(result);
    const secrets: readonly string[] = [
      prepared.executablePath, prepared.pinnedRoot, prepared.quotedObservationDigest,
      prepared.freshObservationDigest, prepared.bindingDigest,
      DRIFTED_COMMIT.intent.runtimeObservationDigest, DRIFTED_COMMIT.grant.grantId, DIGEST,
    ];
    expect(secrets).toHaveLength(8);
    for (const secret of secrets) {
      expect(secret.length).toBeGreaterThan(0);
      expect(serialized).not.toContain(encoded(secret));
    }
  });

  it("still launches when the committed runtime IS the prepared one", async () => {
    expect(COMMIT.intent.runtimeObservationDigest).toBe(prepared.quotedObservationDigest);
    expect(DRIFTED_COMMIT.intent.runtimeObservationDigest)
      .not.toBe(prepared.quotedObservationDigest);
    const log: string[] = [];
    const boundary = boundaryHarness({ stdout: Buffer.from("alpha") });
    const result = await launchClaude(request(), { platform: "win32", deps: dependencies(boundary, log) });
    expect({ kind: result.kind, truthClass: result.truthClass, code: result.code })
      .toEqual({ kind: "OBSERVED", truthClass: "PROVEN", code: null });
    expect(log).toEqual([
      "runtime", "validate", "consume", "register", "lock", "open", "register", "observe", "unlock",
    ]);
  });

  /**
   * Duplicate delivery returns before the runtime phase and opens no process, so
   * a drifted commit must still adopt rather than be refused: there is nothing
   * to bind a runtime to when no runtime was prepared.
   */
  it("leaves duplicate adoption untouched, because adoption prepares no runtime", async () => {
    const log: string[] = [];
    const boundary = boundaryHarness();
    const result = await launchClaude({
      ...drifted(),
      duplicateDelivery: {
        claim: CLAIM,
        registration: {
          lockIdentity: CLAIM.lockIdentity, wrapperIdentity: CLAIM.wrapperIdentity,
          processIdentity: "windows:4242:134309515541692727",
          bootstrapCredentialDigest: DIGEST, registeredAt: "2026-08-12T08:00:00.000Z",
        },
        lockState: "HELD", effectState: "ACTIVE",
      },
    }, { platform: "win32", deps: dependencies(boundary, log) });
    expect(result.kind).toBe("ADOPTED");
    expect(log).toEqual(["duplicate"]);
    expect(boundary.log).toEqual([]);
  });
});
