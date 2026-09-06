import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { readProviderVersion, resolveAgentImage } from "./activation-provider-version.js";

/**
 * The image resolver is the whole reason a missing agent CLI REFUSES activation instead of
 * being measured as UNKNOWN.
 *
 * Measured on this host 2026-09-06, and the reason these arms exist:
 *
 *   execFile("moe-no-such-cli-xyz --version", [], { shell: true })
 *     -> code 1, stderr "'moe-no-such-cli-xyz' is not recognized as an internal or
 *        external command,"
 *
 * cmd.exe answers an ABSENT command with exit 1 — the same code a CLI that ran and failed
 * gives — so a reader that trusted the exit code would report every Windows host with no agent
 * installed as "the CLI ran and said nothing", record UNKNOWN, and let a witness be minted on
 * it. Resolution happens before the spawn, and these arms drive win32 EXPLICITLY on every
 * platform so the guard is not silently untested on a Linux runner.
 */
describe("resolveAgentImage", () => {
  const temporaries: string[] = [];
  const temporaryRoot = (): string => {
    const created = mkdtempSync(join(tmpdir(), "moe-agent-image-"));
    temporaries.push(created);
    return created;
  };

  afterEach(() => {
    while (temporaries.length > 0) {
      const path = temporaries.pop();
      if (path !== undefined) rmSync(path, { force: true, maxRetries: 5, recursive: true });
    }
  });

  it("finds a win32 shim by PATHEXT, and reports a command that is simply absent", () => {
    const directory = temporaryRoot();
    writeFileSync(join(directory, "claude.cmd"), "@echo off\r\n");
    const env = { PATH: directory, PATHEXT: ".COM;.EXE;.BAT;.CMD" };

    // The bare name resolves through PATHEXT — this is the case Node 24 cannot spawn with
    // shell:false, and the case that made a missing CLI indistinguishable from a failing one.
    // Compared case-insensitively: the extension comes back as PATHEXT spelled it, and win32
    // paths do not distinguish `.CMD` from `.cmd`.
    expect(resolveAgentImage("claude", env, "win32")?.toLowerCase())
      .toBe(join(directory, "claude.cmd").toLowerCase());
    expect(resolveAgentImage("codex", env, "win32")).toBeNull();
    expect(resolveAgentImage("", env, "win32")).toBeNull();
  });

  it("prefers a command that already names its own extension over a probed one", () => {
    const directory = temporaryRoot();
    writeFileSync(join(directory, "claude.cmd"), "@echo off\r\n");
    const env = { PATH: directory, PATHEXT: ".EXE;.CMD" };
    // `claude.cmd` must resolve as written, never be probed as `claude.cmd.EXE` and called absent.
    expect(resolveAgentImage("claude.cmd", env, "win32")).toBe(join(directory, "claude.cmd"));
  });

  it("never invents an extension off win32", () => {
    const directory = temporaryRoot();
    writeFileSync(join(directory, "claude.cmd"), "#!/bin/sh\n");
    const env = { PATH: directory, PATHEXT: ".CMD" };
    // A posix host has no PATHEXT semantics: `claude` is not `claude.cmd` there.
    expect(resolveAgentImage("claude", env, "linux")).toBeNull();
    expect(resolveAgentImage("claude.cmd", env, "linux")).toBe(join(directory, "claude.cmd"));
  });

  it("searches PATH in order and skips empty entries", () => {
    const first = temporaryRoot();
    const second = temporaryRoot();
    writeFileSync(join(second, "agent"), "#!/bin/sh\n");
    const env = { PATH: [first, "", second].join(delimiter) };
    expect(resolveAgentImage("agent", env, "linux")).toBe(join(second, "agent"));
  });

  it("resolves a command that names a directory WITHOUT consulting PATH", () => {
    const directory = temporaryRoot();
    mkdirSync(join(directory, "bin"));
    const nested = join(directory, "bin", "agent");
    writeFileSync(nested, "#!/bin/sh\n");
    // An absolute command is its own answer; PATH deliberately points somewhere else.
    expect(resolveAgentImage(nested, { PATH: directory }, "linux")).toBe(nested);
    expect(resolveAgentImage(join(directory, "missing"), { PATH: directory }, "linux")).toBeNull();
  });

  it("reports NO PATH at all as absent rather than throwing", () => {
    expect(resolveAgentImage("claude", {}, "win32")).toBeNull();
    expect(resolveAgentImage("claude", {}, "linux")).toBeNull();
  });

  it("does not accept a DIRECTORY named like the CLI as the CLI", () => {
    const directory = temporaryRoot();
    // The exact fail-open shape this function closes: cmd.exe would answer a directory with
    // exit 1, which the measurer would read as "the CLI ran and said nothing" -> UNKNOWN ->
    // MEASURED. A name that exists is not an image.
    mkdirSync(join(directory, "claude"));
    expect(resolveAgentImage("claude", { PATH: directory }, "linux")).toBeNull();

    // The real shim, in the SAME directory, still resolves — so this is not just "always null".
    writeFileSync(join(directory, "codex"), "#!/bin/sh\n");
    expect(resolveAgentImage("codex", { PATH: directory }, "linux")).toBe(join(directory, "codex"));
  });
});

describe("readProviderVersion", () => {
  /**
   * The real spawn. `process.execPath` stands in for the agent CLI: a real executable certain
   * to exist here that answers `--version` in the same shape. What is under test is that a
   * process actually ran and that an ABSENT command comes back as `code: null` — the exact
   * discriminator `measureProvider` refuses on.
   */
  it("runs the real image, and answers an absent one with code null", async () => {
    const ran = await readProviderVersion(process.execPath);
    expect(ran.code).toBe(0);
    expect(ran.stdout).toMatch(/^v?\d+\.\d+\.\d+/u);

    const absent = await readProviderVersion(`moe-no-such-cli-${randomUUID()}`);
    expect(absent.code).toBeNull();
    expect(absent.stderr).toContain("was not found on PATH");
  }, 120_000);

  /**
   * The `catch` arm, driven by a REAL child. `execFile` rejects on a non-zero exit just as it
   * does on a failure to spawn, and the two must not be conflated: this CLI RAN, said a
   * version, and exited 3. Dropping its stdout would turn a readable answer into UNKNOWN, and
   * dropping its exit code would refuse the whole activation against a CLI that is installed.
   */
  it("keeps the exit code AND the output of a CLI that ran and failed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-agent-exit-"));
    try {
      const win32 = process.platform === "win32";
      const script = join(directory, win32 ? "agent.cmd" : "agent.sh");
      writeFileSync(
        script,
        win32 ? "@echo off\r\necho 9.9.9\r\nexit /b 3\r\n" : "#!/bin/sh\necho 9.9.9\nexit 3\n",
        win32 ? {} : { mode: 0o755 },
      );

      const run = await readProviderVersion(script);
      expect(run.code).toBe(3);
      expect(run.stdout).toContain("9.9.9");
    } finally {
      rmSync(directory, { force: true, maxRetries: 5, recursive: true });
    }
  }, 120_000);

  it("never rejects: an empty command is an answer, not a throw", async () => {
    await expect(readProviderVersion("")).resolves.toEqual({
      code: null, stderr: " was not found on PATH", stdout: "",
    });
  });
});
