import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { nodeGitRunner } from "../repository/git-landing-port.js";
import { preparePreviewSource, releasePreviewSource } from "./preview-source.js";
import type { PreviewSource } from "./preview-source.js";
import { cleanupFixtureWorkspaces, commitFixtureWorkspace, fixtureWorkspace } from "./preview-test-fixtures.js";

const sources: PreviewSource[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  for (const source of sources.splice(0)) source.dispose();
  cleanupFixtureWorkspaces();
});

describe("measured preview source", () => {
  it("retains source until exit and retries cleanup when the host briefly holds a file", async () => {
    vi.useFakeTimers();
    let alive = true;
    const dispose = vi.fn().mockImplementationOnce(() => { throw new Error("busy fixture"); });
    releasePreviewSource({ directory: "fixture", files: [], dispose, verify: () => true }, () => alive);
    await vi.advanceTimersByTimeAsync(100);
    expect(dispose).not.toHaveBeenCalled();
    alive = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(dispose).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it("rejects preparation that replaces a tracked directory with a mutable external link", async () => {
    const workspace = fixtureWorkspace({ scripts: {}, files: { "vendor/index.js": "committed bytes" } });
    const source = await preparePreviewSource(workspace, commitFixtureWorkspace(workspace));
    if (source === null) throw new Error("source unavailable"); sources.push(source);
    renameSync(join(source.directory, "vendor"), join(source.directory, "prior-vendor"));
    symlinkSync(join(workspace, "vendor"), join(source.directory, "vendor"), process.platform === "win32" ? "junction" : "dir");
    expect(source.verify()).toBe(false);
    expect(readFileSync(join(workspace, "vendor/index.js"), "utf8")).toBe("committed bytes");
  });

  it("preserves binary blob bytes while excluding untracked dependencies", async () => {
    const workspace = fixtureWorkspace({ scripts: {}, files: { "asset.bin": "\0\xff\r\n\u0001\u00ff" } });
    const sha = commitFixtureWorkspace(workspace);
    mkdirSync(join(workspace, "node_modules"));
    writeFileSync(join(workspace, "node_modules", "mutable.js"), "untracked dependency");
    const source = await preparePreviewSource(workspace, sha);
    expect(source).not.toBeNull();
    if (source === null) throw new Error("source unavailable");
    sources.push(source);
    expect(readFileSync(join(source.directory, "asset.bin"))).toEqual(readFileSync(join(workspace, "asset.bin")));
    expect(existsSync(join(source.directory, "node_modules"))).toBe(false);
    source.dispose();
    source.dispose();
    expect(existsSync(source.directory)).toBe(false);
    expect(existsSync(workspace)).toBe(true);
  });

  it("refuses a checkout whose attributes change the committed blob bytes", async () => {
    const workspace = fixtureWorkspace({ scripts: {}, files: {
      ".gitattributes": "file.txt text eol=crlf\n", "file.txt": "committed LF\n",
    } });
    const sha = commitFixtureWorkspace(workspace);
    expect(await preparePreviewSource(workspace, sha)).toBeNull();
    expect(readFileSync(join(workspace, "file.txt"), "utf8")).toBe("committed LF\n");
  });

  it("ignores replacement refs and dirty repository attributes", async () => {
    const workspace = fixtureWorkspace({ scripts: {}, files: { "file.txt": "requested source\n" } });
    const sha = commitFixtureWorkspace(workspace);
    writeFileSync(join(workspace, "file.txt"), "newer source\n");
    await nodeGitRunner(workspace, ["add", "--", "file.txt"]);
    await nodeGitRunner(workspace, ["-c", "user.name=Preview Test", "-c", "user.email=preview@example.invalid",
      "-c", "commit.gpgsign=false", "commit", "-m", "replacement source"]);
    const newer = (await nodeGitRunner(workspace, ["rev-parse", "HEAD"])).stdout.trim();
    expect((await nodeGitRunner(workspace, ["replace", sha, newer])).code).toBe(0);
    mkdirSync(join(workspace, ".git", "info"), { recursive: true });
    writeFileSync(join(workspace, ".git", "info", "attributes"), "* text eol=crlf\n");
    const source = await preparePreviewSource(workspace, sha);
    expect(source).not.toBeNull();
    if (source === null) throw new Error("source unavailable");
    sources.push(source);
    expect(readFileSync(join(source.directory, "file.txt"), "utf8")).toBe("requested source\n");
    expect(readFileSync(join(workspace, "file.txt"), "utf8")).toBe("newer source\n");
  });

  it("refuses a repository subdirectory instead of extracting its enclosing product", async () => {
    const workspace = fixtureWorkspace({ scripts: {} });
    const sha = commitFixtureWorkspace(workspace);
    const nested = join(workspace, "nested");
    mkdirSync(nested);
    expect(await preparePreviewSource(nested, sha)).toBeNull();
  });

  it("refuses symbolic or malformed revisions before source preparation", async () => {
    const workspace = fixtureWorkspace({ scripts: {} });
    commitFixtureWorkspace(workspace);
    for (const sha of ["HEAD", "", "../source", "a".repeat(39), "a".repeat(65)]) {
      expect(await preparePreviewSource(workspace, sha)).toBeNull();
    }
    expect(await preparePreviewSource("relative/path", "a".repeat(40))).toBeNull();
  });

  it("refuses an unavailable temporary root through the source gate", async () => {
    const workspace = fixtureWorkspace({ scripts: {} });
    const sha = commitFixtureWorkspace(workspace);
    const unavailable = join(workspace, "absent-temp-root");
    for (const variable of ["TEMP", "TMP", "TMPDIR"]) vi.stubEnv(variable, unavailable);
    expect(await preparePreviewSource(workspace, sha)).toBeNull();
  });
});
