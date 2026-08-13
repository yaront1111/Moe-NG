/**
 * The durable-authority overlay contract, exercised through the package ROOT.
 *
 * Every symbol under test is imported from the bare specifier `@moe/runner`,
 * because a daemon composing this seam has no other way in: the package
 * `exports` map is exclusive, so a deep subpath does not resolve for it at all.
 * The fixtures below are relative because they are internal test data, not part
 * of the seam.
 *
 * The two durable stores here answer from their OWN rows, never from the bytes
 * the caller presented. That is what makes a replay assertion non-vacuous: the
 * shipped pure `consumeActivationGrant` cannot see a first call, so a refusal
 * the default port could also have produced would prove nothing about the
 * injected one.
 */
import { describe, expect, it } from "vitest";

import {
  CLAUDE_LAUNCH_REGISTRATION_PHASES,
  createClaudeLauncher,
  type ClaudeLaunchRegistrationPhase,
  type ClaudeLaunchResult,
  type ClaudeLauncherAuthority,
  type ClaudeLauncherDependencies,
  type ClaudeRegistrationCommit,
} from "@moe/runner";

import { type WindowsProcessBoundary } from "../../platform/windows/windows-boundary.js";
import { classifyRegistrationPhase,
  durableRegistrationPort } from "./claude-launcher-authority.js";
import { type WindowsProcessOutcome } from "../../platform/windows/windows-process-contract.js";
import { consumeActivationGrant, grantRefusal } from "../../supervisor/effect-grant.js";
import { parseActivationGrant } from "../../supervisor/effect-parse.js";
import { launchLockFailure, type LaunchLockRegistration } from "../../supervisor/launch-lock.js";
import {
  CLAIM, COMMIT, DIGEST, PROCESS, boundaryHarness, dependencies, failureOf, prepared, request,
  type BoundaryHarness,
} from "./claude-launcher-test-fixtures.js";

const STARTED_IDENTITY = `windows:${PROCESS.pid}:${PROCESS.creationTime}`;
const PENDING_IDENTITY = `pending:${CLAIM.wrapperIdentity}`;
const AT = "2026-08-12T08:00:00.000Z";
const PASS = Symbol("fall through to the durable store");

type Row = Record<string, unknown>;
interface GrantStore {
  readonly calls: (readonly [unknown, unknown])[];
  readonly rows: Map<string, Row>;
  consumeGrantDurably(grant: unknown, wrapperIdentity: unknown): unknown;
}
interface RegistrationStore {
  readonly commits: ClaudeRegistrationCommit[];
  readonly rows: Map<string, LaunchLockRegistration>;
  commitProcessRegistration(commit: ClaudeRegistrationCommit): unknown;
}

/** A one-use CAS over durable rows: the presented bytes only select a row. */
function durableGrants(
  seed: Row = { ...COMMIT.grant },
  script: (grant: unknown) => unknown = () => PASS,
): GrantStore {
  const rows = new Map<string, Row>([[String(seed["grantId"]), { ...seed }]]);
  const calls: (readonly [unknown, unknown])[] = [];
  return {
    calls,
    rows,
    consumeGrantDurably(grant, wrapperIdentity) {
      calls.push([grant, wrapperIdentity]);
      const scripted = script(grant);
      if (scripted !== PASS) return scripted;
      const presented = parseActivationGrant(grant);
      const row = presented === null ? undefined : rows.get(presented.grantId);
      if (row === undefined) {
        return grantRefusal("ACTIVATION_COMMIT_INCOHERENT", "ACTIVATION",
          "no durable activation carries this grant");
      }
      const outcome = consumeActivationGrant(row, wrapperIdentity);
      if (outcome.kind === "CONSUMED") rows.set(outcome.grant.grantId, { ...outcome.grant });
      return outcome;
    },
  };
}

/** PREFLIGHT reserves the pending identity; STARTED supersedes that reservation. */
function durableRegistrations(
  script: (commit: ClaudeRegistrationCommit) => unknown = () => PASS,
): RegistrationStore {
  const commits: ClaudeRegistrationCommit[] = [];
  const rows = new Map<string, LaunchLockRegistration>();
  return {
    commits,
    rows,
    commitProcessRegistration(commit) {
      commits.push(commit);
      const scripted = script(commit);
      if (scripted !== PASS) return scripted;
      const { phase, registration } = commit;
      const held = rows.get(registration.lockIdentity);
      if (phase === "PREFLIGHT" && held !== undefined &&
        held.processIdentity !== `pending:${registration.wrapperIdentity}`) {
        return Object.freeze({ kind: "REFUSED", failure: launchLockFailure(
          "LAUNCH_LOCK_IDENTITY_CONFLICT", "LAUNCH_LOCK",
          "this lock already carries a durable process registration", "launchLock.register") });
      }
      rows.set(registration.lockIdentity, registration);
      return Object.freeze({ kind: "REGISTERED", ok: true, registration });
    },
  };
}

function authorityOf(grants: GrantStore, regs: RegistrationStore): ClaudeLauncherAuthority {
  return {
    consumeGrantDurably: grants.consumeGrantDurably,
    commitProcessRegistration: regs.commitProcessRegistration,
  };
}

/**
 * `close` and the lock release land in two different fixture logs, so cleanup
 * ORDER is unassertable without one array. This wrapper adds a trace push and
 * nothing else; every port underneath is still the shipped production function.
 */
function tracedDeps(harness: BoundaryHarness, trace: string[]): ClaudeLauncherDependencies {
  const base = dependencies(harness, trace);
  return Object.freeze({
    ...base,
    openBoundary: (value: unknown, options?: { readonly timeoutMs?: number }): unknown => {
      const boundary = base.openBoundary(value, options) as WindowsProcessBoundary;
      return { ...boundary, close: async (): Promise<WindowsProcessOutcome> => {
        trace.push("close");
        return await boundary.close();
      } };
    },
  });
}

function refusalMessage(result: ClaudeLaunchResult): string {
  if (result.kind !== "REFUSED") throw new Error(`expected REFUSED, received ${result.kind}`);
  return result.message;
}

/** A refusal may name a phase; it may never hand back the secrets it guarded. */
function expectNoSecretEcho(result: ClaudeLaunchResult): void {
  const message = refusalMessage(result);
  expect(message.includes(DIGEST)).toBe(false);
  expect(message.includes(COMMIT.grant.grantId)).toBe(false);
  expect(message.includes(prepared.executablePath)).toBe(false);
}

describe("durable Claude launcher authority overlay", () => {
  it("publishes the frozen registration-phase vocabulary", () => {
    const phases: readonly ClaudeLaunchRegistrationPhase[] = CLAUDE_LAUNCH_REGISTRATION_PHASES;
    expect(phases).toEqual(["PREFLIGHT", "STARTED"]);
    expect(Object.isFrozen(CLAUDE_LAUNCH_REGISTRATION_PHASES)).toBe(true);
  });

  it("advances a committed UNUSED grant exactly once through the injected CAS", async () => {
    const trace: string[] = [];
    const grants = durableGrants();
    const regs = durableRegistrations();
    const launch = createClaudeLauncher(authorityOf(grants, regs));
    const result = await launch(request(), { deps: dependencies(boundaryHarness(), trace) });
    expect(result.kind).toBe("OBSERVED");
    if (result.kind !== "OBSERVED") throw new Error("expected observation");
    expect({ truth: result.truthClass, code: result.code, layer: result.layer })
      .toEqual({ truth: "PROVEN", code: null, layer: null });
    expect(grants.calls.length).toBe(1);
    expect(grants.calls[0]).toEqual([COMMIT.grant, CLAIM.wrapperIdentity]);
    expect(grants.rows.get(COMMIT.grant.grantId))
      .toMatchObject({ state: "CONSUMED", version: COMMIT.grant.version + 1 });
    expect(result.consumedGrant.state).toBe("CONSUMED");
    expect(trace).toEqual(["runtime", "validate", "lock", "open", "observe", "unlock"]);
  });

  it("records the pending then the observed identity at the two launcher phases", async () => {
    const trace: string[] = [];
    const grants = durableGrants();
    const regs = durableRegistrations((commit) => {
      trace.push(`commit:${commit.phase}`);
      return PASS;
    });
    const launch = createClaudeLauncher(authorityOf(grants, regs));
    const result = await launch(request(), { deps: tracedDeps(boundaryHarness(), trace) });
    expect(result.kind).toBe("OBSERVED");
    expect(regs.commits.length).toBe(2);
    expect(regs.commits.map((commit) => commit.phase)).toEqual(["PREFLIGHT", "STARTED"]);
    expect(regs.commits.map((commit) => commit.registration.processIdentity))
      .toEqual([PENDING_IDENTITY, STARTED_IDENTITY]);
    // The launcher deep-copies the request, so the claim travelling out is an
    // equal record rather than the caller's object identity.
    expect(regs.commits[0]?.claim).toEqual(CLAIM);
    expect(regs.commits[0]?.prior).toBe(null);
    expect(trace.indexOf("commit:PREFLIGHT")).toBeLessThan(trace.indexOf("open"));
    expect(trace.indexOf("commit:STARTED")).toBeGreaterThan(trace.indexOf("open"));
    expect(trace.indexOf("close")).toBeLessThan(trace.indexOf("unlock"));
    expect(regs.rows.get(CLAIM.lockIdentity)?.processIdentity).toBe(STARTED_IDENTITY);
  });

  it("refuses a durable replay with the delegated code and opens nothing", async () => {
    const trace: string[] = [];
    const grants = durableGrants({ ...COMMIT.grant, state: "CONSUMED", version: 1 });
    const regs = durableRegistrations();
    const launch = createClaudeLauncher(authorityOf(grants, regs));
    const result = await launch(request(), { deps: dependencies(boundaryHarness(), trace) });
    expect(failureOf(result)).toEqual({ code: "GRANT_ALREADY_CONSUMED", layer: "GRANT" });
    expect(trace).toEqual(["runtime", "validate"]);
    expect(regs.commits.length).toBe(0);
    expectNoSecretEcho(result);
  });

  it("refuses a forged grant with a code the default port cannot emit", async () => {
    const trace: string[] = [];
    const grants = durableGrants({ ...COMMIT.grant, grantId: "cd".repeat(32) });
    const regs = durableRegistrations();
    const launch = createClaudeLauncher(authorityOf(grants, regs));
    const result = await launch(request(), { deps: dependencies(boundaryHarness(), trace) });
    expect(failureOf(result)).toEqual({
      code: "ACTIVATION_COMMIT_INCOHERENT", layer: "ACTIVATION",
    });
    expect(trace).toEqual(["runtime", "validate"]);
    expect(regs.commits.length).toBe(0);
    expectNoSecretEcho(result);
  });

  it("refuses when the durable row binds a wrapper the presented grant does not", async () => {
    const trace: string[] = [];
    const grants = durableGrants({ ...COMMIT.grant, wrapperIdentity: "wrapper-other" });
    const regs = durableRegistrations();
    const launch = createClaudeLauncher(authorityOf(grants, regs));
    const result = await launch(request(), { deps: dependencies(boundaryHarness(), trace) });
    expect(failureOf(result)).toEqual({ code: "GRANT_WRAPPER_MISMATCH", layer: "GRANT" });
    expect(trace).toEqual(["runtime", "validate"]);
    expect(regs.commits.length).toBe(0);
    expectNoSecretEcho(result);
  });

  it("lets the PURE launch lock answer credential reuse before the injected port", async () => {
    const trace: string[] = [];
    const grants = durableGrants();
    const regs = durableRegistrations();
    const launch = createClaudeLauncher(authorityOf(grants, regs));
    const result = await launch(request({ priorRegistration: {
      lockIdentity: CLAIM.lockIdentity, wrapperIdentity: CLAIM.wrapperIdentity,
      processIdentity: STARTED_IDENTITY, bootstrapCredentialDigest: DIGEST, registeredAt: AT,
    } }), { deps: dependencies(boundaryHarness(), trace) });
    expect(failureOf(result)).toEqual({
      code: "LAUNCH_LOCK_CREDENTIAL_REUSED", layer: "LAUNCH_LOCK",
    });
    expect(regs.commits.length).toBe(0);
    expect(grants.calls.length).toBe(1);
    expect(trace).toEqual(["runtime", "validate"]);
    expectNoSecretEcho(result);
  });

  it("refuses a restart from the durable registration before a second open", async () => {
    const grants = durableGrants();
    const regs = durableRegistrations();
    const launch = createClaudeLauncher(authorityOf(grants, regs));
    const first = await launch(request(), { deps: dependencies(boundaryHarness(), []) });
    expect(first.kind).toBe("OBSERVED");
    grants.rows.set(COMMIT.grant.grantId, { ...COMMIT.grant });
    const trace: string[] = [];
    const second = await launch(request(), { deps: dependencies(boundaryHarness(), trace) });
    expect(failureOf(second)).toEqual({
      code: "LAUNCH_LOCK_IDENTITY_CONFLICT", layer: "LAUNCH_LOCK",
    });
    expect(trace.filter((entry) => entry === "open")).toEqual([]);
    expect(regs.rows.get(CLAIM.lockIdentity)?.processIdentity).toBe(STARTED_IDENTITY);
    expectNoSecretEcho(second);
  });

  it("resolves duplicate delivery on the SHIPPED defaults with no authority call", async () => {
    const grants = durableGrants();
    const regs = durableRegistrations();
    const launch = createClaudeLauncher(authorityOf(grants, regs));
    const exited = await launch(request({ duplicateDelivery: {
      claim: CLAIM, registration: null, lockState: "RELEASED", effectState: "ACTIVE" } }));
    expect(exited).toMatchObject({
      kind: "EXIT_BEFORE_LAUNCH", ok: true, launched: false, processIdentity: null,
    });
    const adopted = await launch(request({ duplicateDelivery: {
      claim: CLAIM, lockState: "HELD", effectState: "ACTIVE", registration: {
        lockIdentity: CLAIM.lockIdentity, wrapperIdentity: CLAIM.wrapperIdentity,
        processIdentity: STARTED_IDENTITY, bootstrapCredentialDigest: DIGEST,
        registeredAt: AT } } }));
    expect(adopted).toMatchObject({
      kind: "ADOPTED", ok: true, launched: false, processIdentity: STARTED_IDENTITY,
    });
    expect({ grants: grants.calls.length, regs: regs.commits.length })
      .toEqual({ grants: 0, regs: 0 });
  });
});

const ECHO_REGISTRATION: LaunchLockRegistration = Object.freeze({
  lockIdentity: CLAIM.lockIdentity, wrapperIdentity: CLAIM.wrapperIdentity,
  processIdentity: STARTED_IDENTITY, bootstrapCredentialDigest: DIGEST, registeredAt: AT,
});
const CONSUMED_ARM = Object.freeze({
  kind: "CONSUMED", ok: true, versionDelta: 1,
  grant: { ...COMMIT.grant, state: "CONSUMED", version: COMMIT.grant.version + 1 },
});
const thenable = (value: unknown): unknown =>
  ({ then: (done: (settled: unknown) => void) => { done(value); } });
const getTrap = (target: object): unknown =>
  new Proxy(target, { get: () => { throw new Error("hostile get trap"); } });

interface Fulfilment { readonly name: string; make(echo: LaunchLockRegistration): unknown }
const GRANT_HOSTILE: readonly Fulfilment[] = [
  { name: "throws", make: () => { throw new Error("the durable grant store threw"); } },
  { name: "returns a native Promise", make: () => Promise.resolve(CONSUMED_ARM) },
  { name: "returns a thenable", make: () => thenable(CONSUMED_ARM) },
  { name: "returns a wrong kind", make: () => ({ ...CONSUMED_ARM, kind: "ADVANCED" }) },
  { name: "returns a false ok arm", make: () => ({ ...CONSUMED_ARM, ok: false }) },
  { name: "returns a versionDelta other than 1", make: () => ({ ...CONSUMED_ARM, versionDelta: 2 }) },
  { name: "returns a grant that does not parse", make: () => ({ ...CONSUMED_ARM, grant: { no: 1 } }) },
  { name: "returns a get-trapping proxy", make: () => getTrap({ ...CONSUMED_ARM }) },
];
const REGISTRATION_HOSTILE: readonly Fulfilment[] = [
  { name: "throws", make: () => { throw new Error("the durable registration store threw"); } },
  { name: "returns a native Promise",
    make: (echo) => Promise.resolve({ kind: "REGISTERED", ok: true, registration: echo }) },
  { name: "returns a thenable",
    make: (echo) => thenable({ kind: "REGISTERED", ok: true, registration: echo }) },
  { name: "returns a wrong kind",
    make: (echo) => ({ kind: "RESERVED", ok: true, registration: echo }) },
  { name: "returns a false ok arm",
    make: (echo) => ({ kind: "REGISTERED", ok: false, registration: echo }) },
  { name: "returns a registration that does not parse",
    make: () => ({ kind: "REGISTERED", ok: true, registration: { no: 1 } }) },
  { name: "returns a get-trapping proxy",
    make: (echo) => getTrap({ kind: "REGISTERED", ok: true, registration: echo }) },
];

type MatrixPhase = "GRANT" | ClaudeLaunchRegistrationPhase;
interface MatrixCase {
  readonly name: string; readonly phase: MatrixPhase; readonly code: string;
  readonly layer: string; readonly opens: number;
  make(echo: LaunchLockRegistration): unknown;
}
const REGISTRATION_PHASES: readonly ClaudeLaunchRegistrationPhase[] = ["PREFLIGHT", "STARTED"];
const MATRIX: readonly MatrixCase[] = [
  ...GRANT_HOSTILE.map((entry) => ({
    name: `the grant port ${entry.name}`, phase: "GRANT" as const,
    code: "CLAUDE_LAUNCH_DEPENDENCY_THROWN", layer: "GRANT", opens: 0, make: entry.make,
  })),
  ...REGISTRATION_PHASES.flatMap((phase) => REGISTRATION_HOSTILE.map((entry) => ({
    name: `the ${phase} registration port ${entry.name}`, phase,
    code: "CLAUDE_LAUNCH_LOCK_UNKNOWN", layer: "LAUNCH_LOCK",
    opens: phase === "STARTED" ? 1 : 0, make: entry.make,
  }))),
];

describe("durable authority containment", () => {
  it("generates every hostile-fulfilment case it claims to sweep", () => {
    expect(MATRIX.length).toBe(22);
    expect(new Set(MATRIX.map((entry) => entry.name)).size).toBe(22);
    expect(MATRIX.filter((entry) => entry.phase === "GRANT").length).toBe(8);
    expect(MATRIX.filter((entry) => entry.opens === 1).length).toBe(7);
  });

  it.each(MATRIX)("fails closed when $name", async (entry) => {
    const trace: string[] = [];
    const grants = durableGrants(
      { ...COMMIT.grant },
      entry.phase === "GRANT" ? () => entry.make(ECHO_REGISTRATION) : () => PASS,
    );
    const regs = durableRegistrations((commit) =>
      commit.phase === entry.phase ? entry.make(commit.registration) : PASS);
    const launch = createClaudeLauncher(authorityOf(grants, regs));
    const result = await launch(request(), { deps: tracedDeps(boundaryHarness(), trace) });
    expect(failureOf(result)).toEqual({ code: entry.code, layer: entry.layer });
    expect(trace.filter((event) => event === "open").length).toBe(entry.opens);
    if (entry.opens === 1) {
      expect(trace.includes("close")).toBe(true);
      expect(trace.indexOf("close")).toBeLessThan(trace.indexOf("unlock"));
    }
    expectNoSecretEcho(result);
  });

  it("marks a durable registration whose process identity drifted as unproven", async () => {
    const grants = durableGrants();
    const regs = durableRegistrations((commit) => commit.phase === "STARTED"
      ? Object.freeze({ kind: "REGISTERED", ok: true, registration: {
          ...commit.registration, processIdentity: "windows:9999:1" } })
      : PASS);
    const launch = createClaudeLauncher(authorityOf(grants, regs));
    const result = await launch(request(), { deps: dependencies(boundaryHarness(), []) });
    expect(result.kind).toBe("OBSERVED");
    if (result.kind !== "OBSERVED") throw new Error("expected observation");
    expect({ truth: result.truthClass, code: result.code, layer: result.layer }).toEqual({
      truth: "UNKNOWN", code: "PROCESS_BOUNDARY_IDENTITY_UNPROVEN",
      layer: "WINDOWS_PROCESS_TRANSPORT",
    });
    expect(result.registration.processIdentity).toBe("windows:9999:1");
  });
});

const UNUSABLE_AUTHORITIES: readonly { readonly name: string; readonly authority: unknown }[] = [
  { name: "null", authority: null },
  { name: "a primitive", authority: "authority" },
  { name: "a proxy", authority: new Proxy({
    consumeGrantDurably: () => undefined, commitProcessRegistration: () => undefined }, {}) },
  { name: "an absent consume port", authority: { commitProcessRegistration: () => undefined } },
  { name: "an absent commit port", authority: { consumeGrantDurably: () => undefined } },
  { name: "a non-function consume port",
    authority: { consumeGrantDurably: 7, commitProcessRegistration: () => undefined } },
  { name: "a getter-backed consume port", authority: Object.defineProperty(
    { commitProcessRegistration: () => undefined }, "consumeGrantDurably",
    { get: () => () => undefined, configurable: true, enumerable: true }) },
];

describe("durable authority construction", () => {
  it("sweeps every unusable-authority shape it claims to", () => {
    expect(UNUSABLE_AUTHORITIES.length).toBe(7);
  });

  it.each(UNUSABLE_AUTHORITIES)("refuses $name without reaching a port", async (entry) => {
    const trace: string[] = [];
    const launch = createClaudeLauncher(entry.authority);
    const result = await launch(request(), { deps: dependencies(boundaryHarness(), trace) });
    expect(failureOf(result)).toEqual({
      code: "CLAUDE_LAUNCH_AUTHORITY_UNUSABLE", layer: "LAUNCHER",
    });
    expect(trace).toEqual([]);
    expectNoSecretEcho(result);
  });

  it("accepts an authority whose ports live on a class prototype", async () => {
    class DaemonAuthority {
      readonly grants = durableGrants();
      readonly regs = durableRegistrations();
      consumeGrantDurably(grant: unknown, wrapperIdentity: unknown): unknown {
        return this.grants.consumeGrantDurably(grant, wrapperIdentity);
      }
      commitProcessRegistration(commit: ClaudeRegistrationCommit): unknown {
        return this.regs.commitProcessRegistration(commit);
      }
    }
    const authority = new DaemonAuthority();
    const launch = createClaudeLauncher(authority);
    const result = await launch(request(), { deps: dependencies(boundaryHarness(), []) });
    expect(result.kind).toBe("OBSERVED");
    expect(authority.grants.calls.length).toBe(1);
    expect(authority.regs.commits.map((commit) => commit.phase))
      .toEqual(["PREFLIGHT", "STARTED"]);
  });

  it("binds both capabilities once, so later mutation cannot redirect authority", async () => {
    const grants = durableGrants();
    const regs = durableRegistrations();
    const authority: Record<string, unknown> = { ...authorityOf(grants, regs) };
    const launch = createClaudeLauncher(authority);
    const swapped = (): never => { throw new Error("swapped after construction"); };
    authority["consumeGrantDurably"] = swapped;
    authority["commitProcessRegistration"] = swapped;
    const result = await launch(request(), { deps: dependencies(boundaryHarness(), []) });
    expect(result.kind).toBe("OBSERVED");
    expect(grants.calls.length).toBe(1);
    expect(regs.commits.length).toBe(2);
  });

  /**
   * The phase classifier is pinned on the production function itself because its
   * third arm has no path through `launchClaude` today — both call sites build
   * their identity with the shared builders — and a guard nothing asserts is a
   * guard nobody notices going wrong.
   */
  it("classifies each identity format and refuses one it cannot name", () => {
    const base = { lockIdentity: CLAIM.lockIdentity, wrapperIdentity: CLAIM.wrapperIdentity,
      bootstrapCredentialDigest: DIGEST, registeredAt: AT };
    expect(classifyRegistrationPhase({ ...base, processIdentity: PENDING_IDENTITY }))
      .toBe("PREFLIGHT");
    expect(classifyRegistrationPhase({ ...base, processIdentity: STARTED_IDENTITY }))
      .toBe("STARTED");
    expect(classifyRegistrationPhase({ ...base, processIdentity: "pending:wrapper-other" }))
      .toBe(null);
    expect(classifyRegistrationPhase({ ...base, processIdentity: "linux:4242:1" })).toBe(null);
  });

  it("refuses an unclassifiable phase without calling the durable commit", () => {
    const commits: unknown[] = [];
    const port = durableRegistrationPort((commit) => { commits.push(commit); return commit; });
    const outcome = port({ lockIdentity: CLAIM.lockIdentity,
      wrapperIdentity: CLAIM.wrapperIdentity, processIdentity: "linux:4242:1",
      bootstrapCredentialDigest: DIGEST, registeredAt: AT }, CLAIM, null);
    expect(outcome).toMatchObject({
      kind: "REFUSED", failure: { code: "LAUNCH_LOCK_MALFORMED", layer: "LAUNCH_LOCK" },
    });
    expect(commits).toEqual([]);
  });

  it("hands the PURE lock refusal back verbatim, never reaching the durable commit", () => {
    const commits: unknown[] = [];
    const port = durableRegistrationPort((commit) => { commits.push(commit); return commit; });
    const outcome = port({ lockIdentity: "lock-other", wrapperIdentity: CLAIM.wrapperIdentity,
      processIdentity: STARTED_IDENTITY, bootstrapCredentialDigest: DIGEST,
      registeredAt: AT }, CLAIM, null);
    expect(outcome).toMatchObject({
      kind: "REFUSED", failure: { code: "LAUNCH_LOCK_IDENTITY_CONFLICT", layer: "LAUNCH_LOCK" },
    });
    expect(commits).toEqual([]);
  });

  /**
   * The overlay reads the caller's options with the launcher's own strict reader
   * instead of spreading them, because a spread of a hostile Proxy would run a
   * trap in the overlay's own frame and REJECT the returned promise — and a
   * launcher that rejects has escaped its whole contract. On anything the reader
   * refuses, the original options are forwarded so the launcher answers.
   */
  it("refuses hostile options with a result rather than a rejected promise", async () => {
    const grants = durableGrants();
    const regs = durableRegistrations();
    let fired = 0;
    const hostile = new Proxy({ platform: "win32" },
      { ownKeys: (): never => { fired += 1; throw new Error("hostile reflection trap"); } });
    const launch = createClaudeLauncher(authorityOf(grants, regs));
    const [settled] = await Promise.allSettled([launch(request(), hostile)]);
    expect(settled?.status).toBe("fulfilled");
    if (settled === undefined || settled.status !== "fulfilled") {
      throw new Error("the overlay rejected instead of refusing");
    }
    expect(failureOf(settled.value)).toEqual({
      code: "CLAUDE_LAUNCH_REQUEST_MALFORMED", layer: "LAUNCHER",
    });
    expect({ fired, grants: grants.calls.length, regs: regs.commits.length })
      .toEqual({ fired: 0, grants: 0, regs: 0 });
  });

  it("forwards unusable caller dependencies for the launcher itself to refuse", async () => {
    const trace: string[] = [];
    const grants = durableGrants();
    const regs = durableRegistrations();
    const complete = dependencies(boundaryHarness(), trace);
    const { observeProcess, ...incomplete } = complete;
    expect(typeof observeProcess).toBe("function");
    const launch = createClaudeLauncher(authorityOf(grants, regs));
    const result = await launch(request(),
      { deps: incomplete as unknown as ClaudeLauncherDependencies });
    expect(failureOf(result)).toEqual({
      code: "CLAUDE_LAUNCH_REQUEST_MALFORMED", layer: "LAUNCHER",
    });
    expect({ trace, grants: grants.calls.length, regs: regs.commits.length })
      .toEqual({ trace: [], grants: 0, regs: 0 });
  });

  it("refuses a non-Windows host before reaching the durable authority", async () => {
    const trace: string[] = [];
    const grants = durableGrants();
    const regs = durableRegistrations();
    const launch = createClaudeLauncher(authorityOf(grants, regs));
    const result = await launch(request(), {
      platform: "linux", deps: dependencies(boundaryHarness(), trace),
    });
    expect(failureOf(result)).toEqual({
      code: "CLAUDE_LAUNCH_PLATFORM_UNSUPPORTED", layer: "LAUNCHER",
    });
    expect({ trace, grants: grants.calls.length, regs: regs.commits.length })
      .toEqual({ trace: [], grants: 0, regs: 0 });
  });
});
