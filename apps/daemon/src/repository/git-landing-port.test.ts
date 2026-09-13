import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGitLandingPort, nodeGitRunner } from "./git-landing-port.js";
import { DELETED_BLOB } from "./landing-receipt-contracts.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A real repository with one commit, one tracked file, and a `.moe-next` directory. */
function scratchRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "moe-landing-port-"));
  roots.push(root);
  git(root, "init", "--quiet", "--initial-branch=trunk");
  git(root, "config", "user.email", "operator@example.test");
  git(root, "config", "user.name", "Operator");
  git(root, "config", "commit.gpgsign", "false");
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, ".moe-next"));
  writeFileSync(join(root, "src", "tracked.ts"), "export const before = 1;\n", "utf8");
  writeFileSync(join(root, "src", "doomed.ts"), "export const doomed = 1;\n", "utf8");
  writeFileSync(join(root, ".moe-next", "start.ps1"), "# start\n", "utf8");
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "operator: initial");
  return root;
}

describe("createGitLandingPort against a real repository", () => {
  it.skipIf(process.platform !== "win32")("refuses the Windows case alias of tracked runtime metadata", async () => {
    const root = scratchRepository();
    git(root, "mv", "--", ".moe-next", "metadata-temporary");
    git(root, "mv", "--", "metadata-temporary", ".MOE-NEXT");
    git(root, "commit", "--quiet", "-m", "legacy directory spelling");
    writeFileSync(join(root, ".MOE-NEXT", "start.ps1"), "# existing operator change\n");

    expect(await createGitLandingPort().observe(root))
      .toMatchObject({ ok: false, code: "TRACKED_RUNTIME_METADATA_DIRTY" });
  });

  it("bounds and escapes the tracked metadata path diagnosis onto one log line", async () => {
    const root = scratchRepository();
    const records = Array.from({ length: 20 }, (_, index) =>
      ` M .moe-next/file-${String(index)}\n${"long".repeat(80)}.txt\0`).join("");
    const port = createGitLandingPort(async (cwd, args, input) => args[0] === "status"
      ? { code: 0, stderr: "", stdout: records } : nodeGitRunner(cwd, args, input));

    const result = await port.observe(root);

    expect(result).toMatchObject({ ok: false, code: "TRACKED_RUNTIME_METADATA_DIRTY" });
    if (result.ok) throw new Error("expected tracked metadata refusal");
    expect(result.detail).toContain("20 tracked runtime metadata path(s)");
    expect(result.detail).toContain("\\n");
    expect(result.detail).not.toMatch(/[\r\n]/u);
    expect(result.detail.length).toBeLessThanOrEqual(600);
    expect(result.detail).toContain("git status --short");
  });

  it.each(["modified", "deleted", "staged addition", "renamed out", "renamed in", "outside subtree"] as const)(
    "refuses tracked runtime metadata changes before hashing or admitting a partial tree (%s)", async (change) => {
      const root = scratchRepository();
      const path = ".moe-next/start.ps1";
      if (change === "deleted") unlinkSync(join(root, path));
      else if (change === "staged addition") {
        mkdirSync(join(root, ".moe"));
        writeFileSync(join(root, ".moe", "operator.ps1"), "# staged operator work\n");
        git(root, "add", "--", ".moe/operator.ps1");
      } else if (change === "renamed out") git(root, "mv", "--", path, "operator-start.ps1");
      else if (change === "renamed in") git(root, "mv", "--", "src/tracked.ts", ".moe-next/tracked.ts");
      else writeFileSync(join(root, path), "# existing operator work\n");
      const head = git(root, "rev-parse", "HEAD");
      const index = readFileSync(join(root, ".git", "index"));
      let hashes = 0;
      const port = createGitLandingPort(async (cwd, args, input) => {
        if (args[0] === "hash-object") hashes += 1;
        return nodeGitRunner(cwd, args, input);
      });

      const observed = await port.observe(change === "outside subtree" ? join(root, "src") : root);

      expect(observed).toMatchObject({ ok: false, code: "TRACKED_RUNTIME_METADATA_DIRTY" });
      expect(!observed.ok && observed.detail).toContain(change === "staged addition" ? ".moe/operator.ps1"
        : change === "renamed in" ? ".moe-next/tracked.ts" : path);
      expect(!observed.ok && observed.detail).toContain("git status --short");
      expect(hashes).toBe(0);
      expect(git(root, "rev-parse", "HEAD")).toBe(head);
      expect(readFileSync(join(root, ".git", "index"))).toEqual(index);
    },
  );

  it("observes scoped dirty paths root-relative with blob ids while skipping untracked runtime metadata", async () => {
    const root = scratchRepository();
    writeFileSync(join(root, "src", "tracked.ts"), "export const before = 2;\n", "utf8");
    writeFileSync(join(root, "src", "new.ts"), "export const fresh = 1;\n", "utf8");
    writeFileSync(join(root, ".moe-next", "wrapper.log"), "runtime output\n", "utf8");
    unlinkSync(join(root, "src", "doomed.ts"));
    const port = createGitLandingPort();
    const observed = await port.observe(join(root, "src"));
    if (!observed.ok) throw new Error(observed.detail);
    expect(observed.observation.entries.map((entry) => entry.path))
      .toEqual(["src/doomed.ts", "src/new.ts", "src/tracked.ts"]);
    expect(observed.observation.entries[0]?.blobId).toBe(DELETED_BLOB);
    expect(observed.observation.entries[1]?.blobId).toBe(git(root, "hash-object", "src/new.ts"));
    expect(observed.observation.entries[2]?.blobId).toBe(git(root, "hash-object", "src/tracked.ts"));
    // The untracked subset, root-relative and sorted: new.ts only (tracked.ts is modified).
    expect(observed.observation.untracked).toEqual(["src/new.ts"]);
    const rootObservation = await port.observe(root);
    expect(rootObservation.ok && rootObservation.observation.entries).toEqual(observed.observation.entries);
  });

  // MEASURED 2026-09-13 (git 2.54, Node 24.16, Windows): `hash-object --stdin-paths` aborts on the
  // first path it cannot open (exit 128) and never drains the rest of the payload. The pending
  // write then fails asynchronously on the stdin stream ("EOF" here, EPIPE on POSIX); with no
  // listener that was an uncaught exception, and a process running the runner died with it
  // before the runner ever resolved. The child below is that process: it must stay up and answer
  // git's own exit code. The payload is generated inside the child (a 3.8 MB argv would not fit).
  it("survives git exiting before it drains a stdin payload larger than the pipe", () => {
    const root = scratchRepository();
    const script = [
      `import { nodeGitRunner } from ${JSON.stringify(new URL("./git-landing-port.ts", import.meta.url).href)};`,
      `const result = await nodeGitRunner(${JSON.stringify(root)}, ["hash-object", "--stdin-paths"], "does-not-exist.txt\\n".repeat(200_000));`,
      "process.stdout.write(JSON.stringify({ code: result.code, named: result.stderr.includes(\"does-not-exist.txt\") }));",
    ].join("\n");
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script],
      { encoding: "utf8", timeout: 60_000, windowsHide: true });
    expect({ status: child.status, stdout: child.stdout }, child.stderr).toEqual({ status: 0, stdout: JSON.stringify({ code: 128, named: true }) });
  }, 60_000);

  it("answers git's code and words in-process for the same early exit", async () => {
    const root = scratchRepository();
    const result = await nodeGitRunner(root, ["hash-object", "--stdin-paths"], "does-not-exist.txt\n".repeat(200_000));
    expect({ code: result.code, named: result.stderr.includes("does-not-exist.txt") }).toEqual({ code: 128, named: true });
  }, 60_000);

  it("refuses a directory outside any repository by name", async () => {
    const outside = mkdtempSync(join(tmpdir(), "moe-landing-outside-"));
    roots.push(outside);
    const observed = await createGitLandingPort().observe(outside);
    expect(observed.ok).toBe(false);
    expect(!observed.ok && observed.code).toBe("NOT_A_REPOSITORY");
  });

  // MEASURED 2026-09-13 (git 2.54): outside a repository `rev-parse --show-toplevel` exits 128 with
  // `fatal: not a git repository (or any of the parent directories): .git`. A spawn error (Node
  // `code: "ENOENT"`, a string) and a timeout kill (`code: null, killed: true`) both reach the port as
  // `code: null`, and a fatal about something else is also 128. Before the fix every one of them read
  // as NOT_A_REPOSITORY, the one observe code the lander records as a durable REFUSED receipt for the
  // accepted delivery; the port now says NOT_A_REPOSITORY only for git's own words about it, or for
  // a spawn failure whose workspace directory is measured gone. Each arm below runs against a
  // directory that EXISTS, so the spawn arm is the missing-binary shape and not the missing-workspace one.
  it.each([
    ["a spawn failure with the directory present", { code: null, stderr: "Error: spawn git ENOENT", stdout: "" }],
    ["a timeout kill", { code: null, stderr: "", stdout: "" }],
    ["a fatal that is not the missing repository", { code: 128, stderr: "fatal: detected dubious ownership in repository at 'D:/anywhere'\n", stdout: "" }],
  ])("reports %s of rev-parse as a retryable failure, never as the structural refusal", async (_label, answer) => {
    const present = mkdtempSync(join(tmpdir(), "moe-landing-present-"));
    roots.push(present);
    const port = createGitLandingPort(async () => answer);
    expect(await port.observe(present)).toMatchObject({ ok: false, code: "GIT_FAILED" });
    expect(await port.push(present, "https://example.test/r.git")).toMatchObject({ ok: false, code: "GIT_PUSH_FAILED" });
    expect(await port.commit(present, ["src/a.ts"], "m\n")).toMatchObject({ ok: false, code: "GIT_COMMIT_FAILED" });
  });

  it("keeps NOT_A_REPOSITORY for git's own words about it", async () => {
    const port = createGitLandingPort(async () => ({
      code: 128, stderr: "fatal: not a git repository (or any of the parent directories): .git\n", stdout: "",
    }));
    expect(await port.observe("D:/anywhere")).toMatchObject({ ok: false, code: "NOT_A_REPOSITORY" });
    expect(await port.push("D:/anywhere", "https://example.test/r.git")).toMatchObject({ ok: false, code: "NOT_A_REPOSITORY" });
  });

  // MEASURED 2026-09-13 (git 2.54, Node 24.16, Windows): with a cwd that no longer exists Node never
  // spawns git and the runner answers `code: null, stderr: "Error: spawn git ENOENT"` - the same
  // words as a missing git binary. Base 2d7d5b30 read every null as NOT_A_REPOSITORY; 82b67bc8 read
  // every null as GIT_FAILED, so a vanished workspace was reported every pass, never recorded, and
  // its reservation cycled AWAITING_LANDING <-> LANDING forever. The port now stats the directory
  // behind a spawn failure: a directory that is gone is a configuration, not a moment.
  it("refuses a workspace directory that no longer exists as NOT_A_REPOSITORY", async () => {
    const gone = mkdtempSync(join(tmpdir(), "moe-landing-gone-"));
    rmSync(gone, { force: true, recursive: true });
    const port = createGitLandingPort();
    expect(await port.observe(gone)).toMatchObject({
      ok: false, code: "NOT_A_REPOSITORY", detail: expect.stringContaining("workspace directory does not exist"),
    });
    expect(await port.push(gone, "https://example.test/r.git")).toMatchObject({ ok: false, code: "NOT_A_REPOSITORY" });
    expect(await port.commit(gone, ["src/a.ts"], "m\n")).toMatchObject({
      ok: false, code: "GIT_COMMIT_FAILED", detail: expect.stringContaining("workspace directory does not exist"),
    });
  });

  // MEASURED 2026-09-13 (git 2.54): inside a bare repository `rev-parse --show-toplevel` exits 128 and
  // says `fatal: this operation must be run in a work tree`. There is no tree to observe or commit
  // into, so that is a configuration git cannot land into, never a moment to retry.
  it("refuses a bare repository as NOT_A_REPOSITORY", async () => {
    const bare = mkdtempSync(join(tmpdir(), "moe-landing-bare-"));
    roots.push(bare);
    git(bare, "init", "--bare", "--quiet");
    const port = createGitLandingPort();
    expect(await port.observe(bare)).toMatchObject({
      ok: false, code: "NOT_A_REPOSITORY", detail: expect.stringContaining("work tree"),
    });
    expect(await port.push(bare, "https://example.test/r.git")).toMatchObject({ ok: false, code: "NOT_A_REPOSITORY" });
  });

  it("commits exactly the named paths as Moe on the current branch, leaving other dirt alone", async () => {
    const root = scratchRepository();
    writeFileSync(join(root, "src", "tracked.ts"), "export const before = 2;\n", "utf8");
    writeFileSync(join(root, "src", "new.ts"), "export const fresh = 1;\n", "utf8");
    writeFileSync(join(root, "operator-wip.md"), "not the seat's\n", "utf8");
    unlinkSync(join(root, "src", "doomed.ts"));
    const port = createGitLandingPort();
    const committed = await port.commit(
      join(root, "src"), ["src/new.ts", "src/tracked.ts", "src/doomed.ts"], "Land the node\n\nbody\n",
    );
    if (!committed.ok) throw new Error(committed.detail);
    expect(committed.receipt.branch).toBe("trunk");
    expect(committed.receipt.sha).toBe(git(root, "rev-parse", "HEAD"));
    expect(committed.receipt.parentSha).toBe(git(root, "rev-parse", "HEAD^"));
    expect(git(root, "log", "-1", "--format=%an <%ae>")).toBe("Moe <moe@moe.local>");
    expect(git(root, "log", "-1", "--format=%s")).toBe("Land the node");
    expect(git(root, "show", "--stat", "--format=", "HEAD")).toContain("src/doomed.ts");
    // The operator's own dirt is still uncommitted and untracked.
    expect(git(root, "status", "--porcelain")).toBe("?? operator-wip.md");
  });

  it("reports a failing commit with git's words instead of throwing", async () => {
    const root = scratchRepository();
    const committed = await createGitLandingPort().commit(root, ["src/does-not-exist.ts"], "nothing\n");
    expect(committed.ok).toBe(false);
    expect(!committed.ok && committed.code).toBe("GIT_COMMIT_FAILED");
    expect(!committed.ok && committed.detail).toContain("does-not-exist");
  });
});
