/**
 * The durable ECHO contract: a success arm is only authority when it is the
 * success for the request that was issued.
 *
 * Decoding proves a record is individually well formed. It does not prove the
 * store answered about the same grant, or about the same lock. A store that
 * returns another activation's consumed grant, or a registration naming another
 * lock identity, passes every shape check and then drives the OS-exclusive lock
 * and the physical open under an identity nobody asked for. Every case below
 * therefore returns a record that decodes OK ON ITS OWN — asserted, not assumed —
 * and pins the exact refusal the overlay must produce instead.
 *
 * These run through `composeDurableLauncher`, the same production composition the
 * published `createClaudeLauncher` runs, with its eight non-authority ports
 * scripted. The public factory cannot be scripted by design: it refuses caller
 * dependencies so that no consumer can replace the Windows physical boundary
 * while the factory still advertises it (see the public-seam suite in
 * claude-launcher-authority.test.ts).
 */
import { describe, expect, it } from "vitest";

import { decodeGrant, decodeRegistration } from "./claude-launcher-port-results.js";
import { AT, PENDING_IDENTITY, PASS, STARTED_IDENTITY, composed, durableGrants,
  durableRegistrations, tracedDeps } from "./claude-launcher-authority-test-fixtures.js";
import { CLAIM, COMMIT, DIGEST, boundaryHarness, failureOf, prepared,
  request } from "./claude-launcher-test-fixtures.js";
import { type ClaudeLaunchRegistrationPhase } from "./claude-launcher-contract.js";
import { type ClaudeLaunchResult } from "./claude-launcher.js";
import { type LaunchLockRegistration } from "../../supervisor/launch-lock.js";

type Row = Record<string, unknown>;

/** A refusal may name a phase; it may never hand back the secrets it guarded. */
function expectNoSecretEcho(result: ClaudeLaunchResult): void {
  if (result.kind !== "REFUSED") throw new Error(`expected REFUSED, received ${result.kind}`);
  expect(result.message.includes(DIGEST)).toBe(false);
  expect(result.message.includes(COMMIT.grant.grantId)).toBe(false);
  expect(result.message.includes(prepared.executablePath)).toBe(false);
}

interface GrantEcho { readonly name: string; drift(consumed: Row): Row }
/**
 * One entry per field the one-use CAS must carry through unchanged, plus the
 * version transition itself. `drift` is a closure so the table never reads the
 * activation fixture at module evaluation.
 */
const GRANT_ECHOES: readonly GrantEcho[] = [
  { name: "another activation's grant id", drift: (grant) => ({ ...grant, grantId: "cd".repeat(32) }) },
  { name: "another intent", drift: (grant) => ({ ...grant, intentId: "intent-other" }) },
  { name: "another wrapper", drift: (grant) => ({ ...grant, wrapperIdentity: "wrapper-other" }) },
  { name: "a version two past the presented one",
    drift: (grant) => ({ ...grant, version: Number(grant["version"]) + 1 }) },
];

describe("durable grant echo binding", () => {
  it("sweeps every bound grant field it claims to", () => {
    expect(GRANT_ECHOES.length).toBe(4);
    expect(new Set(GRANT_ECHOES.map((entry) => entry.name)).size).toBe(4);
  });

  it.each(GRANT_ECHOES)("refuses a durable success naming $name", async (entry) => {
    const trace: string[] = [];
    const consumed = { ...COMMIT.grant, state: "CONSUMED", version: COMMIT.grant.version + 1 };
    const grants = durableGrants(undefined, () =>
      Object.freeze({ kind: "CONSUMED", ok: true, versionDelta: 1, grant: entry.drift(consumed) }));
    const regs = durableRegistrations();
    const launch = composed(grants, regs, tracedDeps(boundaryHarness(), trace));
    const result = await launch(request());
    // The substitution is well formed on its own: this is the case decoding alone
    // accepts, which is exactly why the relational check has to exist.
    expect(decodeGrant(grants.answers[0]).kind).toBe("OK");
    expect(failureOf(result)).toEqual({ code: "ACTIVATION_COMMIT_INCOHERENT", layer: "ACTIVATION" });
    expect(trace).toEqual(["runtime", "validate"]);
    expect(regs.commits.length).toBe(0);
    expectNoSecretEcho(result);
  });

  it("refuses a store that advances a grant the presented record already spent", async () => {
    const trace: string[] = [];
    const spent = { ...COMMIT.grant, state: "CONSUMED", version: COMMIT.grant.version + 1 };
    const grants = durableGrants(undefined, () =>
      Object.freeze({ kind: "CONSUMED", ok: true, versionDelta: 1,
        grant: { ...spent, version: spent.version + 1 } }));
    const regs = durableRegistrations();
    const launch = composed(grants, regs, tracedDeps(boundaryHarness(), trace));
    const result = await launch(request({ grant: spent }));
    expect(grants.calls.length).toBe(1);
    expect(decodeGrant(grants.answers[0]).kind).toBe("OK");
    expect(failureOf(result)).toEqual({ code: "GRANT_ALREADY_CONSUMED", layer: "GRANT" });
    expect(trace).toEqual(["runtime", "validate"]);
    expect(regs.commits.length).toBe(0);
    expectNoSecretEcho(result);
  });

  it("refuses a store that advances a grant bound to another wrapper", async () => {
    const trace: string[] = [];
    const consumed = { ...COMMIT.grant, state: "CONSUMED", version: COMMIT.grant.version + 1 };
    const grants = durableGrants(undefined, () =>
      Object.freeze({ kind: "CONSUMED", ok: true, versionDelta: 1, grant: consumed }));
    const regs = durableRegistrations();
    const launch = composed(grants, regs, tracedDeps(boundaryHarness(), trace));
    const result = await launch(request({ wrapperIdentity: "wrapper-other" }));
    expect(grants.calls.length).toBe(1);
    expect(decodeGrant(grants.answers[0]).kind).toBe("OK");
    expect(failureOf(result)).toEqual({ code: "GRANT_WRAPPER_MISMATCH", layer: "GRANT" });
    expect(trace).toEqual(["runtime", "validate"]);
    expect(regs.commits.length).toBe(0);
    expectNoSecretEcho(result);
  });

  it("accepts the exact CAS of the presented grant", async () => {
    const trace: string[] = [];
    const grants = durableGrants();
    const regs = durableRegistrations();
    const launch = composed(grants, regs, tracedDeps(boundaryHarness(), trace));
    const result = await launch(request());
    expect(result.kind).toBe("OBSERVED");
    if (result.kind !== "OBSERVED") throw new Error("expected observation");
    expect(result.consumedGrant).toEqual({ ...COMMIT.grant, state: "CONSUMED",
      version: COMMIT.grant.version + 1 });
  });
});

interface RegistrationEcho {
  readonly name: string;
  drift(registration: LaunchLockRegistration, phase: ClaudeLaunchRegistrationPhase): LaunchLockRegistration;
}
/** One entry per field of the registration the durable store must echo back. */
const REGISTRATION_ECHOES: readonly RegistrationEcho[] = [
  { name: "another lock identity",
    drift: (registration) => ({ ...registration, lockIdentity: "lock-other" }) },
  { name: "another wrapper identity",
    drift: (registration) => ({ ...registration, wrapperIdentity: "wrapper-other" }) },
  { name: "another process identity", drift: (registration, phase) => ({ ...registration,
    processIdentity: phase === "PREFLIGHT" ? "pending:attacker" : "windows:9999:1" }) },
  { name: "another bootstrap credential",
    drift: (registration) => ({ ...registration, bootstrapCredentialDigest: "cd".repeat(32) }) },
  { name: "another registration instant",
    drift: (registration) => ({ ...registration, registeredAt: "2026-08-12T09:00:00.000Z" }) },
];
const ECHO_PHASES: readonly ClaudeLaunchRegistrationPhase[] = ["PREFLIGHT", "STARTED"];
interface RegistrationCase extends RegistrationEcho {
  readonly phase: ClaudeLaunchRegistrationPhase;
  readonly opens: number;
}
const REGISTRATION_CASES: readonly RegistrationCase[] = ECHO_PHASES.flatMap((phase) =>
  REGISTRATION_ECHOES.map((entry) => ({
    ...entry, phase, opens: phase === "PREFLIGHT" ? 0 : 1,
    name: `${entry.name} at ${phase}`,
  })));

describe("durable registration echo binding", () => {
  it("sweeps every echoed registration field at both phases", () => {
    expect(REGISTRATION_ECHOES.length).toBe(5);
    expect(REGISTRATION_CASES.length).toBe(10);
    expect(new Set(REGISTRATION_CASES.map((entry) => entry.name)).size).toBe(10);
    expect(REGISTRATION_CASES.filter((entry) => entry.opens === 1).length).toBe(5);
  });

  it.each(REGISTRATION_CASES)("refuses a durable registration naming $name", async (entry) => {
    const trace: string[] = [];
    const grants = durableGrants();
    const regs = durableRegistrations((commit) => commit.phase !== entry.phase ? PASS
      : Object.freeze({ kind: "REGISTERED", ok: true,
        registration: entry.drift(commit.registration, entry.phase) }));
    const launch = composed(grants, regs, tracedDeps(boundaryHarness(), trace));
    const result = await launch(request());
    const answer = regs.answers[regs.answers.length - 1];
    expect(decodeRegistration(answer).kind).toBe("OK");
    expect(failureOf(result)).toEqual({
      code: "LAUNCH_LOCK_IDENTITY_CONFLICT", layer: "LAUNCH_LOCK",
    });
    expect(trace.filter((event) => event === "open").length).toBe(entry.opens);
    expectNoSecretEcho(result);
    if (entry.opens === 0) {
      // The substituted lock identity must never reach the OS-exclusive lock.
      expect(trace).toEqual(["runtime", "validate"]);
      return;
    }
    expect(trace.includes("observe")).toBe(false);
    expect(trace.indexOf("close")).toBeLessThan(trace.indexOf("unlock"));
  });

  it("acquires the lock the PURE registration named, not the one the store returned", async () => {
    const trace: string[] = [];
    const lockIdentities: unknown[] = [];
    const grants = durableGrants();
    const regs = durableRegistrations();
    const base = tracedDeps(boundaryHarness(), trace);
    const launch = composed(grants, regs, Object.freeze({ ...base,
      acquireLock: (lockIdentity: string): unknown => {
        lockIdentities.push(lockIdentity);
        return base.acquireLock(lockIdentity);
      } }));
    const result = await launch(request());
    expect(result.kind).toBe("OBSERVED");
    expect(lockIdentities).toEqual([CLAIM.lockIdentity]);
    expect(regs.commits.map((commit) => commit.registration.processIdentity))
      .toEqual([PENDING_IDENTITY, STARTED_IDENTITY]);
    expect(regs.rows.get(CLAIM.lockIdentity)?.registeredAt).not.toBe(AT);
  });
});
