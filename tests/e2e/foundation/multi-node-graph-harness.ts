/**
 * One goal, one PRD, three criteria, and three module directories in one repository.
 *
 * THE SHAPE IS LOAD-BEARING. `node-alpha` and `node-beta` are INDEPENDENT of each other and
 * `node-omega` depends on BOTH. Independent nodes are graph-ready together, while repository
 * reservation permits one physical execution per pass. The consumer stays blocked until
 * both producers are accepted.
 *
 * Each module has its own criterion test; the generic suite checks every implemented module.
 * All agents share the repository root and learn their criterion from the compiled mission.
 * Explicit human-approved checks run all three tests against the final integrated commit.
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
    statement: "node-alpha/math.mjs exports add and multiply and its own test passes.",
  }),
  Object.freeze({
    criterionId: "crit-beta", nodeKey: BETA,
    statement: "node-beta/math.mjs exports add and multiply and its own test passes.",
  }),
  Object.freeze({
    criterionId: "crit-omega", nodeKey: OMEGA,
    statement: "node-omega/math.mjs integrates alpha and beta and its own test passes.",
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
  /** Local node key -> its module directory beneath the shared repository root. */
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
 * One git repository, so the wrapper's lander can make a REAL commit rather than
 * reporting that there is nothing to land. `git init` is quiet and local; the identity is set
 * here because a host with no global `user.email` fails `git commit` with a message about
 * configuration that reads as a moe-next defect.
 */
function initializeRepository(directory: string): void {
  const run = (...args: readonly string[]): void => {
    execFileSync("git", [...args], { cwd: directory, stdio: "ignore", windowsHide: true });
  };
  run("init", "--quiet");
  run("config", "user.email", "multi-node@moe-next.invalid");
  run("config", "user.name", "Multi Node E2E");
  run("add", "--all");
  run("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "seed workspace");
}

/**
 * The scratch uses the production compiled mission source with no operator node overrides.
 */
export function createMultiNodeScratch(): MultiNodeScratch {
  const root = mkdtempSync(join(tmpdir(), "moe-e2e-multi-"));
  const specsDir = join(root, "specs");
  mkdirSync(specsDir);
  const repository = join(root, "workspace"); mkdirSync(repository);
  const workspaces: Record<string, string> = {};
  for (const criterion of CRITERIA) {
    const workspace = join(repository, criterion.nodeKey);
    mkdirSync(workspace);
    writeFileSync(join(workspace, "test.mjs"), NODE_TEST, "utf8");
    workspaces[criterion.nodeKey] = workspace;
  }
  writeFileSync(join(repository, "test.mjs"), [
    'import {existsSync} from "node:fs";',
    `const modules = ${JSON.stringify(MULTI_NODE_KEYS)};`,
    'let tested = 0; for (const module of modules) { if (!existsSync(new URL(`./${module}/math.mjs`, import.meta.url))) continue;',
    'await import(`./${module}/test.mjs`); tested++; }',
    'if (tested === 0) throw new Error("no module was implemented");',
  ].join("\n"), "utf8");
  initializeRepository(repository);
  return {
    // Unused by the multi-node arm (its shim is handed `--pid-dir`), but the J1Scratch shape
    // is what every harness function takes, so it is a real path rather than a lie.
    agentPidFile: join(root, "agent.pid"),
    credential: OPERATOR_CREDENTIAL,
    projectId: PROJECT_ID,
    root,
    specsDir,
    storePath: join(root, "store.sqlite"),
    // The compiled mission workspace is the physical repository shared by every node.
    workspace: repository,
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
