/** No durable facts are seeded here: only tests committed in the lane's scratch repository. */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const NODE_TEST = [
  'import { add, multiply } from "./math.mjs";',
  'if (add(2, 3) !== 5) throw new Error("add is wrong");',
  'if (multiply(2, 3) !== 6) throw new Error("multiply is wrong");',
  'console.log("math.mjs passes");',
].join("\n");

/** GIT_* cannot redirect this local commit into the developer's checkout. */
function workspaceGit(workspace: string, args: readonly string[]): void {
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  execFileSync("git", [...args], {
    cwd: workspace, env: { ...env, GIT_OPTIONAL_LOCKS: "0" }, shell: false,
    windowsHide: true, timeout: 10_000, stdio: "pipe",
  });
}

export function prepareMultiNodeWorkspace(
  workspace: string, keys: readonly string[],
): Readonly<Record<string, string>> {
  const workspaces: Record<string, string> = {};
  for (const key of keys) {
    const directory = join(workspace, key);
    mkdirSync(directory);
    writeFileSync(join(directory, "test.mjs"), NODE_TEST, "utf8");
    workspaces[key] = directory;
  }
  // The baseline may precede the first implementation. Afterwards every present module
  // must pass; criterion verification separately requires ALL three exact checks.
  writeFileSync(join(workspace, "test.mjs"), [
    'import { existsSync } from "node:fs";',
    `const keys = ${JSON.stringify(keys)};`,
    'let tested = 0; for (const key of keys) {',
    'if (!existsSync(new URL(`./${key}/math.mjs`, import.meta.url))) continue;',
    'await import(`./${key}/test.mjs`); tested++; }',
    'if (tested === 0) throw new Error("no module was implemented");',
  ].join("\n"), "utf8");
  workspaceGit(workspace, ["add", "--", "test.mjs", ...keys.map((key) => `${key}/test.mjs`)]);
  workspaceGit(workspace, ["-c", "user.name=Moe Lane", "-c", "user.email=lane@moe.invalid",
    "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Contract lane test baseline"]);
  return Object.freeze(workspaces);
}

/** Same three-file launch shape as landingSeatDouble; only the provider seat is doubled. */
export function multiNodeSeatDouble(
  dir: string, workspace: string, keys: readonly string[], waitForReview = false,
): { command: string } {
  const jsPath = join(dir, "multi-node-seat.js");
  const cmdPath = join(dir, "multi-node-seat.cmd");
  const shPath = join(dir, "multi-node-seat.sh");
  writeFileSync(jsPath, [
    'const { writeFileSync } = require("node:fs");',
    `const keys = ${JSON.stringify(keys)};`,
    'const mission = require("node:fs").readFileSync(0, "utf8");',
    'const matches = keys.filter(key => mission.includes(`${key}/math.mjs`));',
    'if (matches.length !== 1) throw new Error("LANE_SEAT_MISSION_AMBIGUOUS");',
    'const key = matches[0];',
    'const code = key === keys[2]',
    '  ? `import { add } from "../${keys[0]}/math.mjs";\nimport { multiply } from "../${keys[1]}/math.mjs";\nexport { add, multiply };\n`',
    '  : "export const add = (a, b) => a + b;\\nexport const multiply = (a, b) => a * b;\\n";',
    `writeFileSync(require("node:path").join(${JSON.stringify(workspace)}, key, "math.mjs"), code);`,
    'console.log(`LANE_SEAT_WROTE ${key}`);',
    ...(waitForReview ? [
      // Keep the seat alive until its HTTP round is recorded, so ONCE settlement cannot
      // race the external report. A failing caller kills this child with its wrapper.
      `const ack = require("node:path").join(${JSON.stringify(dir)}, key + ".reviewed");`,
      'const timer = setInterval(() => { if (require("node:fs").existsSync(ack)) clearInterval(timer); }, 100);',
    ] : []),
  ].join("\n"), "utf8");
  writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "%~dp0multi-node-seat.js" %*\r\nexit /b %ERRORLEVEL%\r\n`, "utf8");
  writeFileSync(shPath, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/multi-node-seat.js" "$@"\n`, "utf8");
  chmodSync(shPath, 0o755);
  return { command: process.platform === "win32" ? cmdPath : shPath };
}
