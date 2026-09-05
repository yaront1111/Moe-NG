import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createJ1Scratch } from "./j1-loop-harness.js";
import type { J1Scratch } from "./j1-loop-harness.js";
import { removeScratches } from "./j1-ledger-view.js";
import { workspaceDigest } from "./j4-replan-harness.js";
const scratches: J1Scratch[] = [];
afterEach(() => { removeScratches(scratches.splice(0)); });
it("hands compiled execution a committed clean Git baseline with its failing test already tracked", () => {
  const scratch = createJ1Scratch({ compiledExecution: true }); scratches.push(scratch);
  expect(scratch.compiledExecution).toBe(true);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: scratch.workspace, shell: false, windowsHide: true, encoding: "utf8" }).trim();
  expect(git("status", "--porcelain")).toBe("");
  expect(git("ls-tree", "--name-only", "HEAD")).toBe("test.mjs");
  expect(git("show", "HEAD:test.mjs")).toContain('from "./math.mjs"');
}, 120_000);
it("measures deliverable bytes while excluding repository metadata from the rejection delta", () => {
  const scratch = createJ1Scratch({ compiledExecution: true }); scratches.push(scratch);
  const before = workspaceDigest(scratch);
  writeFileSync(join(scratch.workspace, ".git", "fixture-observation"), "metadata only");
  expect(workspaceDigest(scratch)).toBe(before);
  writeFileSync(join(scratch.workspace, "math.mjs"), "wrong implementation\n");
  expect(workspaceDigest(scratch)).not.toBe(before);
}, 120_000);
