import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { acquireWindowsLaunchLock, resolveLaunchLockScope,
  type LaunchLockScope } from "./claude-launch-lock.js";
import { isSafeNativePromise } from "./claude-launcher-port-results.js";

const NAMESPACE_ENV = "MOE_CLAUDE_LAUNCH_LOCK_NAMESPACE";
const MODULE_URL = new URL("./claude-launch-lock.ts", import.meta.url).href;
const CHILD_TIMEOUT_MS = 30_000;
const SPIN_MS = 900;

/** Every child this file starts, killed in the afterEach on EVERY exit path. */
const children: ChildProcess[] = [];
/** Every sidecar root this file created. Never the default one — see afterEach. */
const scratchRoots = new Set<string>();
let namespaceCounter = 0;

/**
 * A pipe namespace nobody else can hold. `\\.\pipe\` is MACHINE-GLOBAL, so an
 * arm on the default namespace would contend with a live fleet launch for the
 * real mutex. No arm in this file writes the default namespace.
 */
function uniqueNamespace(): string {
  namespaceCounter += 1;
  return `lktest-${process.pid}-${namespaceCounter}-${Date.now()}`;
}
function useNamespace(): string {
  const namespace = uniqueNamespace();
  process.env[NAMESPACE_ENV] = namespace;
  const root = scopeFor("any").sidecarRoot;
  expect(root).not.toBe(join(tmpdir(), "moe-claude-launch-locks"));
  scratchRoots.add(root);
  return namespace;
}
function scopeFor(identity: string): LaunchLockScope {
  const scope = resolveLaunchLockScope(identity);
  if (scope === null) throw new Error("the test namespace did not resolve");
  return scope;
}
/** A PID from the ephemeral range that is not alive right now. */
function firstDeadPid(): number {
  for (let candidate = 40_000_000; ; candidate += 1) {
    try { process.kill(candidate, 0); } catch { return candidate; }
  }
}
function plantSidecar(scope: LaunchLockScope, body: string): void {
  mkdirSync(scope.sidecarRoot, { recursive: true });
  writeFileSync(scope.sidecarPath, body, "utf8");
}
function outcomeOf(result: Awaited<ReturnType<typeof acquireWindowsLaunchLock>>): string {
  return result.ok ? "ok" : `${result.code}@${result.layer}`;
}

/**
 * A holder in a SEPARATE PROCESS, running the production module itself.
 *
 * Rival and holder must never share an event loop: blocking the holder would
 * stall the rival's own timers and every timing would be an artifact. Node
 * strips types natively, so the child imports the production `.ts` directly —
 * nothing here reimplements the surface under test.
 */
function holderSource(namespace: string, identity: string, spinMs: number | null): string {
  return [
    `process.env[${JSON.stringify(NAMESPACE_ENV)}] = ${JSON.stringify(namespace)};`,
    `const mod = await import(${JSON.stringify(MODULE_URL)});`,
    `const held = await mod.acquireWindowsLaunchLock(${JSON.stringify(identity)});`,
    `if (!held.ok) { console.log("REFUSED " + held.code); process.exit(3); }`,
    `console.log("READY");`,
    spinMs === null ? `setInterval(() => {}, 1000);` : [
      `const until = Date.now() + ${spinMs};`,
      `while (Date.now() < until) { /* synchronous spin: alive, loop not pumping */ }`,
      `console.log("SPUN");`,
      `process.stdin.setEncoding("utf8");`,
      `process.stdin.on("data", async () => {`,
      `  await held.lease.release(); console.log("RELEASED"); process.exit(0); });`,
    ].join("\n"),
  ].join("\n");
}
interface Holder {
  readonly child: ChildProcess;
  readonly output: () => string;
  waitFor(needle: string): Promise<void>;
}
function startHolder(namespace: string, identity: string, spinMs: number | null): Holder {
  // `--input-type=module` is what makes the top-level `await import` above
  // legal; `-e` is CommonJS otherwise.
  const child = spawn(process.execPath,
    ["--input-type=module", "-e", holderSource(namespace, identity, spinMs)],
    { stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  let seen = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { seen += chunk; });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { seen += `STDERR:${chunk}`; });
  return {
    child, output: () => seen,
    waitFor: (needle) => new Promise<void>((resolve, reject) => {
      const startedAt = Date.now();
      const tick = setInterval(() => {
        if (seen.includes(needle)) { clearInterval(tick); resolve(); return; }
        if (Date.now() - startedAt > CHILD_TIMEOUT_MS) {
          clearInterval(tick);
          reject(new Error(`holder never printed ${needle}: ${seen}`));
        }
      }, 20);
    }),
  };
}
function exitOf(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.on("exit", (code) => resolve(code)));
}

afterEach(async () => {
  // Epic rail 4: anything this file starts, it stops — on the failure paths too.
  // A leaked child holding a machine-global pipe wedges the very lane this row
  // exists to unwedge.
  while (children.length > 0) {
    const child = children.pop();
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) continue;
    child.kill("SIGKILL");
    await exitOf(child);
  }
  delete process.env[NAMESPACE_ENV];
  for (const root of scratchRoots) {
    // Guarded, not merely intended: the DEFAULT root holds pre-existing `.lock`
    // residue that nothing in this file may reach.
    if (root === join(tmpdir(), "moe-claude-launch-locks")) continue;
    rmSync(root, { recursive: true, force: true });
  }
  scratchRoots.clear();
});

it("refuses non-Windows hosts before creating a filesystem socket", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (descriptor === undefined) throw new Error("platform descriptor is absent");
  useNamespace();
  let acquired: Awaited<ReturnType<typeof acquireWindowsLaunchLock>> | undefined;
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: "linux" });
    acquired = await acquireWindowsLaunchLock("unsupported-host");
    expect(acquired).toMatchObject({
      ok: false, code: "CLAUDE_LAUNCH_LOCK_UNKNOWN", layer: "LAUNCH_LOCK",
    });
  } finally {
    Object.defineProperty(process, "platform", descriptor);
    if (acquired?.ok) await acquired.lease.release();
  }
});

// A Win32 pipe is not a Unix-domain socket: SIGKILL releases only the former's name.
describe.skipIf(process.platform !== "win32")("the OS-exclusive Claude launch lock", () => {
  it("admits every acquire regardless of what the advisory sidecar records", async () => {
    useNamespace();
    const identity = `sidecar-variants-${process.pid}`;
    const scope = scopeFor(identity);
    const variants: ReadonlyArray<readonly [string, string | null]> = [
      ["alive pid", JSON.stringify({ pid: process.pid, identity, acquiredAt: "2020-01-01T00:00:00.000Z" })],
      ["dead pid", JSON.stringify({ pid: firstDeadPid(), identity, acquiredAt: "2020-01-01T00:00:00.000Z" })],
      ["malformed body", "{ this is not json"],
      ["no sidecar", null],
    ];
    const outcomes: string[] = [];
    for (const [, body] of variants) {
      rmSync(scope.sidecarPath, { force: true });
      if (body !== null) plantSidecar(scope, body);
      const acquired = await acquireWindowsLaunchLock(identity);
      outcomes.push(outcomeOf(acquired));
      if (acquired.ok) await acquired.lease.release();
    }
    // Mechanically checkable, not argued: an implementation that consulted the
    // recorded pid, its liveness or its age could not answer all four alike.
    expect(outcomes).toEqual(["ok", "ok", "ok", "ok"]);
    expect(variants).toHaveLength(4);
  });

  it("never wedges a FIXED, re-requestable identity such as lock-1", async () => {
    useNamespace();
    const scope = scopeFor("lock-1");
    plantSidecar(scope, JSON.stringify({
      pid: process.pid, identity: "lock-1", acquiredAt: "2020-01-01T00:00:00.000Z" }));
    const first = await acquireWindowsLaunchLock("lock-1");
    expect(outcomeOf(first)).toBe("ok");
    if (!first.ok) throw new Error("first acquire refused");
    await first.lease.release();
    const second = await acquireWindowsLaunchLock("lock-1");
    expect(outcomeOf(second)).toBe("ok");
    if (second.ok) await second.lease.release();
  });

  it("refuses a rival while the holder is ALIVE BUT STALLED, and the holder survives it",
    async () => {
      // The arm that retires the withdrawn wall-clock design. A staleness bound
      // reaps a holder whose heartbeat has lapsed — which is exactly this
      // holder — and would hand out a second lease here.
      const namespace = useNamespace();
      const identity = "lock-1";
      const holder = startHolder(namespace, identity, SPIN_MS);
      await holder.waitFor("READY");

      const rival = await acquireWindowsLaunchLock(identity);
      expect(rival).toMatchObject({
        ok: false, code: "LAUNCH_LOCK_IDENTITY_CONFLICT", layer: "LAUNCH_LOCK" });
      expect("lease" in rival).toBe(false);

      // The EPIPE regression probe. connect() succeeds against a stalled holder
      // (measured at 1ms), and a rival that hangs up immediately used to kill
      // the holder through its unhandled write error. Accept-and-drop never
      // writes, so the class cannot occur — and (iii) below is what proves it.
      await expect(new Promise<string>((resolve) => {
        const socket = connect(scopeFor(identity).pipeName);
        socket.on("connect", () => { socket.destroy(); resolve("connected"); });
        socket.on("error", (error: NodeJS.ErrnoException) => resolve(`error:${error.code}`));
      })).resolves.toBe("connected");

      await holder.waitFor("SPUN");
      expect(holder.child.exitCode).toBeNull();
      const afterSpin = await acquireWindowsLaunchLock(identity);
      expect(afterSpin).toMatchObject({
        ok: false, code: "LAUNCH_LOCK_IDENTITY_CONFLICT", layer: "LAUNCH_LOCK" });
      holder.child.stdin?.write("RELEASE\n");
      expect(await exitOf(holder.child)).toBe(0);
      expect(holder.output()).toContain("RELEASED");
    }, CHILD_TIMEOUT_MS * 2);

  it("excludes a live holder and reclaims from a killed one, consulting no record",
    async () => {
      const namespace = useNamespace();
      const identity = "lock-1";
      const holder = startHolder(namespace, identity, null);
      await holder.waitFor("READY");

      const rival = await acquireWindowsLaunchLock(identity);
      expect(rival).toMatchObject({
        ok: false, code: "LAUNCH_LOCK_IDENTITY_CONFLICT", layer: "LAUNCH_LOCK" });

      // TerminateProcess: no cleanup handler runs, no lease is released, and
      // the advisory sidecar is left exactly as the dead holder wrote it.
      holder.child.kill("SIGKILL");
      await exitOf(holder.child);
      // Deleting it before the next acquire pins "no pid, timestamp or timeout
      // was consulted": there is nothing left to consult.
      rmSync(scopeFor(identity).sidecarPath, { force: true });
      expect(existsSync(scopeFor(identity).sidecarPath)).toBe(false);

      // ONE call. No retry loop, no waiting, no reap.
      const reclaimed = await acquireWindowsLaunchLock(identity);
      expect(outcomeOf(reclaimed)).toBe("ok");
      if (reclaimed.ok) await reclaimed.lease.release();
    }, CHILD_TIMEOUT_MS * 2);

  it("releases through the native promise the lifecycle gate demands", async () => {
    useNamespace();
    const acquired = await acquireWindowsLaunchLock("lock-1");
    expect(outcomeOf(acquired)).toBe("ok");
    if (!acquired.ok) throw new Error("acquire refused");
    // The PRODUCTION guard, imported rather than restated: releaseLease at
    // claude-launcher-lifecycle.ts:290 gates on exactly this, so a thenable or
    // a hand-rolled wrapper would report CLAUDE_LAUNCH_LOCK_UNKNOWN on a
    // release that actually succeeded.
    const pending = acquired.lease.release();
    expect(isSafeNativePromise(pending)).toBe(true);
    await expect(pending).resolves.toBeUndefined();
    // Idempotent, and still native on the repeat.
    const repeated = acquired.lease.release();
    expect(isSafeNativePromise(repeated)).toBe(true);
    await expect(repeated).resolves.toBeUndefined();
  });

  it("proves the release even when the advisory sidecar cannot be removed", async () => {
    useNamespace();
    const acquired = await acquireWindowsLaunchLock("lock-1");
    expect(outcomeOf(acquired)).toBe("ok");
    if (!acquired.ok) throw new Error("acquire refused");
    // The sidecar is a DIAGNOSTIC. Removing it out from under the lease must
    // not turn a release that closed cleanly into an unproven one, because an
    // unproven release is reported as CLAUDE_LAUNCH_LOCK_UNKNOWN.
    rmSync(scopeFor("lock-1").sidecarPath, { force: true });
    await expect(acquired.lease.release()).resolves.toBeUndefined();
    const reacquired = await acquireWindowsLaunchLock("lock-1");
    expect(outcomeOf(reacquired)).toBe("ok");
    if (reacquired.ok) await reacquired.lease.release();
  });

  it("keeps the default sidecar root when the namespace variable is absent", () => {
    const prior = process.env[NAMESPACE_ENV];
    delete process.env[NAMESPACE_ENV];
    try {
      // The RESOLVED value is the whole claim. Acquiring here would put a
      // machine-global pipe on the fleet's namespace for no added coverage.
      expect(resolveLaunchLockScope("lock-1")?.sidecarRoot)
        .toBe(join(tmpdir(), "moe-claude-launch-locks"));
      expect(resolveLaunchLockScope("lock-1")?.namespace).toBe("moe-claude-launch");
    } finally { if (prior !== undefined) process.env[NAMESPACE_ENV] = prior; }
  });

  it("refuses an acquire on a namespace that could escape the pipe namespace", async () => {
    for (const invalid of [`bad${String.fromCharCode(92)}ns`, "x".repeat(65), "dots.are.out"]) {
      process.env[NAMESPACE_ENV] = invalid;
      expect(resolveLaunchLockScope("lock-1")).toBeNull();
      const refused = await acquireWindowsLaunchLock("lock-1");
      expect(refused).toMatchObject({
        ok: false, code: "CLAUDE_LAUNCH_LOCK_UNKNOWN", layer: "LAUNCH_LOCK" });
    }
  });
});
