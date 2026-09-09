import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { readFileSync as readSource } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { ChildProcess, SpawnOptions } from "node:child_process";

import { GH_EXECUTABLE, createGhReleasePrPort, ghPrArgv } from "./release-pr-port.js";
import type { ReleasePrRequest, SpawnGhProcess } from "./release-pr-port.js";

const CWD = "/tmp/workspace";
const REQUEST: ReleasePrRequest = {
  remoteUrl: "https://github.com/acme/widget.git",
  sha: "a".repeat(40),
  base: "main",
  body: "# Release dossier: widget\n\n- Goal: goal-1\n- Re-measured at sha: abc\n",
  head: "moe/goal-1",
  title: "Release goal-1",
};

/**
 * A ChildProcess stand-in. Events are emitted on `setImmediate` because the port attaches
 * its listeners AFTER `spawn` returns — emitting synchronously would fire into the void
 * and every arm would hang on the timeout instead of testing what it names.
 */
class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  public killed = false;
  public killSignals: string[] = [];
  kill(signal?: string): boolean {
    this.killed = true;
    this.killSignals.push(signal ?? "SIGTERM");
    return true;
  }
}

interface Capture {
  readonly argv: readonly string[];
  readonly bodyFileContent: string;
  readonly bodyFilePath: string;
  readonly child: FakeChild;
  readonly command: string;
  readonly options: SpawnOptions;
}

/**
 * Builds the injected spawn. `act` runs INSIDE the spawn call, so the body file is read
 * while it still exists — reading it after `open()` resolves would race the `finally`
 * cleanup and prove nothing about what `gh` would have seen.
 */
function fakeSpawn(
  act: (child: FakeChild) => void,
  view?: (child: FakeChild) => void,
): { readonly captured: Capture[]; readonly spawn: SpawnGhProcess } {
  const captured: Capture[] = [];
  const spawn: SpawnGhProcess = (command, args, options) => {
    const child = new FakeChild();
    const argv = [...args];
    const bodyIndex = argv.indexOf("--body-file");
    const bodyFilePath = bodyIndex < 0 ? "" : argv[bodyIndex + 1] ?? "";
    captured.push({
      argv,
      bodyFileContent: bodyFilePath === "" ? "" : readFileSync(bodyFilePath, "utf8"),
      bodyFilePath,
      child,
      command,
      options,
    });
    setImmediate(() => {
      if (argv[1] !== "view") { act(child); return; }
      if (view !== undefined) { view(child); return; }
      child.stdout.emit("data", JSON.stringify({ headRefOid: REQUEST.sha, headRefName: REQUEST.head,
        baseRefName: REQUEST.base, url: argv[2], state: "OPEN" }));
      child.emit("close", 0);
    });
    return child as unknown as ChildProcess;
  };
  return { captured, spawn };
}

describe("gh release pr port", () => {
  it.each(["moved", "wrong-base", "unreadable", "malformed"])("does not certify a created PR when its head proof is %s", async (failure) => {
    const { captured, spawn } = fakeSpawn(child => {
      child.stdout.emit("data", "https://github.com/acme/widget/pull/7\n");
      child.emit("close", 0);
    }, child => {
      child.stdout.emit("data", failure === "malformed" ? "{broken" : JSON.stringify({ url: "https://github.com/acme/widget/pull/7",
        headRefOid: failure === "moved" ? "b".repeat(40) : REQUEST.sha,
        headRefName: REQUEST.head, baseRefName: failure === "wrong-base" ? "other" : REQUEST.base,
        state: "OPEN" }));
      child.emit("close", failure === "unreadable" ? 1 : 0);
    });
    const result = await createGhReleasePrPort({ cwd: CWD, spawn,
      verifyHead: async () => true }).open(REQUEST);
    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error("unproven PR was certified");
    expect(result.stderrLastLine).toContain("https://github.com/acme/widget/pull/7");
    expect(captured[1]?.argv).toEqual(["pr", "view", "https://github.com/acme/widget/pull/7",
      "--repo", REQUEST.remoteUrl, "--json", "url,headRefOid,headRefName,baseRefName,state"]);
  });
  it("does not open a PR when the remote branch no longer names the approved SHA", async () => {
    const { captured, spawn } = fakeSpawn((child) => {
      child.stdout.emit("data", "https://github.com/acme/widget/pull/7\n");
      child.emit("close", 0);
    });
    const result = await createGhReleasePrPort({ cwd: CWD, spawn,
      verifyHead: async () => false }).open(REQUEST);
    expect(result).toMatchObject({ ok: false, stderrLastLine: "RELEASE_HEAD_CHANGED" });
    expect(captured).toHaveLength(0);
  });
  it("spawns the exact argv and hands gh the body BYTE FOR BYTE in a file", async () => {
    const { captured, spawn } = fakeSpawn((child) => {
      child.stdout.emit("data", "https://github.com/acme/widget/pull/7\n");
      child.emit("close", 0);
    });
    const result = await createGhReleasePrPort({ cwd: CWD, spawn, verifyHead: async () => true }).open(REQUEST);

    expect(captured).toHaveLength(2);
    const call = captured[0]!;
    // The bare name: Windows CreateProcess appends `.exe`, so gh.exe/gh.cmd would be wrong.
    expect(call.command).toBe(GH_EXECUTABLE);
    expect(call.command).toBe("gh");
    // Exact array equality, flag ORDER included — not a set, not a contains.
    expect(call.argv).toEqual([
      "pr", "create", "--repo", REQUEST.remoteUrl,
      "--base", "main",
      "--head", "moe/goal-1",
      "--title", "Release goal-1",
      "--body-file", call.bodyFilePath,
    ]);
    expect(call.argv).toEqual(ghPrArgv(REQUEST, call.bodyFilePath));
    expect(call.options.shell).toBe(false);
    expect(call.options.cwd).toBe(CWD);

    // Read INSIDE the spawn, before the port's finally removed it. Byte comparison, so a
    // trailing-newline or encoding difference cannot pass as "equal enough".
    expect(call.bodyFileContent).toBe(REQUEST.body);
    expect(Buffer.from(call.bodyFileContent, "utf8").equals(Buffer.from(REQUEST.body, "utf8")))
      .toBe(true);
    // The body is never in argv: that is the 32767-char truncation this design avoids.
    expect(call.argv).not.toContain(REQUEST.body);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.stderrLastLine);
    expect(result.prUrl).toBe("https://github.com/acme/widget/pull/7");
    expect(existsSync(call.bodyFilePath)).toBe(false);
  });

  it("takes the LAST non-empty stdout line as the url, not the first", async () => {
    const { captured, spawn } = fakeSpawn((child) => {
      child.stdout.emit("data", "Warning: 3 uncommitted changes\n");
      child.stdout.emit("data", "https://github.com/acme/widget/pull/9\n\n");
      child.emit("close", 0);
    });
    const result = await createGhReleasePrPort({ cwd: CWD, spawn, verifyHead: async () => true }).open(REQUEST);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.prUrl).toBe("https://github.com/acme/widget/pull/9");
    expect(existsSync(captured[0]!.bodyFilePath)).toBe(false);
  });

  it("refuses with ENOENT when gh is not installed, and says something true", async () => {
    const { captured, spawn } = fakeSpawn((child) => {
      const error = Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
      child.emit("error", error);
    });
    const result = await createGhReleasePrPort({ cwd: CWD, spawn, verifyHead: async () => true }).open(REQUEST);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.spawnErrorCode).toBe("ENOENT");
    // A process that never started has no stderr; the empty string is the honest answer.
    expect(result.stderrLastLine).toBe("");
    expect(existsSync(captured[0]!.bodyFilePath)).toBe(false);
  });

  it("carries the LAST NON-EMPTY stderr line verbatim when gh is unauthenticated", async () => {
    const { captured, spawn } = fakeSpawn((child) => {
      child.stderr.emit("data", "gh: To get started with GitHub CLI, please run:\n");
      child.stderr.emit("data", "  gh auth login\n");
      child.stderr.emit("data", "Alternatively, populate the GH_TOKEN environment variable.\n\n");
      child.emit("close", 1);
    });
    const result = await createGhReleasePrPort({ cwd: CWD, spawn, verifyHead: async () => true }).open(REQUEST);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    // Verbatim, and specifically the LAST non-empty line: not the first, not the blob.
    expect(result.stderrLastLine)
      .toBe("Alternatively, populate the GH_TOKEN environment variable.");
    expect(result.stderrLastLine).not.toContain("To get started");
    expect(result.stderrLastLine).not.toContain("\n");
    expect(result.spawnErrorCode).toBeNull();
    expect(existsSync(captured[0]!.bodyFilePath)).toBe(false);
  });

  it("refuses a gh that exits 0 while printing no url", async () => {
    // exit 0 alone is not success: an empty prUrl would mint a RELEASED receipt whose
    // decoder invariant (non-null prUrl) then refuses the bytes.
    const { spawn } = fakeSpawn((child) => { child.emit("close", 0); });
    const result = await createGhReleasePrPort({ cwd: CWD, spawn, verifyHead: async () => true }).open(REQUEST);
    expect(result.ok).toBe(false);
  });

  it("kills the child on timeout and settles ok:false", async () => {
    // The fake never emits close or error: only the timer can settle this call.
    const { captured, spawn } = fakeSpawn(() => undefined);
    const result = await createGhReleasePrPort({ cwd: CWD, spawn, verifyHead: async () => true, timeoutMs: 5 }).open(REQUEST);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.spawnErrorCode).toBeNull();
    const call = captured[0]!;
    expect(call.child.killed).toBe(true);
    expect(call.child.killSignals).toEqual(["SIGKILL"]);
    expect(existsSync(call.bodyFilePath)).toBe(false);
  });

  it("does not resolve twice when close arrives after the timeout already fired", async () => {
    // The settled latch: without it the late close would leave the timer or the promise
    // in a state where a second settle is attempted.
    const { captured, spawn } = fakeSpawn((child) => {
      setTimeout(() => {
        child.stdout.emit("data", "https://github.com/acme/widget/pull/11\n");
        child.emit("close", 0);
      }, 40);
    });
    const result = await createGhReleasePrPort({ cwd: CWD, spawn, verifyHead: async () => true, timeoutMs: 5 }).open(REQUEST);
    expect(result.ok).toBe(false);
    await new Promise((resolve) => { setTimeout(resolve, 60); });
    // Still the timeout's answer, and the temp directory is gone exactly once.
    expect(result.ok).toBe(false);
    expect(existsSync(captured[0]!.bodyFilePath)).toBe(false);
  });

  it("builds one recipe for every platform: the module reads no platform at all", () => {
    // The step asks the argv be identical on win32 and posix. Rather than assert that by
    // running one of them, assert the property that makes it true: nothing in the module
    // branches on the host. A test that only checked the argv on THIS box would pass on
    // win32 and say nothing about posix.
    const source = readSource(
      fileURLToPath(new URL("./release-pr-port.ts", import.meta.url)), "utf8",
    );
    // COMMENTS STRIPPED FIRST. The module's own doc comment explains why `gh.exe` is
    // wrong, so a raw text scan matches the PROSE and reds on a file that is correct —
    // measured, not guessed: that is exactly how this arm failed on its first run.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/(^|[^:])\/\/.*$/gmu, "$1");
    expect(code).toContain("createGhReleasePrPort");
    expect(code).not.toContain("process.platform");
    expect(code).not.toContain("gh.exe");
    expect(code).not.toContain("gh.cmd");
    expect(GH_EXECUTABLE).toBe("gh");
    expect(ghPrArgv(REQUEST, "/posix/style/body.md")).toEqual([
      "pr", "create", "--repo", REQUEST.remoteUrl, "--base", "main", "--head", "moe/goal-1",
      "--title", "Release goal-1", "--body-file", "/posix/style/body.md",
    ]);
    expect(ghPrArgv(REQUEST, "C:\\win32\\style\\body.md")).toEqual([
      "pr", "create", "--repo", REQUEST.remoteUrl, "--base", "main", "--head", "moe/goal-1",
      "--title", "Release goal-1", "--body-file", "C:\\win32\\style\\body.md",
    ]);
  });
});
