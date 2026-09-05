import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { nodeGitRunner } from "./git-landing-port.js";
import type { BootstrapGithubRequest, GhRunner } from "./repository-bootstrap-contracts.js";
import type { GhExecute } from "./repository-bootstrap-ports.js";
import * as ports from "./repository-bootstrap-ports.js";

async function scratch(run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "moe-bootstrap-ports-"));
  try { await run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

const refusal = (code: string, detail: string) => ({
  ok: false, refusal: { code, detail, refusedBy: "DAEMON_INGRESS" },
});
const github = { owner: "moe-example", name: "sample", visibility: "private" } as const;

describe("bootstrap host ports", () => {
  it("exports the production ports", () => {
    expect(ports).toMatchObject({ createBootstrapGitPort: expect.any(Function),
      createBootstrapGhPort: expect.any(Function), createNodeGhRunner: expect.any(Function),
      nodeTreeWriter: expect.any(Object) });
  });

  it("creates exactly one Moe commit despite hostile inherited Git environment", async () => {
    await scratch(async (root) => {
      writeFileSync(join(root, "hello.txt"), "hello\n");
      const before = process.env["GIT_DIR"];
      process.env["GIT_DIR"] = join(root, "wrong-repository");
      try {
        expect(await ports.createBootstrapGitPort().commit(root)).toMatchObject({ ok: true, sha: expect.any(String) });
        expect(existsSync(join(root, ".git"))).toBe(true);
        expect(existsSync(join(root, "wrong-repository"))).toBe(false);
        const log = await nodeGitRunner(root, ["log", "--oneline"]);
        expect(log.code).toBe(0);
        expect(log.stdout.trim().split("\n")).toEqual([expect.stringMatching(/^[a-f0-9]+ chore: scaffold by Moe$/)]);
        const author = await nodeGitRunner(root, ["log", "-1", "--format=%an <%ae>"]);
        expect(author.code).toBe(0);
        expect(author.stdout.trim()).toBe("Moe <moe@moe.local>");
        expect(await nodeGitRunner(root, ["symbolic-ref", "--short", "HEAD"]))
          .toMatchObject({ code: 0, stdout: "main\n" });
      } finally {
        if (before === undefined) delete process.env["GIT_DIR"]; else process.env["GIT_DIR"] = before;
      }
    });
  }, 300_000);

  it.each([null, 1])("refuses Git failure %s without copying diagnostic text", async (code) => {
    const run = vi.fn(async () => ({ code, stderr: "untrusted diagnostic", stdout: "" }));
    expect(await ports.createBootstrapGitPort(run).commit("unused"))
      .toEqual(refusal("BOOTSTRAP_GIT_UNAVAILABLE", code === null ? "GIT_EXECUTABLE_UNAVAILABLE" : "GIT_COMMAND_FAILED"));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("initializes main to match the controlled-profile CI push branch", async () => {
    const run = vi.fn(async () => ({ code: 0, stderr: "", stdout: "a".repeat(40) }));
    expect(await ports.createBootstrapGitPort(run).commit("unused")).toMatchObject({ ok: true });
    expect(run).toHaveBeenNthCalledWith(1, "unused", ["init", "--initial-branch=main"]);
  });

  it.each(["", "not-a-sha"]) ("refuses invalid Git SHA %s", async (stdout) => {
    expect(await ports.createBootstrapGitPort(async () => ({ code: 0, stderr: "", stdout })).commit("unused"))
      .toEqual(refusal("BOOTSTRAP_GIT_UNAVAILABLE", "GIT_SHA_INVALID"));
  });

  it("invokes only bare gh with bounded shell:false options and distinguishes ENOENT", async () => {
    for (const code of ["ENOENT", 1] as const) {
      const execute = vi.fn<GhExecute>((_file, _args, _options, callback) => {
        callback(Object.assign(new Error("untrusted"), { code }), "", "untrusted");
        return { stdin: null };
      });
      const result = await ports.createNodeGhRunner(execute)("local-dir", ["repo", "create"]);
      expect(result).toEqual({ code: code === "ENOENT" ? null : 1, executableAbsent: code === "ENOENT", stderr: "", stdout: "" });
      expect(execute).toHaveBeenCalledExactlyOnceWith("gh", ["repo", "create"],
        expect.objectContaining({ cwd: "local-dir", shell: false, windowsHide: true, timeout: 60_000 }), expect.any(Function));
    }
  });

  it("captures the exact offline GitHub argv", async () => {
    const run = vi.fn<GhRunner>(async () => ({ code: 0, executableAbsent: false, stderr: "", stdout: "ignored" }));
    expect(await ports.createBootstrapGhPort(run).create("local-dir", github))
      .toEqual({ ok: true, remoteUrl: "https://github.com/moe-example/sample" });
    expect(run).toHaveBeenCalledExactlyOnceWith("local-dir",
      ["repo", "create", "moe-example/sample", "--private", "--source", ".", "--push"]);
  });

  it.each([[true, null, "GH_EXECUTABLE_ABSENT"], [false, 1, "GITHUB_REFUSED"],
    [false, null, "GH_EXECUTION_FAILED"]] as const)("classifies GH failure %s/%s", async (executableAbsent, code, detail) => {
    const run: GhRunner = async () => ({ code, executableAbsent, stderr: "untrusted", stdout: "untrusted" });
    expect(await ports.createBootstrapGhPort(run).create("unused", github))
      .toEqual(refusal("BOOTSTRAP_GH_UNAVAILABLE", detail));
  });

  it("rejects invalid GitHub arguments before invoking a process", async () => {
    const run = vi.fn<GhRunner>();
    expect(await ports.createBootstrapGhPort(run).create("unused", { ...github, owner: "--invalid" }))
      .toEqual(refusal("BOOTSTRAP_PAYLOAD_INVALID", "GITHUB_REQUEST_INVALID"));
    expect(run).not.toHaveBeenCalled();
  });

  it.each([null, {}, { visibility: "private" }, { owner: 12, name: "sample", visibility: "private" }])
  ("rejects malformed GitHub shape before process invocation: %j", async (input) => {
    const run = vi.fn<GhRunner>();
    expect(await ports.createBootstrapGhPort(run).create("unused", input as BootstrapGithubRequest))
      .toEqual(refusal("BOOTSTRAP_PAYLOAD_INVALID", "GITHUB_REQUEST_INVALID"));
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["/absolute", "../escape", "inside/../../escape", "inside\\..\\escape", "C:\\escape", "file:stream"])
  ("refuses tree path %s before writing any file", async (path) => {
    await scratch(async (root) => {
      expect(await ports.nodeTreeWriter.write(root, new Map([["allowed", "no"], [path, "no"]])))
        .toEqual(refusal("BOOTSTRAP_TREE_PATH_INVALID", "TREE_PATH_INVALID"));
      expect(readdirSync(root)).toEqual([]);
    });
  });

  it("rechecks the directory after prepare and preserves a late arrival", async () => {
    await scratch(async (root) => {
      expect(await ports.nodeTreeWriter.prepare(root)).toEqual({ ok: true, dir: resolve(root) });
      writeFileSync(join(root, "late"), "keep");
      expect(await ports.nodeTreeWriter.write(root, new Map([["new", "no"]])))
        .toEqual(refusal("BOOTSTRAP_DIR_NOT_EMPTY", "DIRECTORY_NOT_EMPTY"));
      expect(readdirSync(root)).toEqual(["late"]);
    });
  });

  it("refuses a normalized escape inside a disposable parent", async () => {
    await scratch(async (root) => {
      const target = join(root, "target");
      mkdirSync(target);
      expect(await ports.nodeTreeWriter.write(target, new Map([["../outside", "no"]])))
        .toEqual(refusal("BOOTSTRAP_TREE_PATH_INVALID", "TREE_PATH_INVALID"));
      expect(readdirSync(root)).toEqual(["target"]);
      expect(readdirSync(target)).toEqual([]);
    });
  });

  it.each(["", "\\\\example.invalid\\share", "//example.invalid/share"])
  ("refuses invalid target without probing a network path: %s", async (dir) => {
    expect(await ports.nodeTreeWriter.prepare(dir)).toEqual(refusal("BOOTSTRAP_DIR_INVALID", "DIRECTORY_INVALID"));
  });

  it("rejects a file and a junction, counts dotfiles, accepts trailing separators", async () => {
    await scratch(async (root) => {
      const target = join(root, "target");
      mkdirSync(target);
      expect(await ports.nodeTreeWriter.prepare(`${target}/`)).toEqual({ ok: true, dir: resolve(target) });
      writeFileSync(join(target, ".hidden"), "keep");
      expect(await ports.nodeTreeWriter.prepare(target)).toEqual(refusal("BOOTSTRAP_DIR_NOT_EMPTY", "DIRECTORY_NOT_EMPTY"));
      expect(await ports.nodeTreeWriter.prepare(join(target, ".hidden")))
        .toEqual(refusal("BOOTSTRAP_DIR_INVALID", "DIRECTORY_INVALID"));
      const link = join(root, "link");
      symlinkSync(target, link, "junction");
      expect(await ports.nodeTreeWriter.prepare(link)).toEqual(refusal("BOOTSTRAP_DIR_INVALID", "DIRECTORY_INVALID"));
      expect(readdirSync(target)).toEqual([".hidden"]);
    });
  });

  it("removes its temp repository even when the test body throws", async () => {
    let dir = "";
    await expect(scratch(async (root) => {
      dir = root;
      writeFileSync(join(root, "hello"), "hello");
      expect(await ports.createBootstrapGitPort().commit(root)).toMatchObject({ ok: true });
      throw Object.assign(new Error("forced cleanup"), { code: "FORCED_TEST_THROW" });
    })).rejects.toMatchObject({ code: "FORCED_TEST_THROW" });
    expect(existsSync(dir)).toBe(false);
  }, 300_000);
});
