import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { CONTROLLED_PROFILE_VERSION, generateControlledProfile } from "./controlled-profile-generator.js";

/**
 * A golden tree that was never built is a file list. This file is what makes it a scaffold.
 *
 * WHY THE BUILD ARM IS OPT-IN (`MOE_SCAFFOLD_BUILD=1`). It installs from the network and runs four
 * child gates; unconditionally that would execute inside `pnpm --filter @moe/daemon test`, the gate
 * every row on this board runs, and would red on any offline host — making every later gate on the
 * board inadmissible. DoD 2's "a later row can decide whether to gate it differently" is exactly
 * that decision, deliberately left open.
 *
 * THE OPT-IN IS NOT PERMISSION TO SKIP IT. Two things stop it degrading into a decoration: the
 * ALWAYS-ON arm below asserts precisely the preconditions whose absence would make the expensive
 * arm vacuous, so this file is never a no-op; and the row's completion record has to quote the
 * expensive arm's own output, with a zero skipped count, from a run with the flag set.
 */

const RUN_BUILD = process.env.MOE_SCAFFOLD_BUILD === "1";

/** Four SEPARATE foreground legs. Never an `&&` chain (reports only the last status) or a pipe. */
const LEGS: readonly (readonly string[])[] = [
  ["install", "--frozen-lockfile"],
  ["typecheck"],
  ["test"],
  ["build"],
];

interface LegResult {
  readonly leg: string;
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function emitted(): ReadonlyMap<string, string> {
  const result = generateControlledProfile({
    productName: "scaffold-probe",
    profileVersion: CONTROLLED_PROFILE_VERSION,
  });
  if (!result.ok) {
    throw new Error(`the generator refused its own profile version: ${result.code}`);
  }
  return result.files;
}

/**
 * The child must not inherit this run's npm_* variables. Running under `pnpm --filter @moe/daemon`
 * exports `npm_config_filter=@moe/daemon`, and a child pnpm that honours it prints "No projects
 * matched the filters" and EXITS 0 — a vacuous green wearing a passing exit code.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("npm_") || key === "NODE_OPTIONS") {
      delete env[key];
    }
  }
  return env;
}

function runLeg(cwd: string, args: readonly string[]): LegResult {
  // Executable `pnpm`, argv array, shell:false. A hard-coded `pnpm.cmd` returns EINVAL on this host.
  const outcome = spawnSync("pnpm", [...args], { cwd, shell: false, encoding: "utf8", env: childEnv() });
  if (outcome.error !== undefined) {
    throw outcome.error;
  }
  return {
    leg: `pnpm ${args.join(" ")}`,
    status: outcome.status,
    stdout: outcome.stdout ?? "",
    stderr: outcome.stderr ?? "",
  };
}

const summarize = (result: LegResult): string =>
  result.status === 0
    ? `${result.leg} -> 0`
    : `${result.leg} -> ${String(result.status)}\n${result.stdout.slice(-2000)}\n${result.stderr.slice(-2000)}`;

interface ScriptBlock {
  readonly scripts?: Record<string, string>;
}

describe("the generated app", () => {
  it("emits the preconditions the build arm depends on", () => {
    const files = emitted();

    expect(files.get("pnpm-lock.yaml") ?? "").toMatch(/^lockfileVersion: /m);

    const manifests = [...files].filter(([path]) => path.endsWith("package.json"));
    expect(manifests).toHaveLength(3);
    for (const [path, body] of manifests) {
      expect(() => JSON.parse(body), path).not.toThrow();
    }

    const rootScripts = (JSON.parse(files.get("package.json") ?? "{}") as ScriptBlock).scripts;
    expect(rootScripts?.test).toBe("pnpm --recursive test");
    expect(rootScripts?.typecheck).toBe("pnpm --recursive typecheck");
    expect(rootScripts?.build).toBe("pnpm --recursive build");

    const packageTestScripts = manifests
      .filter(([path]) => path !== "package.json")
      .map(([, body]) => (JSON.parse(body) as ScriptBlock).scripts?.test);
    expect(packageTestScripts).toEqual(["vitest run", "vitest run"]);

    for (const [path, body] of files) {
      expect(body.includes("\r"), path).toBe(false);
    }
  });

  it.runIf(RUN_BUILD)(
    "installs from its own committed lockfile, typechecks, tests and builds",
    () => {
      const files = emitted();
      const dir = mkdtempSync(join(tmpdir(), "moe-scaffold-"));
      try {
        for (const [relative, body] of files) {
          const target = join(dir, relative);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, body, "utf8");
        }

        const lockBefore = readFileSync(join(dir, "pnpm-lock.yaml"), "utf8");

        const results: LegResult[] = [];
        for (const args of LEGS) {
          const result = runLeg(dir, args);
          results.push(result);
          if (result.status !== 0) {
            break;
          }
        }

        // Every leg ran AND every leg exited 0. A short array reds and names the leg that stopped it.
        expect(results.map(summarize)).toEqual(LEGS.map((args) => `pnpm ${args.join(" ")} -> 0`));

        // `pnpm build` exiting 0 is not the same as `pnpm build` EMITTING. Name the artifacts.
        for (const artifact of ["packages/web/dist/index.html", "packages/api/dist/server.js"]) {
          expect(existsSync(join(dir, artifact)), artifact).toBe(true);
        }

        // DoD 3: a scaffold whose first install rewrites its own lockfile is not deterministic.
        expect(readFileSync(join(dir, "pnpm-lock.yaml"), "utf8")).toBe(lockBefore);

        // Exit 0 is NOT evidence: "No test files found" is also exit 0. The count line is.
        const testLeg = results[2];
        const counts = [...(testLeg?.stdout ?? "").matchAll(/Test Files\s+(\d+) passed/g)].map((match) =>
          Number(match[1] ?? "0"),
        );
        expect(counts.length).toBeGreaterThanOrEqual(1);
        for (const count of counts) {
          expect(count).toBeGreaterThanOrEqual(1);
        }
        expect(counts.reduce((total, count) => total + count, 0)).toBeGreaterThanOrEqual(2);

        process.stdout.write(`CHILD RUN legs: ${results.map((r) => `${r.leg}=${String(r.status)}`).join(", ")}\n`);
        process.stdout.write(`CHILD RUN test count lines: ${JSON.stringify(counts)}\n`);
        process.stdout.write(`CHILD RUN pnpm test stdout tail:\n${(testLeg?.stdout ?? "").slice(-3000)}\n`);
      } finally {
        // Epic rail 4: anything this epic starts, it stops - including on the throwing path.
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
    },
    1_800_000,
  );
});
