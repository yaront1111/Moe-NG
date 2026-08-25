import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MOE_PS1 } from "./pack-docs.js";

/**
 * The launcher this file emits is the FIRST thing an operator runs, and it runs before
 * any code this repository controls: the artifact bundles no runtime, so `moe.ps1` on a
 * machine without node is a real and expected shape.
 *
 * The rail is that the absence is REFUSED, by name and with a non-zero code. `& node`
 * against a missing runtime raises CommandNotFoundException, which never assigns
 * `$LASTEXITCODE`, so `exit $LASTEXITCODE` exits 0 and a wrapper supervising the launcher
 * records a missing runtime as a successful run.
 *
 * The script is spawned as BYTES for that reason: the constant is written to disk and
 * driven through a real `pwsh -File` with node scrubbed off PATH, because the defect is
 * in what PowerShell does with the text and no assertion over the string could see it.
 */

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

const SEPARATOR = process.platform === "win32" ? ";" : ":";

const PATH_ENTRIES: readonly string[] = (process.env["PATH"] ?? "")
  .split(SEPARATOR)
  .filter((entry) => entry !== "");

/** Every name a PATH lookup would accept, so "scrubbed" is not just the bare suffix. */
const executableNames = (command: string): readonly string[] =>
  process.platform === "win32"
    ? [`${command}.exe`, `${command}.cmd`, `${command}.bat`]
    : [command];

/** Resolved against a NAMED entry list, so the same helper can witness a scrub. */
function locate(command: string, entries: readonly string[]): string | null {
  for (const entry of entries) {
    for (const name of executableNames(command)) {
      const full = join(entry, name);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

const withoutNode = (): readonly string[] =>
  PATH_ENTRIES.filter((entry) => locate("node", [entry]) === null);

/**
 * One PATH key, whatever case the host spelled it: on Windows the environment is
 * case-insensitive, and handing the child both `Path` and `PATH` leaves which one it
 * reads to the platform.
 */
function envWithPath(entries: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.toLowerCase() === "path") continue;
    env[key] = value;
  }
  env["PATH"] = entries.join(SEPARATOR);
  return env;
}

function emitLauncher(): string {
  const root = mkdtempSync(join(tmpdir(), "moe-pack-docs-"));
  roots.push(root);
  const script = join(root, "moe.ps1");
  writeFileSync(script, MOE_PS1, "utf8");
  return script;
}

interface Run {
  readonly output: string;
  readonly status: number | null;
}

/** pwsh by ABSOLUTE path: the child's PATH is edited, and command lookup follows it. */
function runLauncher(entries: readonly string[]): Run {
  const pwsh = locate("pwsh", PATH_ENTRIES);
  if (pwsh === null) throw new Error("pwsh disappeared between the guard and the run");
  const result = spawnSync(
    pwsh,
    ["-NoProfile", "-NonInteractive", "-File", emitLauncher(), "--help"],
    { encoding: "utf8", env: envWithPath(entries), shell: false },
  );
  return { output: `${result.stderr}${result.stdout}`, status: result.status };
}

describe.skipIf(locate("pwsh", PATH_ENTRIES) === null)("moe.ps1 without a runtime", () => {
  it("refuses by name with the host-visible form of 9009 instead of success", () => {
    const scrubbed = withoutNode();
    // Both sides, so the case cannot pass on a host that never had node on PATH: the
    // launcher would then refuse for a condition this run did not create.
    expect(locate("node", PATH_ENTRIES)).not.toBeNull();
    expect(locate("node", scrubbed)).toBeNull();
    const run = runLauncher(scrubbed);
    expect(run.status).toBe(process.platform === "win32" ? 9009 : (9009 & 0xff));
    expect(run.output).toContain("MOE_CLI_NODE_MISSING");
  });

  it("hands a present runtime its own exit code, so the missing-node status names one condition", () => {
    // The entry the launcher joins does not exist beside the emitted script, so node
    // itself refuses. That is the point: the run reached node, and neither the code nor
    // the refusal line belongs to the launcher.
    const run = runLauncher([dirname(process.execPath), ...PATH_ENTRIES]);
    expect(run.status).not.toBe(process.platform === "win32" ? 9009 : (9009 & 0xff));
    expect(run.status).not.toBe(0);
    expect(run.output).not.toContain("MOE_CLI_NODE_MISSING");
  });
});
