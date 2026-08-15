import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { archiveSource } from "../../scripts/release/supply-chain.mjs";

const roots: string[] = [];
const refusal = Object.freeze({
  code: "RELEASE_SUPPLY_CHAIN_REFUSED",
  ok: false,
  reason: "SOURCE_ARCHIVE_FAILED",
  refusedBy: "RELEASE_SUPPLY_CHAIN",
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "moe-release-archive-"));
  roots.push(root);
  return root;
}

function committedRepository(root: string): { repositoryRoot: string; sourceSha: string } {
  const repositoryRoot = join(root, "repository");
  mkdirSync(repositoryRoot, { recursive: true });
  execFileSync("git", ["init", "--quiet"], { cwd: repositoryRoot });
  execFileSync("git", ["config", "user.email", "release-test@example.invalid"], { cwd: repositoryRoot });
  execFileSync("git", ["config", "user.name", "Release Test"], { cwd: repositoryRoot });
  writeFileSync(join(repositoryRoot, "tracked.txt"), "release source\n", "utf8");
  execFileSync("git", ["add", "tracked.txt"], { cwd: repositoryRoot });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: repositoryRoot });
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  return { repositoryRoot, sourceSha };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("release archive cleanup", () => {
  it("preserves the exact success result when cleanup throws", async () => {
    const root = temporaryRoot();
    const source = committedRepository(root);
    const destination = join(root, "destination");
    const cleanup = vi.fn(() => { throw new Error("EBUSY: archive held"); });
    const reporter = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(archiveSource({ ...source, destination }, { rmSync: cleanup })).resolves.toEqual({
      destination,
      ok: true,
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledWith(`${destination}.tar`, { force: true });
    expect(reporter).toHaveBeenCalledWith(
      `release temporary cleanup failed: ${destination}.tar: Error: EBUSY: archive held`,
    );
  });

  it("preserves the exact SOURCE_ARCHIVE_FAILED refusal when cleanup throws", async () => {
    const root = temporaryRoot();
    const destination = join(root, "destination");
    const archive = `${destination}.tar`;
    writeFileSync(archive, "held archive", "utf8");
    const cleanup = vi.fn(() => { throw new Error("EBUSY: archive held"); });
    const reporter = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(archiveSource({
      destination,
      repositoryRoot: join(root, "missing-repository"),
      sourceSha: "0".repeat(40),
    }, { rmSync: cleanup })).resolves.toEqual(refusal);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledWith(archive, { force: true });
    expect(reporter).toHaveBeenCalledWith(
      `release temporary cleanup failed: ${archive}: Error: EBUSY: archive held`,
    );
  });

  it("removes the real archive after success", async () => {
    const root = temporaryRoot();
    const source = committedRepository(root);
    const destination = join(root, "destination");

    await expect(archiveSource({ ...source, destination })).resolves.toEqual({ destination, ok: true });
    expect(existsSync(`${destination}.tar`)).toBe(false);
  });

  it("removes a pre-existing archive after the exact SOURCE_ARCHIVE_FAILED refusal", async () => {
    const root = temporaryRoot();
    const destination = join(root, "destination");
    const archive = `${destination}.tar`;
    writeFileSync(archive, "stale archive", "utf8");

    await expect(archiveSource({
      destination,
      repositoryRoot: join(root, "missing-repository"),
      sourceSha: "0".repeat(40),
    })).resolves.toEqual(refusal);
    expect(existsSync(archive)).toBe(false);
  });
});
