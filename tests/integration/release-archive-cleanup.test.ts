import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { archiveSource } from "../../scripts/release/supply-chain.mjs";

/**
 * This file is process-bound, so it cannot run on vitest's inherited 5000ms default: the
 * root vitest.config.ts sets no `testTimeout`, and every case here spawns SEVEN children —
 * six `git` calls through execFileSync in `committedRepository` plus the `tar` that
 * `archiveSource` runs.
 *
 * 30s is sized against a HEALTHY host (measured on this box: ~25ms per `git` spawn, whole
 * file 509ms), which puts it around two orders of magnitude above real cost. It is
 * deliberately NOT sized to survive a degraded one — the 2026-08-19 incident on this host
 * (a service leaked its handle table to the 2^24 ceiling and `CreateProcess` cost 7-22s)
 * needed 150s+ to pass, and a timeout that large would convert a broken host into a slow
 * green. A spawn-latency cliff must still fail here, loudly, as the host problem it is.
 */
vi.setConfig({ testTimeout: 30_000 });

type RemoveOptions = { force: true; maxRetries: number; recursive: true; retryDelay: number };

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

/**
 * Teardown that cannot silently leak. The previous `for (const root of roots.splice(0))`
 * emptied the array BEFORE the first removal ran, so one EPERM — a timed-out child still
 * holding a temp dir is the realistic Windows case — aborted the loop and dropped every
 * remaining root with no record that they had ever existed.
 *
 * Two mechanisms, deliberately layered. `maxRetries`/`retryDelay` are rmSync's own and
 * handle the common transient hold, but they are internal to the native call and cannot be
 * observed through an injected remover; the outer two-attempt loop is the part the
 * regression tests can actually exercise. A root is pruned from `pending` ONLY after it is
 * gone, a persistent failure leaks at most its own dir, and the throw is what makes a leak
 * loud instead of silent.
 */
function removeTemporaryRoots(
  pending: string[],
  remove: (path: string, options: RemoveOptions) => void = rmSync,
): void {
  const failures: { error: unknown; root: string }[] = [];
  for (const root of [...pending]) {
    let removed = false;
    let failure: unknown = null;
    for (let attempt = 0; attempt < 2 && !removed; attempt += 1) {
      try {
        remove(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
        removed = true;
      } catch (error) {
        failure = error;
      }
    }
    if (!removed) {
      failures.push({ error: failure, root });
      continue;
    }
    // Guarded because splice(-1, 1) would silently drop an UNRELATED root if `root` were
    // somehow already gone from the array.
    const pruned = pending.indexOf(root);
    if (pruned >= 0) pending.splice(pruned, 1);
  }
  if (failures.length > 0) {
    throw new Error(
      `RELEASE_ARCHIVE_TEARDOWN_LEAK: ${failures.map(({ error, root }) => `${root}: ${error}`).join("; ")}`,
    );
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  removeTemporaryRoots(roots);
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

describe("release archive teardown", () => {
  function localRoot(): string {
    return mkdtempSync(join(tmpdir(), "moe-release-teardown-"));
  }

  const held = (): Error => Object.assign(new Error("EPERM: held"), { code: "EPERM" });

  it("retries a transient removal failure and prunes every root it removed", () => {
    const held1 = localRoot();
    const held2 = localRoot();
    const pending = [held1, held2];
    let firstAttempt = true;
    const remove = vi.fn((path: string, options: RemoveOptions) => {
      if (path === held1 && firstAttempt) {
        firstAttempt = false;
        throw held();
      }
      rmSync(path, options);
    });

    try {
      removeTemporaryRoots(pending, remove);

      expect(existsSync(held1)).toBe(false);
      expect(existsSync(held2)).toBe(false);
      expect(pending).toEqual([]);
      expect(remove.mock.calls.length).toBeGreaterThanOrEqual(3);
    } finally {
      for (const root of [held1, held2]) rmSync(root, { force: true, recursive: true });
    }
  });

  it("reports RELEASE_ARCHIVE_TEARDOWN_LEAK and keeps only the failing root pending", () => {
    const stuck = localRoot();
    const removable = localRoot();
    const pending = [stuck, removable];
    const remove = vi.fn((path: string, options: RemoveOptions) => {
      if (path === stuck) throw held();
      rmSync(path, options);
    });

    try {
      let thrown: unknown = null;
      try {
        removeTemporaryRoots(pending, remove);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message.includes("RELEASE_ARCHIVE_TEARDOWN_LEAK")).toBe(true);
      expect(message.includes(stuck)).toBe(true);
      expect(existsSync(removable)).toBe(false);
      expect(pending).toEqual([stuck]);
    } finally {
      rmSync(stuck, { force: true, recursive: true });
    }
  });
});
