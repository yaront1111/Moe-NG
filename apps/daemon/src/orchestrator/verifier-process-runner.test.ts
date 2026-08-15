import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import type { NodeMission } from "./agent-wrapper.js";
import {
  createVerifierProcessRunner,
  type VerifierProcessRunnerOptions,
} from "./verifier-process-runner.js";

interface FakeChild {
  readonly child: ChildProcess;
  readonly emitter: EventEmitter;
  readonly stderr: PassThrough;
  readonly stdout: PassThrough;
}

function fakeChild(pid = 1234): FakeChild {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(emitter, {
    pid,
    stderr,
    stdin: null,
    stdout,
  }) as unknown as ChildProcess;
  return { child, emitter, stderr, stdout };
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

  it("kills the POSIX process group and resolves even when no close follows", async () => {
    const fake = fakeChild(4321);
    const kills: { pid: number; signal: NodeJS.Signals }[] = [];
    const runner = createVerifierProcessRunner({
      killProcessGroup: (pid, signal) => { kills.push({ pid, signal }); },
      platform: "linux",
      spawn: () => fake.child,
      timeoutMs: 10,
    });

    await expect(runner(brief)).resolves.toEqual({
      byteCount: 0,
      exitCode: null,
      output: "",
      sha256: sha256(""),
    });
    expect(kills).toEqual([{ pid: -4321, signal: "SIGKILL" }]);
  });

  it("consumes a Windows taskkill error and still resolves the timeout", async () => {
    const testProcess = fakeChild(8765);
    const taskkill = fakeChild(9876);
    const calls: { args: readonly string[]; file: string; options: SpawnOptions }[] = [];
    const spawn: NonNullable<VerifierProcessRunnerOptions["spawn"]> =
      (file, args, options) => {
        calls.push({ args, file, options });
        if (file !== "taskkill") return testProcess.child;
        queueMicrotask(() => taskkill.emitter.emit("error", new Error("taskkill unavailable")));
        return taskkill.child;
      };
    const runner = createVerifierProcessRunner({
      platform: "win32",
      spawn,
      timeoutMs: 10,
    });

    await expect(runner(brief)).resolves.toMatchObject({ exitCode: null });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.options).toMatchObject({ detached: false });
    expect(calls[1]).toMatchObject({
      args: ["/pid", "8765", "/T", "/F"],
      file: "taskkill",
      options: { stdio: "ignore" },
    });
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

    const fake = fakeChild();
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
});
