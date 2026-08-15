/**
 * The durable-authority overlay contract.
 *
 * The published symbols are imported from the bare specifier `@moe/runner`,
 * because a daemon composing this seam has no other way in: the package
 * `exports` map is exclusive, so a deep subpath does not resolve for it at all.
 * The fixtures below are relative because they are internal test data, not part
 * of the seam.
 *
 * `createClaudeLauncher` refuses caller-supplied dependencies, so a suite that
 * needs to script the eight non-authority ports uses `composeDurableLauncher` —
 * the same production composition the public factory runs, with the shipped
 * defaults as its base. That narrowing is deliberate: a public caller able to
 * hand in a whole dependency set would replace the runtime pin, the OS lock and
 * the Windows physical boundary while the factory still advertised them.
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

import { classifyRegistrationPhase, composeDurableLauncher,
  durableRegistrationPort } from "./claude-launcher-authority.js";
import { AT, PASS, PENDING_IDENTITY, STARTED_IDENTITY, authorityOf, composed, durableGrants,
  durableRegistrations, tracedDeps } from "./claude-launcher-authority-test-fixtures.js";
import { type LaunchLockRegistration } from "../../supervisor/launch-lock.js";
import {
  CLAIM, COMMIT, DIGEST, boundaryHarness, dependencies, failureOf, prepared, request,
} from "./claude-launcher-test-fixtures.js";

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
    const launch = composed(grants, regs, dependencies(boundaryHarness(), trace));
    const result = await launch(request());
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
    const launch = composed(grants, regs, tracedDeps(boundaryHarness(), trace));
    const result = await launch(request());
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
    const launch = composed(grants, regs, dependencies(boundaryHarness(), trace));
    const result = await launch(request());
    expect(failureOf(result)).toEqual({ code: "GRANT_ALREADY_CONSUMED", layer: "GRANT" });
    expect(trace).toEqual(["runtime", "validate"]);
    expect(regs.commits.length).toBe(0);
    expectNoSecretEcho(result);
  });

  it("refuses a forged grant with a code the default port cannot emit", async () => {
    const trace: string[] = [];
    const grants = durableGrants({ ...COMMIT.grant, grantId: "cd".repeat(32) });
    const regs = durableRegistrations();
    const launch = composed(grants, regs, dependencies(boundaryHarness(), trace));
    const result = await launch(request());
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
    const launch = composed(grants, regs, dependencies(boundaryHarness(), trace));
    const result = await launch(request());
    expect(failureOf(result)).toEqual({ code: "GRANT_WRAPPER_MISMATCH", layer: "GRANT" });
    expect(trace).toEqual(["runtime", "validate"]);
    expect(regs.commits.length).toBe(0);
    expectNoSecretEcho(result);
  });

  it("lets the PURE launch lock answer credential reuse before the injected port", async () => {
    const trace: string[] = [];
    const grants = durableGrants();
    const regs = durableRegistrations();
    const launch = composed(grants, regs, dependencies(boundaryHarness(), trace));
    const result = await launch(request({ priorRegistration: {
      lockIdentity: CLAIM.lockIdentity, wrapperIdentity: CLAIM.wrapperIdentity,
      processIdentity: STARTED_IDENTITY, bootstrapCredentialDigest: DIGEST, registeredAt: AT,
    } }));
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
    // Two launcher instances over ONE pair of durable stores: a restart is a new
    // process reading the rows the dead one wrote, not a second call on a live
    // object graph.
    const first = await composed(grants, regs, dependencies(boundaryHarness(), []))(request());
    expect(first.kind).toBe("OBSERVED");
    grants.rows.set(COMMIT.grant.grantId, { ...COMMIT.grant });
    const trace: string[] = [];
    const second = await composed(grants, regs, dependencies(boundaryHarness(), trace))(request());
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
    const exited = await launch(
      request({ duplicateDelivery: {
        claim: CLAIM, registration: null, lockState: "RELEASED", effectState: "ACTIVE",
      } }),
      { platform: "win32" },
    );
    expect(exited).toMatchObject({
      kind: "EXIT_BEFORE_LAUNCH", ok: true, launched: false, processIdentity: null,
    });
    const adopted = await launch(
      request({ duplicateDelivery: {
        claim: CLAIM, lockState: "HELD", effectState: "ACTIVE", registration: {
          lockIdentity: CLAIM.lockIdentity, wrapperIdentity: CLAIM.wrapperIdentity,
          processIdentity: STARTED_IDENTITY, bootstrapCredentialDigest: DIGEST,
          registeredAt: AT,
        },
      } }),
      { platform: "win32" },
    );
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
/** Built on call, never at module evaluation: the activation fixture is shared. */
const consumedArm = (): Record<string, unknown> => ({
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
  { name: "returns a native Promise", make: () => Promise.resolve(consumedArm()) },
  { name: "returns a thenable", make: () => thenable(consumedArm()) },
  { name: "returns a wrong kind", make: () => ({ ...consumedArm(), kind: "ADVANCED" }) },
  { name: "returns a false ok arm", make: () => ({ ...consumedArm(), ok: false }) },
  { name: "returns a versionDelta other than 1", make: () => ({ ...consumedArm(), versionDelta: 2 }) },
  { name: "returns a grant that does not parse", make: () => ({ ...consumedArm(), grant: { no: 1 } }) },
  { name: "returns a get-trapping proxy", make: () => getTrap({ ...consumedArm() }) },
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
      undefined,
      entry.phase === "GRANT" ? () => entry.make(ECHO_REGISTRATION) : () => PASS,
    );
    const regs = durableRegistrations((commit) =>
      commit.phase === entry.phase ? entry.make(commit.registration) : PASS);
    const launch = composed(grants, regs, tracedDeps(boundaryHarness(), trace));
    const result = await launch(request());
    expect(failureOf(result)).toEqual({ code: entry.code, layer: entry.layer });
    expect(trace.filter((event) => event === "open").length).toBe(entry.opens);
    if (entry.opens === 1) {
      expect(trace.includes("close")).toBe(true);
      expect(trace.indexOf("close")).toBeLessThan(trace.indexOf("unlock"));
    }
    expectNoSecretEcho(result);
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
    const launch = composeDurableLauncher(dependencies(boundaryHarness(), trace), entry.authority);
    const result = await launch(request());
    expect(failureOf(result)).toEqual({
      code: "CLAUDE_LAUNCH_AUTHORITY_UNUSABLE", layer: "LAUNCHER",
    });
    expect(trace).toEqual([]);
    expectNoSecretEcho(result);
  });

  it("refuses an unusable authority on the PUBLISHED factory too", async () => {
    const result = await createClaudeLauncher({ consumeGrantDurably: 7 })(request());
    expect(failureOf(result)).toEqual({
      code: "CLAUDE_LAUNCH_AUTHORITY_UNUSABLE", layer: "LAUNCHER",
    });
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
    // The assignment IS the assertion: a daemon-shaped class must satisfy the
    // published port interface, and if it stopped doing so this file would fail
    // to typecheck rather than merely fail an expectation.
    const published: ClaudeLauncherAuthority = authority;
    const launch = composeDurableLauncher(dependencies(boundaryHarness(), []), published);
    const result = await launch(request(), { platform: "win32" });
    expect(result.kind).toBe("OBSERVED");
    expect(authority.grants.calls.length).toBe(1);
    expect(authority.regs.commits.map((commit) => commit.phase))
      .toEqual(["PREFLIGHT", "STARTED"]);
  });

  it("binds both capabilities once, so later mutation cannot redirect authority", async () => {
    const grants = durableGrants();
    const regs = durableRegistrations();
    const authority: Record<string, unknown> = { ...authorityOf(grants, regs) };
    const launch = composeDurableLauncher(dependencies(boundaryHarness(), []), authority);
    const swapped = (): never => { throw new Error("swapped after construction"); };
    authority["consumeGrantDurably"] = swapped;
    authority["commitProcessRegistration"] = swapped;
    const result = await launch(request(), { platform: "win32" });
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
});

/**
 * The refusal a deps-bearing option set earns. The code is the launcher's
 * existing one for an inadmissible options record; the MESSAGE is pinned with it
 * because that is what separates this policy refusal from the launcher's other
 * REQUEST_MALFORMED arms. A dedicated code is deliberately NOT added this round:
 * the only file that could carry it, claude-launcher-contract.ts, holds another
 * task's uncommitted work, and committing it by pathspec would carry that work.
 */
const DEPENDENCIES_REFUSED = "the durable launcher composes its own shipped dependencies";

describe("the published launcher seam", () => {
  /**
   * The narrowing QA's probe forced: `deps` used to be merged UNDER the two
   * authority slots, so a public caller supplying all ten dependencies replaced
   * the runtime pin, the duplicate resolver, the OS lock, the Windows boundary,
   * the observation, the clock and the delay — every guarantee the factory
   * advertises — while keeping the durable seam's appearance.
   */
  it("refuses caller dependencies instead of replacing its shipped ports", async () => {
    const trace: string[] = [];
    const grants = durableGrants();
    const regs = durableRegistrations();
    const launch = createClaudeLauncher(authorityOf(grants, regs));
    const result = await launch(request(), { deps: dependencies(boundaryHarness(), trace) });
    expect(failureOf(result)).toEqual({
      code: "CLAUDE_LAUNCH_REQUEST_MALFORMED", layer: "LAUNCHER",
    });
    expect(refusalMessage(result)).toBe(DEPENDENCIES_REFUSED);
    expect({ trace, grants: grants.calls.length, regs: regs.commits.length })
      .toEqual({ trace: [], grants: 0, regs: 0 });
    expectNoSecretEcho(result);
  });

  it("refuses a partial dependency override just as flatly", async () => {
    const harness = boundaryHarness();
    const grants = durableGrants();
    const regs = durableRegistrations();
    const launch = createClaudeLauncher(authorityOf(grants, regs));
    const result = await launch(request(), {
      deps: { openBoundary: () => harness.boundary } as unknown as ClaudeLauncherDependencies,
    });
    expect(failureOf(result)).toEqual({
      code: "CLAUDE_LAUNCH_REQUEST_MALFORMED", layer: "LAUNCHER",
    });
    expect(refusalMessage(result)).toBe(DEPENDENCIES_REFUSED);
    expect(harness.requests).toEqual([]);
  });

  it("forwards an unusable composed dependency set for the launcher itself to refuse", async () => {
    const trace: string[] = [];
    const grants = durableGrants();
    const regs = durableRegistrations();
    const complete = dependencies(boundaryHarness(), trace);
    const { observeProcess, ...incomplete } = complete;
    expect(typeof observeProcess).toBe("function");
    const launch = composed(grants, regs, incomplete as unknown as ClaudeLauncherDependencies);
    const result = await launch(request());
    expect(failureOf(result)).toEqual({
      code: "CLAUDE_LAUNCH_REQUEST_MALFORMED", layer: "LAUNCHER",
    });
    // The LAUNCHER's own message, not the overlay's: this refusal must come from
    // the dependency reader downstream, or the overlay would be the layer that
    // decided and the delegated attribution would be a fiction.
    expect(refusalMessage(result)).toBe("the launcher dependency capabilities are unusable");
    expect({ trace, grants: grants.calls.length, regs: regs.commits.length })
      .toEqual({ trace: [], grants: 0, regs: 0 });
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
    expect(refusalMessage(settled.value)).not.toBe(DEPENDENCIES_REFUSED);
    expect({ fired, grants: grants.calls.length, regs: regs.commits.length })
      .toEqual({ fired: 0, grants: 0, regs: 0 });
  });

  it("refuses a non-Windows host before reaching the durable authority", async () => {
    const grants = durableGrants();
    const regs = durableRegistrations();
    const launch = createClaudeLauncher(authorityOf(grants, regs));
    const result = await launch(request(), { platform: "linux" });
    expect(failureOf(result)).toEqual({
      code: "CLAUDE_LAUNCH_PLATFORM_UNSUPPORTED", layer: "LAUNCHER",
    });
    expect({ grants: grants.calls.length, regs: regs.commits.length })
      .toEqual({ grants: 0, regs: 0 });
  });
});
