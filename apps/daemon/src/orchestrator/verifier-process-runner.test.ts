import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type { NodeMission } from "./agent-wrapper.js";
import {
  createVerifierProcessRunner,
  type VerifierProcessRunnerOptions,
} from "./verifier-process-runner.js";

interface FakeChild {
  readonly child: ChildProcess;
  readonly emitter: EventEmitter;
  readonly kill: ReturnType<typeof vi.fn>;
  readonly stderr: PassThrough;
  readonly stdout: PassThrough;
  readonly unref: ReturnType<typeof vi.fn>;
}

function fakeChild(pid: number | null = 1234): FakeChild {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kill = vi.fn();
  const unref = vi.fn();
  const child = Object.assign(emitter, {
    kill,
    pid: pid ?? undefined,
    stderr,
    stdin: null,
    stdout,
    unref,
  }) as unknown as ChildProcess;
  return { child, emitter, kill, stderr, stdout, unref };
}

const brief: NodeMission = {
  instructions: "verify it",
  test: "node verify.mjs",
  title: "verification",
  workspace: "/workspace/node-1",
};

const sha256 = (bytes: Buffer | string): string =>
  createHash("sha256").update(bytes).digest("hex");

describe("createVerifierProcessRunner", () => {
  it("passes only a minimal runtime allowlist to the test process", async () => {
    const fake = fakeChild();
    let options: SpawnOptions | undefined;
    const runner = createVerifierProcessRunner({
      environment: {
        ALL_PROXY: "http://proxy-user:proxy-pass@proxy.test",
        ANTHROPIC_API_KEY: "provider-secret",
        AWS_SECRET_ACCESS_KEY: "cloud-secret",
        DATABASE_URL: "sqlite:///operator-store",
        HTTPS_PROXY: "http://proxy.test",
        LANG: "C.UTF-8",
        MOE_DAEMON_CREDENTIAL: "operator-secret",
        MOE_PROJECT_ID: "project-secret",
        MOE_STORE_PATH: "/operator/store.db",
        NO_PROXY: "internal.test",
        OPENAI_API_KEY: "other-provider-secret",
        OPERATOR_CREDENTIAL: "second-operator-secret",
        Path: "/safe/runtime/bin",
        TMPDIR: "/safe/tmp",
      },
      platform: "linux",
      spawn: (_file, _args, received) => {
        options = received;
        return fake.child;
      },
      timeoutMs: 10_000,
    });

    const done = runner(brief);
    fake.stdout.write("ok");
    fake.emitter.emit("close", 0);

    await expect(done).resolves.toEqual({
      byteCount: 2,
      exitCode: 0,
      output: "ok",
      sha256: sha256("ok"),
    });
    expect(options).toMatchObject({
      cwd: brief.workspace,
      detached: true,
      env: { LANG: "C.UTF-8", Path: "/safe/runtime/bin", TMPDIR: "/safe/tmp" },
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(options?.env).toEqual({
      LANG: "C.UTF-8",
      Path: "/safe/runtime/bin",
      TMPDIR: "/safe/tmp",
    });
  });

  it("hashes every raw output byte while retaining only the bounded tail", async () => {
    const fake = fakeChild();
    const runner = createVerifierProcessRunner({
      outputTailBytes: 5,
      spawn: () => fake.child,
      timeoutMs: 10_000,
    });

    const done = runner(brief);
    const chunks = [Buffer.from("prefix-"), Buffer.from([0xff]), Buffer.from("TAIL!")];
    fake.stdout.write(chunks[0]);
    fake.stderr.write(chunks[1]);
    fake.stdout.write(chunks[2]);
    fake.emitter.emit("close", 7);

    await expect(done).resolves.toEqual({
      byteCount: Buffer.concat(chunks).byteLength,
      exitCode: 7,
      output: "TAIL!",
      sha256: sha256(Buffer.concat(chunks)),
    });
  });

  it("settles on the observed exit when a straggler keeps stdio open past the drain grace", async () => {
    vi.useFakeTimers();
    const fake = fakeChild(4321);
    const kills: { pid: number; signal: NodeJS.Signals }[] = [];
    const runner = createVerifierProcessRunner({
      drainGraceMs: 30,
      killProcessGroup: (pid, signal) => { kills.push({ pid, signal }); },
      platform: "linux",
      spawn: () => fake.child,
      timeoutMs: 10_000,
    });
    try {
      const done = runner(brief);
      let settled = false;
      void done.finally(() => { settled = true; }).catch(() => undefined);
      fake.stdout.write("ok");
      // "node server.js & npm run e2e": the shell exits 0 while the server
      // it backgrounded still holds the inherited pipes, so close never comes.
      fake.emitter.emit("exit", 0, null);
      await vi.advanceTimersByTimeAsync(29);
      expect(settled).toBe(false);
      expect(kills).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      expect(kills).toEqual([{ pid: -4321, signal: "SIGKILL" }]);
      expect(fake.stdout.destroyed).toBe(true);
      expect(fake.stderr.destroyed).toBe(true);
      await expect(done).resolves.toEqual({
        byteCount: 2,
        exitCode: 0,
        output: "ok",
        sha256: sha256("ok"),
      });

      // The real close arrives once the pipes are released; it cannot
      // settle the capture a second time.
      expect(() => fake.emitter.emit("close", 0, null)).not.toThrow();
      expect(runner.activeCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("swallows an ESRCH straggler signal after exit: the verdict already landed", async () => {
    vi.useFakeTimers();
    const fake = fakeChild(4321);
    const runner = createVerifierProcessRunner({
      drainGraceMs: 30,
      killProcessGroup: () => {
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      },
      platform: "linux",
      spawn: () => fake.child,
      timeoutMs: 10_000,
    });
    try {
      const done = runner(brief);
      fake.emitter.emit("exit", 3, null);
      await vi.advanceTimersByTimeAsync(30);
      await expect(done).resolves.toMatchObject({ exitCode: 3 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("never runs taskkill against the stale pid of an exited Windows recipe", async () => {
    vi.useFakeTimers();
    const fake = fakeChild(8765);
    const calls: string[] = [];
    const runner = createVerifierProcessRunner({
      drainGraceMs: 30,
      environment: { SYSTEMROOT: "C:\\Windows" },
      platform: "win32",
      spawn: (file) => {
        calls.push(file);
        return fake.child;
      },
      timeoutMs: 10_000,
    });
    try {
      const done = runner(brief);
      fake.emitter.emit("exit", 0, null);
      await vi.advanceTimersByTimeAsync(30);
      await expect(done).resolves.toMatchObject({ exitCode: 0 });
      expect(calls).toEqual([brief.test]);
      expect(fake.kill).not.toHaveBeenCalled();
      expect(fake.stdout.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a close inside the drain grace settle the capture without a straggler signal", async () => {
    vi.useFakeTimers();
    const fake = fakeChild(4321);
    const kills: number[] = [];
    const runner = createVerifierProcessRunner({
      drainGraceMs: 30,
      killProcessGroup: (pid) => { kills.push(pid); },
      platform: "linux",
      spawn: () => fake.child,
      timeoutMs: 10_000,
    });
    try {
      const done = runner(brief);
      fake.emitter.emit("exit", 2, null);
      await vi.advanceTimersByTimeAsync(10);
      fake.stdout.write("late");
      fake.emitter.emit("close", 2, null);
      await expect(done).resolves.toEqual({
        byteCount: 4,
        exitCode: 2,
        output: "late",
        sha256: sha256("late"),
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(kills).toEqual([]);
      expect(fake.stdout.destroyed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records the observed exit when the deadline reaches a dead leader mid-drain", async () => {
    vi.useFakeTimers();
    const fake = fakeChild(4321);
    const kills: number[] = [];
    const runner = createVerifierProcessRunner({
      drainGraceMs: 50,
      killGraceMs: 30,
      killProcessGroup: (pid) => { kills.push(pid); },
      platform: "linux",
      spawn: () => fake.child,
      timeoutMs: 20,
    });
    try {
      const done = runner(brief);
      await vi.advanceTimersByTimeAsync(10);
      fake.emitter.emit("exit", 0, null);
      // The deadline lands before the drain grace: the recipe exited inside
      // the deadline, so the capture keeps that exit rather than a kill's null.
      await vi.advanceTimersByTimeAsync(10);
      await expect(done).resolves.toMatchObject({ exitCode: 0 });
      expect(kills).toEqual([-4321]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels an exited-but-unclosed verifier immediately with a group signal", async () => {
    vi.useFakeTimers();
    const fake = fakeChild(4321);
    const kills: number[] = [];
    const runner = createVerifierProcessRunner({
      drainGraceMs: 50,
      killGraceMs: 30,
      killProcessGroup: (pid) => { kills.push(pid); },
      platform: "linux",
      spawn: () => fake.child,
      timeoutMs: 10_000,
    });
    try {
      const running = runner(brief);
      const cancelled = running.catch((error: unknown) => error);
      fake.emitter.emit("exit", 0, null);
      const closing = runner.close();
      expect(kills).toEqual([-4321]);
      expect(await cancelled).toMatchObject({ code: "VERIFIER_PROCESS_CANCELLED" });
      await expect(closing).resolves.toBeUndefined();
      expect(fake.stdout.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces a POSIX group-kill failure on cancel even after the leader exited", async () => {
    vi.useFakeTimers();
    const fake = fakeChild(4321);
    const runner = createVerifierProcessRunner({
      drainGraceMs: 50,
      killProcessGroup: () => { throw new Error("EPERM"); },
      platform: "linux",
      spawn: () => fake.child,
      timeoutMs: 10_000,
    });
    try {
      const running = runner(brief);
      const rejected = running.catch((error: unknown) => error);
      fake.emitter.emit("exit", 0, null);
      const closing = runner.close().catch((error: unknown) => error);
      expect(await rejected).toMatchObject({
        code: "VERIFIER_PROCESS_CONTAINMENT_FAILED",
        reason: "TREE_KILL_FAILED",
      });
      expect(await closing).toMatchObject({ reason: "TREE_KILL_FAILED" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps CLOSE_NOT_OBSERVED for a live leader: an exit after SIGKILL settles the kill outcome", async () => {
    vi.useFakeTimers();
    const fake = fakeChild(4321);
    const runner = createVerifierProcessRunner({
      drainGraceMs: 100,
      killGraceMs: 30,
      killProcessGroup: () => undefined,
      platform: "linux",
      spawn: () => fake.child,
      timeoutMs: 20,
    });
    try {
      const done = runner(brief);
      await vi.advanceTimersByTimeAsync(20);
      // The leader died under the group signal; a grandchild that left the
      // group still pins the pipes, so close never arrives.
      fake.emitter.emit("exit", null, "SIGKILL");
      await vi.advanceTimersByTimeAsync(30);
      await expect(done).resolves.toEqual({
        byteCount: 0,
        exitCode: null,
        output: "",
        sha256: sha256(""),
      });
      expect(fake.stdout.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for close after a POSIX timeout before returning a failed capture", async () => {
    vi.useFakeTimers();
    const fake = fakeChild(4321);
    const kills: { pid: number; signal: NodeJS.Signals }[] = [];
    const runner = createVerifierProcessRunner({
      killProcessGroup: (pid, signal) => { kills.push({ pid, signal }); },
      killGraceMs: 30,
      platform: "linux",
      spawn: () => fake.child,
      timeoutMs: 20,
    });
    try {
      const done = runner(brief);
      let settled = false;
      void done.finally(() => { settled = true; }).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(20);
      expect(kills).toEqual([{ pid: -4321, signal: "SIGKILL" }]);
      expect(settled).toBe(false);

      fake.emitter.emit("close", null, "SIGKILL");
      await expect(done).resolves.toEqual({
        byteCount: 0,
        exitCode: null,
        output: "",
        sha256: sha256(""),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects fatally when close never confirms POSIX process-tree death", async () => {
    vi.useFakeTimers();
    const fake = fakeChild(4321);
    const runner = createVerifierProcessRunner({
      killGraceMs: 30,
      killProcessGroup: () => undefined,
      platform: "linux",
      spawn: () => fake.child,
      timeoutMs: 20,
    });
    try {
      const done = runner(brief);
      const rejected = done.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(50);
      expect(await rejected).toMatchObject({
        code: "VERIFIER_PROCESS_CONTAINMENT_FAILED",
        reason: "CLOSE_NOT_OBSERVED",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("pins Windows taskkill and surfaces its error as fatal containment failure", async () => {
    vi.useFakeTimers();
    const testProcess = fakeChild(8765);
    const taskkill = fakeChild(9876);
    const calls: { args: readonly string[]; file: string; options: SpawnOptions }[] = [];
    const spawn: NonNullable<VerifierProcessRunnerOptions["spawn"]> =
      (file, args, options) => {
        calls.push({ args, file, options });
        if (!file.endsWith("taskkill.exe")) return testProcess.child;
        queueMicrotask(() => taskkill.emitter.emit("error", new Error("taskkill unavailable")));
        return taskkill.child;
      };
    const runner = createVerifierProcessRunner({
      environment: { SYSTEMROOT: "C:\\Windows" },
      killGraceMs: 30,
      platform: "win32",
      spawn,
      timeoutMs: 20,
    });
    try {
      const done = runner(brief);
      const rejected = done.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(20);
      await vi.runAllTicks();
      expect(calls).toHaveLength(2);
      expect(calls[0]?.options).toMatchObject({ detached: false });
      expect(calls[1]).toMatchObject({
        args: ["/pid", "8765", "/T", "/F"],
        file: "C:\\Windows\\System32\\taskkill.exe",
        options: { stdio: "ignore", windowsHide: true },
      });
      expect(taskkill.unref).toHaveBeenCalled();
      testProcess.emitter.emit("close", null, "SIGKILL");
      expect(await rejected).toMatchObject({
        code: "VERIFIER_PROCESS_CONTAINMENT_FAILED",
        reason: "TREE_KILL_FAILED",
      });
      expect(taskkill.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats taskkill's no-running-instance exit as confirmed containment, not an escape", async () => {
    vi.useFakeTimers();
    const testProcess = fakeChild(8765);
    const taskkill = fakeChild(9876);
    const followUp = fakeChild(7654);
    let recipes = 0;
    const spawn: NonNullable<VerifierProcessRunnerOptions["spawn"]> = (file) => {
      if (file.endsWith("taskkill.exe")) return taskkill.child;
      recipes += 1;
      return recipes === 1 ? testProcess.child : followUp.child;
    };
    const runner = createVerifierProcessRunner({
      environment: { SYSTEMROOT: "C:\\Windows" },
      killGraceMs: 30,
      platform: "win32",
      spawn,
      timeoutMs: 20,
    });
    try {
      const done = runner(brief);
      await vi.advanceTimersByTimeAsync(20);

      // The recipe exits in the same instant the killer lands, so taskkill
      // finds no running instance and reports 128 instead of 0. An already-
      // dead tree is the timed-out capture, not a containment failure.
      taskkill.emitter.emit("close", 128, null);
      testProcess.emitter.emit("close", null, "SIGKILL");
      await expect(done).resolves.toEqual({
        byteCount: 0,
        exitCode: null,
        output: "",
        sha256: sha256(""),
      });

      // The runner stayed open: the next run is admitted, not refused closed.
      const later = runner(brief);
      followUp.emitter.emit("close", 0);
      await expect(later).resolves.toMatchObject({ exitCode: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats any nonzero taskkill exit as confirmed containment once the recipe provably closed", async () => {
    vi.useFakeTimers();
    const testProcess = fakeChild(8765);
    const taskkill = fakeChild(9876);
    const followUp = fakeChild(7654);
    let recipes = 0;
    const spawn: NonNullable<VerifierProcessRunnerOptions["spawn"]> = (file) => {
      if (file.endsWith("taskkill.exe")) return taskkill.child;
      recipes += 1;
      return recipes === 1 ? testProcess.child : followUp.child;
    };
    const runner = createVerifierProcessRunner({
      environment: { SYSTEMROOT: "C:\\Windows" },
      killGraceMs: 30,
      platform: "win32",
      spawn,
      timeoutMs: 20,
    });
    try {
      const done = runner(brief);
      await vi.advanceTimersByTimeAsync(20);

      // Not the 128 arm: taskkill reports a garden-variety failure, but the
      // recipe has already provably closed — the same proof of an already-
      // dead tree. Only a LIVE recipe turns a failed killer fatal.
      testProcess.emitter.emit("close", null, "SIGKILL");
      taskkill.emitter.emit("close", 1, null);
      await expect(done).resolves.toEqual({
        byteCount: 0,
        exitCode: null,
        output: "",
        sha256: sha256(""),
      });

      // The runner stayed open: the next run is admitted, not refused closed.
      const later = runner(brief);
      followUp.emitter.emit("close", 0);
      await expect(later).resolves.toMatchObject({ exitCode: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces a POSIX group-kill failure despite direct-child close", async () => {
    vi.useFakeTimers();
    const fake = fakeChild(4321);
    const runner = createVerifierProcessRunner({
      killGraceMs: 30,
      killProcessGroup: () => { throw new Error("EPERM"); },
      platform: "linux",
      spawn: () => fake.child,
      timeoutMs: 20,
    });
    try {
      const done = runner(brief);
      const rejected = done.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(20);
      fake.emitter.emit("close", null, "SIGKILL");
      expect(await rejected).toMatchObject({
        code: "VERIFIER_PROCESS_CONTAINMENT_FAILED",
        reason: "TREE_KILL_FAILED",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats an ESRCH group kill as an already-dead tree, not fatal containment", async () => {
    vi.useFakeTimers();
    const fake = fakeChild(4321);
    const followUp = fakeChild(5678);
    let spawned = 0;
    const runner = createVerifierProcessRunner({
      killGraceMs: 30,
      // The group leader exited before the signal landed: the kernel reports
      // ESRCH, which proves the tree is gone rather than out of reach.
      killProcessGroup: () => {
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      },
      platform: "linux",
      spawn: () => {
        spawned += 1;
        return spawned === 1 ? fake.child : followUp.child;
      },
      timeoutMs: 20,
    });
    try {
      const done = runner(brief);
      await vi.advanceTimersByTimeAsync(20);
      fake.emitter.emit("close", null, "SIGKILL");
      await expect(done).resolves.toEqual({
        byteCount: 0,
        exitCode: null,
        output: "",
        sha256: sha256(""),
      });

      // The runner stayed open: the next run is admitted, not refused closed.
      const later = runner(brief);
      followUp.emitter.emit("close", 0);
      await expect(later).resolves.toMatchObject({ exitCode: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the containment rejection authoritative when a fatal observer throws", async () => {
    vi.useFakeTimers();
    const fake = fakeChild(4321);
    const runner = createVerifierProcessRunner({
      killProcessGroup: () => { throw new Error("EPERM"); },
      onFatalContainment: () => { throw new Error("observer failed"); },
      platform: "linux",
      spawn: () => fake.child,
      timeoutMs: 20,
    });
    try {
      const done = runner(brief);
      const rejected = done.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(20);
      expect(await rejected).toMatchObject({
        code: "VERIFIER_PROCESS_CONTAINMENT_FAILED",
        reason: "TREE_KILL_FAILED",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("close cancels an owned verifier without turning shutdown into a failed review", async () => {
    vi.useFakeTimers();
    const fake = fakeChild(4321);
    const kills: number[] = [];
    const runner = createVerifierProcessRunner({
      killGraceMs: 30,
      killProcessGroup: (pid) => { kills.push(pid); },
      platform: "linux",
      spawn: () => fake.child,
      timeoutMs: 10_000,
    });
    try {
      const running = runner(brief);
      const cancelled = running.catch((error: unknown) => error);
      const closing = runner.close();
      expect(kills).toEqual([-4321]);
      expect(runner.activeCount()).toBe(1);
      await expect(runner(brief)).rejects.toThrowError("VERIFIER_PROCESS_RUNNER_CLOSED");

      fake.emitter.emit("close", null, "SIGKILL");
      expect(await cancelled).toMatchObject({ code: "VERIFIER_PROCESS_CANCELLED" });
      await expect(closing).resolves.toBeUndefined();
      expect(runner.activeCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("turns synchronous and asynchronous spawn failures into failed captures", async () => {
    const synchronous = createVerifierProcessRunner({
      spawn: () => { throw new Error("spawn refused"); },
    });
    await expect(synchronous(brief)).resolves.toEqual({
      byteCount: 0,
      exitCode: null,
      output: "",
      sha256: sha256(""),
    });

    const fake = fakeChild(null);
    const asynchronous = createVerifierProcessRunner({
      spawn: () => fake.child,
      timeoutMs: 10_000,
    });
    const done = asynchronous(brief);
    fake.emitter.emit("error", new Error("ENOENT"));
    await expect(done).resolves.toMatchObject({ byteCount: 0, exitCode: null });

    // Later child events and output cannot digest or resolve the capture again.
    expect(() => {
      fake.emitter.emit("close", 1);
      fake.emitter.emit("error", new Error("late error"));
      fake.stdout.write("late output");
    }).not.toThrow();
  });

  /**
   * The host the delivery arms measure against: two keys the private allowlist admits and three
   * it does not, one of which (`DATABASE_URL`) is also the NAME an operator is most likely to
   * deliver - so the arms below can tell "arrived because it was delivered" apart from "arrived
   * because the filter let the host copy through".
   */
  const deliveryHost: NodeJS.ProcessEnv = {
    ANTHROPIC_API_KEY: "provider-secret",
    DATABASE_URL: "sqlite:///host-copy-never-delivered",
    HOST_ONLY_SECRET: "host-secret-never-delivered",
    LANG: "C.UTF-8",
    MOE_DAEMON_CREDENTIAL: "operator-secret",
    TMPDIR: "/safe/tmp",
  };

  const spawnedEnvironment = async (
    options: VerifierProcessRunnerOptions,
  ): Promise<NodeJS.ProcessEnv | undefined> => {
    const fake = fakeChild();
    let seen: SpawnOptions | undefined;
    const runner = createVerifierProcessRunner({
      ...options,
      platform: "linux",
      spawn: (_file, _args, received) => { seen = received; return fake.child; },
      timeoutMs: 10_000,
    });
    const done = runner(brief);
    fake.emitter.emit("close", 0);
    await done;
    return seen?.env;
  };

  it("delivers an operator variable while still excluding every host key outside the allowlist", async () => {
    const environment = await spawnedEnvironment({
      delivered: { DATABASE_URL: "postgres://delivered", STRIPE_KEY: "sk_live_delivered" },
      environment: deliveryHost,
    });

    // THE PAIR, ON THE SAME CONSTRUCTED ENV. The exclusion half is the load-bearing one: an
    // assertion that the delivered variable arrived is equally satisfied by a runner that handed
    // the child `process.env` plus extras, which is the widened surface the closed roster exists
    // to prevent and the hardest kind of regression to notice in review. Set equality, so a key
    // this arm did not think to name cannot slip in either.
    expect(environment).toEqual({
      DATABASE_URL: "postgres://delivered",
      LANG: "C.UTF-8",
      STRIPE_KEY: "sk_live_delivered",
      TMPDIR: "/safe/tmp",
    });
    // Named individually too, so a failure says WHICH host secret escaped.
    expect(environment?.["HOST_ONLY_SECRET"]).toBeUndefined();
    expect(environment?.["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(environment?.["MOE_DAEMON_CREDENTIAL"]).toBeUndefined();
    // The host's own DATABASE_URL never reached the child; the DELIVERED value did.
    expect(environment?.["DATABASE_URL"]).not.toContain("host-copy-never-delivered");
  });

  it("cannot be made to displace an allowlisted runtime key", async () => {
    const environment = await spawnedEnvironment({
      // A delivered PATH would decide which `node` and which shell the daemon's own verifier
      // spawns. The allowlisted runtime value wins; `deliverEnvironment` reports the collision.
      delivered: { PATH: "/attacker/bin", TMPDIR: "/attacker/tmp" },
      environment: { ...deliveryHost, PATH: "/safe/bin" },
    });
    expect(environment?.["PATH"]).toBe("/safe/bin");
    expect(environment?.["TMPDIR"]).toBe("/safe/tmp");
  });

  it("builds a byte-identical environment when the project has no variables set", async () => {
    // DoD-4. Compared against the construction as it behaved BEFORE delivery existed - which is
    // what `delivered: undefined` still runs - rather than against "the spawn succeeded". This is
    // the arm that catches an unconditional overlay adding an empty object, an undefined-valued
    // key, or a re-ordered key set.
    // The expected shape is an ABSOLUTE literal, not `before`: comparing the new construction
    // against itself is satisfied by any overlay that is merely CONSISTENT. And the key roster is
    // asserted separately because `toEqual` and `JSON.stringify` both IGNORE undefined-valued
    // properties - an overlay that adds `SOMETHING: undefined` passes both and changes the object.
    const expected = { LANG: "C.UTF-8", TMPDIR: "/safe/tmp" };
    for (const delivered of [undefined, {}]) {
      const after = await spawnedEnvironment({ delivered, environment: deliveryHost });
      expect(after).toStrictEqual(expected);
      expect(Object.keys(after ?? {})).toEqual(["LANG", "TMPDIR"]); // ORDER and arity
    }
  });
});
