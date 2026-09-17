import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SqliteEventStore } from "@moe/store";
import { activeCompiledGraphs } from "../../../apps/daemon/src/orchestrator/compiled-node-source.js";
import { compiledExecutionRef } from "../../../apps/daemon/src/orchestrator/compiled-execution-ref.js";
import { SEEDED_LOW_RISK_TASK } from "./foundation-fixtures.js";
import type { J1Scratch } from "./j1-loop-harness.js";

/** One directory's git, with the host's GIT_* environment and hooks kept out of the fixture. */
function gitIn(directory: string): (...args: string[]) => void {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  return (...args) => { execFileSync("git", ["-c", `core.hooksPath=${join(directory, ".git", "fixture-empty-hooks")}`, ...args],
    { cwd: directory, env, shell: false, windowsHide: true, stdio: "pipe", timeout: 30_000 }); };
}

/** The agent receives a clean checkout; its failing test belongs to the original commit. */
export function initializeJ1Repository(workspace: string): void {
  const git = gitIn(workspace);
  git("init", "--quiet", "-b", "main");
  git("config", "user.name", "J1 process fixture"); git("config", "user.email", "j1@moe-next.invalid");
  git("config", "core.autocrlf", "false");
  git("add", "--", "test.mjs"); git("commit", "--quiet", "-m", "Record original verifier test");
}

/**
 * The scratch ROOT as the daemon's own project root. `project.activate` measures its repository
 * and distribution members with `git rev-parse` FROM `MOE_PROJECT_ROOT`, so a root that is not a
 * repository would trade the shared-backups refusal for ACTIVATION_REPOSITORY_UNMEASURED. One
 * empty commit gives both members a HEAD; nothing is added, so the workspace repository nested
 * below stays its own checkout. Idempotent: a J3 restart finds the root already initialised.
 */
export function initializeProjectRoot(root: string): void {
  if (existsSync(join(root, ".git"))) return;
  const git = gitIn(root);
  git("init", "--quiet", "-b", "main");
  git("config", "user.name", "J1 process fixture"); git("config", "user.email", "j1@moe-next.invalid");
  git("-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "Scratch project root");
}

/** Resolve the node actually sealed by the seed, including its goal, run and graph identity. */
export function executionNodeRef(scratch: J1Scratch): string {
  if (scratch.compiledExecution !== true) return SEEDED_LOW_RISK_TASK.nodeRef;
  const store = SqliteEventStore.openForProject(scratch.storePath, scratch.projectId);
  try {
    const graphs = activeCompiledGraphs(store, scratch.projectId).filter((graph) =>
      graph.content.nodeAuthority.definitions.some((node) => node.nodeKey === SEEDED_LOW_RISK_TASK.nodeRef));
    if (graphs.length !== 1) throw new Error("J1_COMPILED_NODE_SCOPE_UNREADABLE");
    return compiledExecutionRef(scratch.projectId, graphs[0]!, SEEDED_LOW_RISK_TASK.nodeRef);
  } finally { store.close(); }
}
