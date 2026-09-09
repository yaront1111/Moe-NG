import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { SqliteEventStore } from "@moe/store";
import { activeCompiledGraphs } from "../../../apps/daemon/src/orchestrator/compiled-node-source.js";
import { compiledExecutionRef } from "../../../apps/daemon/src/orchestrator/compiled-execution-ref.js";
import { SEEDED_LOW_RISK_TASK } from "./foundation-fixtures.js";
import type { J1Scratch } from "./j1-loop-harness.js";

/** The agent receives a clean checkout; its failing test belongs to the original commit. */
export function initializeJ1Repository(workspace: string): void {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  const git = (...args: string[]) => execFileSync("git", ["-c", `core.hooksPath=${join(workspace, ".git", "fixture-empty-hooks")}`, ...args],
    { cwd: workspace, env, shell: false, windowsHide: true, stdio: "pipe", timeout: 30_000 });
  git("init", "--quiet", "-b", "main");
  git("config", "user.name", "J1 process fixture"); git("config", "user.email", "j1@moe-next.invalid");
  git("config", "core.autocrlf", "false");
  git("add", "--", "test.mjs"); git("commit", "--quiet", "-m", "Record original verifier test");
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
