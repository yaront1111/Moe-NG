/**
 * THE 3-NODE SCRATCH: one goal, one PRD, three criteria, three workspaces.
 *
 * THE SHAPE IS LOAD-BEARING. `node-alpha` and `node-beta` are INDEPENDENT of each other and
 * `node-omega` depends on BOTH, so ONE graph reaches both facts under test: two nodes staffed
 * in the same pass, and a third withheld until its hard dependencies are ACCEPTED. A straight
 * a->b->c chain would make the parallel arm unreachable; three independent nodes would make
 * the blocking arm unreachable.
 *
 * Each node gets its OWN workspace holding its OWN failing test, because the spawner sets the
 * agent's cwd to the node's workspace (`agent-spawner.ts:151`) and the shipped `fake-agent.mjs`
 * writes `math.mjs` there. That is what lets ONE shim serve all three nodes: the agent learns
 * which node it is on from the mission the wrapper handed it, never from a flag.
 *
 * NO WALL CLOCK AND NO RANDOM SOURCE (`e2e-harness.test.ts` scans this directory by plain
 * substring): scratch uniqueness comes from `mkdtempSync`, and every clock reading is a
 * PARAMETER the test file supplies.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { J1Scratch } from "./j1-loop-harness.js";

/** The three sealed node keys, in the order the graph binds them. */
export const ALPHA = "node-alpha";
export const BETA = "node-beta";
export const OMEGA = "node-omega";
export const MULTI_NODE_KEYS = Object.freeze([ALPHA, BETA, OMEGA]);

/** One criterion per node, so the coverage read's denominator is exactly three. */
export const CRITERIA = Object.freeze([
  Object.freeze({
    criterionId: "crit-alpha", nodeKey: ALPHA,
    statement: "alpha/math.mjs exports add and multiply and its own test passes.",
  }),
  Object.freeze({
    criterionId: "crit-beta", nodeKey: BETA,
    statement: "beta/math.mjs exports add and multiply and its own test passes.",
  }),
  Object.freeze({
    criterionId: "crit-omega", nodeKey: OMEGA,
    statement: "omega/math.mjs integrates alpha and beta and its own test passes.",
  }),
]);

/** The goal identity. Production mints `goal-${commandId}`, so the two are stated as a pair. */
export const GOAL_CREATE_COMMAND_ID = "multi-1";
export const GOAL_ID = `goal-${GOAL_CREATE_COMMAND_ID}`;
export const PROJECT_ID = "moe-e2e-multi-node";
export const CONTRACT_ID = "multi-node-contract-1";
export const REVISION_ID = "multi-node-revision-1";

export const PRD_TEXT = [
  "# Three nodes, one goal",
  "",
  "Two independent modules and one that integrates them. The build order is a fact of the",
  "graph, not of the operator's patience: alpha and beta are unrelated, omega needs both.",
  "",
].join("\n");

/** Fixed, not minted: a random credential would be a random source in a scanned module. */
export const OPERATOR_CREDENTIAL = "moe-e2e-multi-node-operator-credential";
export const AGENT_SESSION = "sess-multi-node-agent";
export const AGENT_SECRET = "secret-multi-node-agent";
export const HUMAN_SESSION = "sess-multi-node-human";
export const HUMAN_SECRET = "secret-multi-node-human";

export interface MultiNodeScratch extends J1Scratch {
  /** Node key -> the workspace that node's agent is spawned into. */
  readonly workspaces: Readonly<Record<string, string>>;
}

/**
 * The failing test each node's agent has to make pass. Identical per node ON PURPOSE: the
 * agent is the same scripted coder in all three seats, so any difference between the nodes
 * would come from the GRAPH rather than from the work, which is what this journey measures.
 */
const NODE_TEST = [
  'import { add, multiply } from "./math.mjs";',
  'if (add(2, 3) !== 5) throw new Error("add is wrong");',
  'if (multiply(2, 3) !== 6) throw new Error("multiply is wrong");',
  'console.log("math.mjs passes");',
  "",
].join("\n");

/**
 * A git repository per workspace, so the wrapper's lander can make a REAL commit rather than
 * reporting that there is nothing to land. `git init` is quiet and local; the identity is set
 * here because a host with no global `user.email` fails `git commit` with a message about
 * configuration that reads as a moe-next defect.
 */
function initializeRepository(directory: string): void {
  const run = (...args: readonly string[]): void => {
    execFileSync("git", [...args], { cwd: directory, stdio: "ignore" });
  };
  run("init", "--quiet");
  run("config", "user.email", "multi-node@moe-next.invalid");
  run("config", "user.name", "Multi Node E2E");
  run("add", "--all");
  run("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "seed workspace");
}

/**
 * The scratch: three node specs in ONE specs directory and three git workspaces.
 *
 * A spec-dir brief WINS over the compiled-graph brief on a nodeRef collision
 * (`agent-wrapper-main.ts:139`), so these are what the wrapper hands each agent — which is
 * how each of the three seats gets its own workspace and its own test command.
 */
export function createMultiNodeScratch(): MultiNodeScratch {
  const root = mkdtempSync(join(tmpdir(), "moe-e2e-multi-"));
  const specsDir = join(root, "specs");
  mkdirSync(specsDir);
  const workspaces: Record<string, string> = {};
  for (const criterion of CRITERIA) {
    const workspace = join(root, criterion.nodeKey);
    mkdirSync(workspace);
    writeFileSync(join(workspace, "test.mjs"), NODE_TEST, "utf8");
    initializeRepository(workspace);
    workspaces[criterion.nodeKey] = workspace;
    writeFileSync(join(specsDir, `${criterion.nodeKey}.json`), JSON.stringify({
      instructions: "Create math.mjs exporting add and multiply so test.mjs passes.",
      nodeRef: criterion.nodeKey,
      test: "node test.mjs",
      title: `Implement ${criterion.nodeKey}`,
      workspace: workspace.replaceAll("\\", "/"),
    }), "utf8");
  }
  return {
    // Unused by the multi-node arm (its shim is handed `--pid-dir`), but the J1Scratch shape
    // is what every harness function takes, so it is a real path rather than a lie.
    agentPidFile: join(root, "agent.pid"),
    credential: OPERATOR_CREDENTIAL,
    projectId: PROJECT_ID,
    root,
    specsDir,
    storePath: join(root, "store.sqlite"),
    // The J1 single-node field. The three real ones are `workspaces`; this names the
    // completion node's, so a consumer that reads the singular gets an honest directory.
    workspace: workspaces[OMEGA] as string,
    workspaces: Object.freeze(workspaces),
  };
}

/** The structure the planning seat submits: the PLAN, and nothing about risk. */
export const MULTI_NODE_STRUCTURE = Object.freeze({
  completionNodeKey: OMEGA,
  nodes: Object.freeze([
    Object.freeze({
      criterionIds: Object.freeze(["crit-alpha"]), dependsOn: Object.freeze([]),
      nodeKey: ALPHA, objective: "Implement the alpha math module with its own test.",
    }),
    Object.freeze({
      criterionIds: Object.freeze(["crit-beta"]), dependsOn: Object.freeze([]),
      nodeKey: BETA, objective: "Implement the beta math module with its own test.",
    }),
    Object.freeze({
      // BOTH producers are named EXPLICITLY rather than left to the producer's
      // no-outgoing-edge rule (`compiled-policy-authority-body.ts:151`), so the submitted
      // structure states the build order this journey asserts on instead of inheriting it.
      criterionIds: Object.freeze(["crit-omega"]),
      dependsOn: Object.freeze([ALPHA, BETA]),
      nodeKey: OMEGA, objective: "Integrate alpha and beta behind one math module.",
    }),
  ]),
});

/** The Product Contract revision draft the planning seat proposes from the PRD it can read. */
export function revisionDraft(sourceDigest: string): Record<string, unknown> {
  return {
    authorRef: AGENT_SESSION,
    contractId: CONTRACT_ID,
    criteria: CRITERIA.map((criterion) => ({
      criterionId: criterion.criterionId,
      requirementId: "req-three-nodes",
      statement: criterion.statement,
      supersedesCriterionId: null,
    })),
    lineage: null,
    requirements: [{
      requirementId: "req-three-nodes",
      statement: "Two independent modules and one integrator ship behind one goal.",
      supersedesRequirementId: null,
    }],
    retiredCriterionIds: [],
    retiredRequirementIds: [],
    revisionId: REVISION_ID,
    sourceDocumentDigests: [sourceDigest],
  };
}
