/**
 * Tests for the Foundation canary harness itself.
 *
 * The harness is the only thing in this epic allowed to terminate real
 * processes, and it is the thing a failing journey will be debugged through. So
 * its own properties — fixed seeds, cleanup on the failure path, a refusal with
 * a stable code when a caller asks for an undeclared boundary — are asserted
 * here rather than assumed. Every refusal assertion pins the exact reason code
 * (epic rail 6); asserting "it refused" would survive a second refusal layer
 * answering first.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DECLARED_BOUNDARIES,
  E2E_ERROR_CODES,
  E2E_SEED,
  createE2eRun,
  createLogicalClock,
  deterministicId,
  finishE2eRun,
  withE2eRun,
} from "./e2e-harness.js";
import { KILL_TARGETS, killAtDeclaredBoundary, spawnHarnessProcess } from "./e2e-process.js";
import {
  SEEDED_LOW_RISK_TASK,
  createScratchProjectRepository,
} from "./foundation-fixtures.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const harnessDirectory = "tests/e2e/foundation";
const REPOSITORY_SCAN_TIMEOUT_MS = 30_000;

/**
 * Every non-test module in this directory, read off disk rather than listed by
 * hand: a hand-maintained list would silently stop covering a module the moment
 * someone added one, which is the "sweep that produces nothing" failure in a
 * slower form.
 */
async function harnessModules(): Promise<string[]> {
  return (await sourceFilesUnder(harnessDirectory)).filter(
    (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
  );
}

/** Trees that must never reach into the harness. */
const PRODUCTION_TREES = ["packages", "apps", "adapters"] as const;

async function sourceFilesUnder(directory: string): Promise<string[]> {
  const absolute = join(repositoryRoot, directory);
  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    if (entry.isDirectory()) files.push(...(await sourceFilesUnder(path)));
    else if (/\.(?:ts|js|mjs|json)$/u.test(entry.name)) files.push(path);
  }
  return files;
}

describe("harness determinism", () => {
  it("exposes seeds as fixed literals that do not change between reads", () => {
    expect(E2E_SEED.runPrefix).toBe("moe-e2e-foundation");
    expect(E2E_SEED.logicalEpochUtc).toBe("2026-01-01T00:00:00.000Z");
    expect(E2E_SEED.logicalStepMs).toBe(1000);
    expect(Object.isFrozen(E2E_SEED)).toBe(true);
  });

  it("derives the same identifier for the same prefix and ordinal", () => {
    expect(deterministicId("run", 7)).toBe("moe-e2e-foundation-run-0007");
    expect(deterministicId("run", 7)).toBe(deterministicId("run", 7));
    expect(deterministicId("run", 8)).toBe("moe-e2e-foundation-run-0008");
  });

  it("advances the logical clock by the fixed step instead of reading a wall clock", () => {
    const clock = createLogicalClock();
    expect(clock.observedAt()).toBe("2026-01-01T00:00:00.000Z");
    expect(clock.observedAt()).toBe("2026-01-01T00:00:01.000Z");
    expect(createLogicalClock().observedAt()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("contains no wall-clock or random source in any harness module", async () => {
    const modules = await harnessModules();
    expect(modules.length).toBeGreaterThanOrEqual(4);
    for (const relative of modules) {
      const text = await readFile(join(repositoryRoot, relative), "utf8");
      const offenders = ["Math.random", "Date.now", "new Date(", "performance.now"].filter(
        (needle) => text.includes(needle),
      );
      expect({ relative, offenders }).toEqual({ relative, offenders: [] });
    }
  });
});

describe("harness cleanup", () => {
  it("runs every registered cleanup in reverse order when the body succeeds", async () => {
    const order: string[] = [];
    const run = createE2eRun(1);
    run.registerCleanup("first", () => void order.push("first"));
    run.registerCleanup("second", () => void order.push("second"));
    const outcome = await finishE2eRun(run);
    expect(outcome).toEqual({ ok: true });
    expect(order).toEqual(["second", "first"]);
  });

  it("still runs cleanup when the body throws, and rethrows the body failure", async () => {
    const order: string[] = [];
    const boom = new Error("journey failed");
    await expect(
      withE2eRun(2, (run) => {
        run.registerCleanup("scratch", () => void order.push("scratch"));
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(order).toEqual(["scratch"]);
  });

  it("runs later cleanups after an earlier one throws and reports E2E_CLEANUP_FAILED", async () => {
    const order: string[] = [];
    const run = createE2eRun(3);
    run.registerCleanup("outer", () => void order.push("outer"));
    run.registerCleanup("broken", () => {
      throw new Error("handle still held");
    });
    const outcome = await finishE2eRun(run);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.code).toBe("E2E_CLEANUP_FAILED");
    expect(outcome.ok === false && outcome.failures.map((entry) => entry.label)).toEqual([
      "broken",
    ]);
    expect(order).toEqual(["outer"]);
  });

  it("raises the cleanup failure with the body error as cause when both fail", async () => {
    const boom = new Error("journey failed");
    await expect(
      withE2eRun(8, (run) => {
        run.registerCleanup("broken", () => {
          throw new Error("handle still held");
        });
        throw boom;
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("E2E_CLEANUP_FAILED") as unknown as string,
      cause: boom,
    });
  });

  it("refuses to finish a run it did not create rather than reporting a clean exit", async () => {
    const foreign = { runId: "foreign", clock: createLogicalClock(), registerCleanup: () => {} };
    await expect(finishE2eRun(foreign)).rejects.toThrow(/produced by createE2eRun/u);
  });

  it("removes a scratch project repository created during the run", async () => {
    let scratch = "";
    await withE2eRun(4, async (run) => {
      scratch = await createScratchProjectRepository(run);
      expect((await stat(scratch)).isDirectory()).toBe(true);
    });
    await expect(stat(scratch)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("declared-boundary process control", () => {
  it("declares a non-empty frozen boundary list and the design's three kill targets", () => {
    expect(DECLARED_BOUNDARIES.length).toBeGreaterThan(0);
    expect(Object.isFrozen(DECLARED_BOUNDARIES)).toBe(true);
    expect([...KILL_TARGETS].sort()).toEqual(["agent", "daemon", "runner"]);
  });

  it("refuses an undeclared boundary with E2E_UNDECLARED_BOUNDARY and does not kill", async () => {
    await withE2eRun(5, async (run) => {
      const handle = spawnHarnessProcess(run, "agent", ["-e", "setTimeout(() => {}, 60000)"]);
      const refusal = killAtDeclaredBoundary(handle, "WHENEVER_I_FEEL_LIKE_IT");
      expect(refusal.ok).toBe(false);
      expect(refusal.ok === false && refusal.code).toBe("E2E_UNDECLARED_BOUNDARY");
      expect(handle.killedAt).toBe(null);
      const accepted = killAtDeclaredBoundary(handle, "AFTER_PROCESS_READY");
      expect(accepted).toEqual({ ok: true, boundary: "AFTER_PROCESS_READY" });
      expect(handle.killedAt).toBe("AFTER_PROCESS_READY");
    });
  });

  it("refuses a second kill of the same handle with E2E_PROCESS_ALREADY_KILLED", async () => {
    await withE2eRun(6, async (run) => {
      const handle = spawnHarnessProcess(run, "runner", ["-e", "setTimeout(() => {}, 60000)"]);
      expect(killAtDeclaredBoundary(handle, "AFTER_PROCESS_READY").ok).toBe(true);
      const second = killAtDeclaredBoundary(handle, "AFTER_PROCESS_READY");
      expect(second.ok === false && second.code).toBe("E2E_PROCESS_ALREADY_KILLED");
    });
  });

  it("lists every error code it can return, frozen, with no duplicates", () => {
    expect([...E2E_ERROR_CODES].sort()).toEqual([
      "E2E_CLEANUP_FAILED",
      "E2E_PROCESS_ALREADY_KILLED",
      "E2E_UNDECLARED_BOUNDARY",
      "E2E_UNKNOWN_KILL_TARGET",
    ]);
    expect(new Set(E2E_ERROR_CODES).size).toBe(E2E_ERROR_CODES.length);
  });

  it("refuses an unknown kill target with E2E_UNKNOWN_KILL_TARGET before spawning", async () => {
    await withE2eRun(7, (run) => {
      expect(() => spawnHarnessProcess(run, "database" as never, ["-e", ""])).toThrow(
        /E2E_UNKNOWN_KILL_TARGET/u,
      );
    });
  });
});

describe("harness containment", () => {
  it("is imported by no package, app, or adapter source", async () => {
    const scanned = (await Promise.all(PRODUCTION_TREES.map(sourceFilesUnder))).flat();
    expect(scanned.length).toBeGreaterThan(100);
    const importers: string[] = [];
    for (const relative of scanned) {
      const text = await readFile(join(repositoryRoot, relative), "utf8");
      if (text.includes("e2e-harness") || text.includes("tests/e2e/foundation")) {
        importers.push(relative);
      }
    }
    expect(importers).toEqual([]);
  }, REPOSITORY_SCAN_TIMEOUT_MS);

  it("keeps fixtures on the input side: they import nothing from apps/", async () => {
    const text = await readFile(
      join(repositoryRoot, `${harnessDirectory}/foundation-fixtures.ts`),
      "utf8",
    );
    expect(text).not.toContain("apps/daemon");
    expect(text).not.toContain("../../../apps");
  });
});

describe("seeded inputs", () => {
  it("seeds one low-risk moe-next task with a frozen exclusive definition", () => {
    expect(SEEDED_LOW_RISK_TASK.riskTier).toBe("LOW");
    expect(SEEDED_LOW_RISK_TASK.exclusive).toBe(true);
    expect(SEEDED_LOW_RISK_TASK.taskId).toBe("moe-e2e-foundation-task-0001");
    expect(Object.isFrozen(SEEDED_LOW_RISK_TASK)).toBe(true);
  });

  // The pinned-observation fixture this file used to assert is gone: a literal
  // `C:/pinned/claude/claude.exe` with placeholder digests is not host evidence,
  // and the canary's self-host claim rests on the runtime this machine really
  // has. Its replacement — production discovery plus the acceptance gate — is
  // asserted in `foundation-fixtures.test.ts`, against this host.
});
