import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGitLandingPort } from "./git-landing-port.js";
import { captureVerifiedWorkspace } from "./git-verified-workspace-capture.js";
import { withVerifiedGit } from "./git-verified-workspace-runtime.js";
import { prepareRuntimeMetadataExcludes } from "./runtime-metadata-excludes.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, {
  cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
}).trim();
function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "moe-runtime-excludes-")); roots.push(root);
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "user.name", "Metadata test");
  git(root, "config", "user.email", "metadata@example.test");
  writeFileSync(join(root, "app.ts"), "export const app = 1;\n");
  git(root, "add", "--", "app.ts");
  git(root, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "initial");
  return root;
}
const paths = (root: string, store = "store.sqlite") => ({
  projectRoot: root, configPath: join(root, "moe.config.json"), storePath: join(root, store),
});
const metadata = ["moe.config.json", "store.sqlite", "store.sqlite.moe-stack.lock",
  ...["", ".health.sqlite", ".backups.sqlite"].flatMap((family) =>
    ["", "-wal", "-shm", "-journal"].map((suffix) => `store.sqlite${family}${suffix}`))];
function writeMetadata(root: string, value: string): void {
  for (const path of metadata) writeFileSync(join(root, path), value);
  for (const dir of [".moe", ".moe-next"]) {
    mkdirSync(join(root, dir), { recursive: true }); writeFileSync(join(root, dir, "wrapper.log"), value);
  }
}

describe("runtime metadata Git exclusions", () => {
  it("keeps runtime files out of the production observer while retaining real source and unrelated stores", async () => {
    const root = repository(); writeMetadata(root, "first");
    writeFileSync(join(root, "new.ts"), "new source");
    mkdirSync(join(root, "data")); writeFileSync(join(root, "data", "store.sqlite"), "application data");
    writeFileSync(join(root, "store.sqlite.backup"), "user backup");
    expect(await prepareRuntimeMetadataExcludes(paths(root))).toEqual({ ok: true });
    const observed = await createGitLandingPort().observe(root);
    expect(observed.ok).toBe(true);
    if (!observed.ok) throw new Error(observed.code);
    expect(observed.observation.entries.map((entry) => entry.path)).toEqual(["data/store.sqlite", "new.ts", "store.sqlite.backup"]);
    expect(git(root, "ls-files", "--others", "--exclude-standard").split("\n")).toEqual(["data/store.sqlite", "new.ts", "store.sqlite.backup"]);
  });

  it("keeps the real verified tree and dirty digest stable as runtime databases and logs change", async () => {
    const root = repository(); writeMetadata(root, "first");
    expect(await prepareRuntimeMetadataExcludes(paths(root))).toEqual({ ok: true });
    const before = await withVerifiedGit(root, captureVerifiedWorkspace);
    writeMetadata(root, "changed runtime bytes");
    const after = await withVerifiedGit(root, captureVerifiedWorkspace);
    expect(after).toEqual(before);
    expect(git(root, "ls-tree", "-r", "--name-only", after.treeSha)).toBe("app.ts");
    writeFileSync(join(root, "app.ts"), "export const app = 2;\n");
    expect(await withVerifiedGit(root, captureVerifiedWorkspace)).not.toEqual(before);
  });

  it("preserves existing exclusions, repeats without change, and retires only this config's old rules", async () => {
    const root = repository(); const exclude = join(root, ".git", "info", "exclude");
    const original = "# operator rules\r\n/operator-cache\r\n!keep.txt"; writeFileSync(exclude, original);
    expect(await prepareRuntimeMetadataExcludes(paths(root))).toEqual({ ok: true });
    const first = readFileSync(exclude, "utf8"); expect(first.startsWith(original)).toBe(true);
    expect(await prepareRuntimeMetadataExcludes(paths(root))).toEqual({ ok: true });
    expect(readFileSync(exclude, "utf8")).toBe(first);
    expect(await prepareRuntimeMetadataExcludes(paths(root, "next.sqlite"))).toEqual({ ok: true });
    writeFileSync(join(root, "store.sqlite"), "old path is application-visible again");
    writeFileSync(join(root, "next.sqlite"), "new runtime");
    expect(git(root, "ls-files", "--others", "--exclude-standard")).toBe("store.sqlite");
  });

  it("escapes literal punctuation and spaces without hiding neighboring names", async () => {
    const root = repository(); const name = "runtime [one] #!.sqlite";
    writeFileSync(join(root, name), "runtime"); writeFileSync(join(root, "runtime o #!.sqlite"), "application");
    expect(await prepareRuntimeMetadataExcludes(paths(root, name))).toEqual({ ok: true });
    expect(git(root, "-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard")).toBe("runtime o #!.sqlite");
  });

  it("does not hide a repository file for an external runtime store", async () => {
    const root = repository(); const external = mkdtempSync(join(tmpdir(), "moe-runtime-external-")); roots.push(external);
    writeFileSync(join(root, "store.sqlite"), "application");
    expect(await prepareRuntimeMetadataExcludes({ ...paths(root), storePath: join(external, "store.sqlite") })).toEqual({ ok: true });
    expect(git(root, "ls-files", "--others", "--exclude-standard")).toBe("store.sqlite");
  });

  it("refuses tracked runtime files and preserves both the index and operator exclusions", async () => {
    const root = repository(); writeFileSync(join(root, "store.sqlite"), "tracked application database");
    git(root, "add", "--", "store.sqlite");
    const index = git(root, "ls-files", "--stage");
    const exclude = readFileSync(join(root, ".git", "info", "exclude"), "utf8");
    expect(await prepareRuntimeMetadataExcludes(paths(root))).toMatchObject({ ok: false, code: "RUNTIME_METADATA_TRACKED" });
    expect(git(root, "ls-files", "--stage")).toBe(index);
    expect(readFileSync(join(root, ".git", "info", "exclude"), "utf8")).toBe(exclude);
  });

  it("does not change shared exclusions to hide a peer worktree's application file", async () => {
    const root = repository(); const peer = join(root, "peer");
    git(root, "worktree", "add", "--quiet", "-b", "peer", peer);
    writeFileSync(join(peer, "store.sqlite"), "peer application data");
    const exclude = readFileSync(join(root, ".git", "info", "exclude"), "utf8");
    expect(await prepareRuntimeMetadataExcludes(paths(root))).toMatchObject({ ok: false, code: "RUNTIME_METADATA_SHARED_WORKTREE" });
    expect(readFileSync(join(root, ".git", "info", "exclude"), "utf8")).toBe(exclude);
    expect(git(peer, "ls-files", "--others", "--exclude-standard")).toBe("store.sqlite");
  });

  it("refuses HEAD-tracked runtime files even after an index-only removal", async () => {
    const root = repository(); writeFileSync(join(root, "store.sqlite"), "tracked runtime");
    git(root, "add", "--", "store.sqlite"); git(root, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "old runtime");
    git(root, "rm", "--cached", "--", "store.sqlite");
    expect(await prepareRuntimeMetadataExcludes(paths(root))).toMatchObject({ ok: false, code: "RUNTIME_METADATA_TRACKED" });
  });

  it.runIf(process.platform === "win32")("refuses Windows aliases of index and HEAD tracked runtime files", async () => {
    const root = repository(); writeFileSync(join(root, "store.sqlite"), "tracked runtime");
    git(root, "add", "--", "store.sqlite");
    expect(await prepareRuntimeMetadataExcludes(paths(root, "STORE.SQLITE"))).toMatchObject({ ok: false, code: "RUNTIME_METADATA_TRACKED" });
    git(root, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "old runtime"); git(root, "rm", "--cached", "--", "store.sqlite");
    expect(await prepareRuntimeMetadataExcludes(paths(root, "STORE.SQLITE"))).toMatchObject({ ok: false, code: "RUNTIME_METADATA_TRACKED" });
  });

  it("does not replace the original checkout's runtime rules from an already-ignored peer", async () => {
    const root = repository(); expect(await prepareRuntimeMetadataExcludes(paths(root))).toEqual({ ok: true });
    const before = readFileSync(join(root, ".git", "info", "exclude"), "utf8");
    const peer = join(root, "peer"); git(root, "worktree", "add", "--quiet", "-b", "peer", peer);
    writeFileSync(join(peer, ".gitignore"), metadata.map((path) => `/${path.replaceAll("store.sqlite", "peer.sqlite")}`).join("\n"));
    expect(await prepareRuntimeMetadataExcludes(paths(peer, "peer.sqlite"))).toEqual({ ok: true });
    expect(readFileSync(join(root, ".git", "info", "exclude"), "utf8")).toBe(before);
  });

  it("allows planning before Git exists without creating a repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "moe-runtime-no-git-")); roots.push(root);
    expect(await prepareRuntimeMetadataExcludes(paths(root))).toEqual({ ok: true });
    expect(existsSync(join(root, ".git"))).toBe(false);
  });

  it("refuses a missing Git executable without calling it a non-repository", async () => {
    const root = repository();
    expect(await prepareRuntimeMetadataExcludes(paths(root), async () => ({ code: null, stdout: "", stderr: "spawn git ENOENT" })))
      .toMatchObject({ ok: false, code: "RUNTIME_METADATA_GIT_FAILED" });
  });

  it("does not overwrite or remove an exclusion lock owned by another writer", async () => {
    const root = repository(); const lock = join(root, ".git", "info", "exclude.lock");
    writeFileSync(lock, "other writer");
    expect(await prepareRuntimeMetadataExcludes(paths(root))).toMatchObject({ ok: false, code: "RUNTIME_METADATA_EXCLUDES_UNAVAILABLE" });
    expect(readFileSync(lock, "utf8")).toBe("other writer");
  });

  it("refuses ineffective exclusions when project rules explicitly unignore the store", async () => {
    const root = repository(); writeFileSync(join(root, ".gitignore"), "!store.sqlite\n");
    expect(await prepareRuntimeMetadataExcludes(paths(root))).toMatchObject({ ok: false, code: "RUNTIME_METADATA_EXCLUDES_INEFFECTIVE" });
    expect(existsSync(join(root, ".git", "info", "exclude.lock"))).toBe(false);
  });

  it("scopes a nested project's runtime paths relative to the real repository root", async () => {
    const root = repository(); const project = join(root, "nested"); mkdirSync(project);
    writeFileSync(join(root, "store.sqlite"), "outer application"); writeMetadata(project, "runtime");
    expect(await prepareRuntimeMetadataExcludes(paths(project))).toEqual({ ok: true });
    expect(git(root, "ls-files", "--others", "--exclude-standard")).toBe("store.sqlite");
  });

  it("supports linked worktrees when repository rules already reserve all exact runtime paths", async () => {
    const root = repository();
    writeFileSync(join(root, ".gitignore"), ["/.moe/", "/.moe-next/", ...metadata.map((path) => `/${path}`)].join("\n"));
    git(root, "add", "--", ".gitignore"); git(root, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "reserved metadata");
    const peer = join(root, "peer"); git(root, "worktree", "add", "--quiet", "-b", "peer", peer);
    expect(await prepareRuntimeMetadataExcludes(paths(peer))).toEqual({ ok: true });
    writeMetadata(peer, "runtime");
    expect(git(peer, "status", "--porcelain")).toBe("");
  });
});
