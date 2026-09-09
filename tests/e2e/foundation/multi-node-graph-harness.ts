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
import { DEFAULT_MULTI_NODE_IDENTITY } from "./multi-node-identity.js";
import type { MultiNodeIdentity } from "./multi-node-identity.js";

/** Re-exported so a caller composes the journey from ONE module rather than two. */
export { DEFAULT_MULTI_NODE_IDENTITY, multiNodeIdentity } from "./multi-node-identity.js";
export type {
  MultiNodeCriterion, MultiNodeIdentity, MultiNodeIdentityOverrides,
} from "./multi-node-identity.js";

/**
 * THE DEFAULT IDENTITY, UNDER THE NAMES IT HAS ALWAYS HAD. Each of these was a literal here
 * until `multi-node-identity.ts` existed; they are re-stated as bindings so every existing
 * importer keeps its exact import line, and so there is exactly ONE place a value is spelled.
 */
const IDENTITY = DEFAULT_MULTI_NODE_IDENTITY;

/** The three sealed node keys, in the order the graph binds them. */
export const ALPHA = IDENTITY.alpha;
export const BETA = IDENTITY.beta;
export const OMEGA = IDENTITY.omega;
export const MULTI_NODE_KEYS = IDENTITY.nodeKeys;

/** One criterion per node, so the coverage read's denominator is exactly three. */
export const CRITERIA = IDENTITY.criteria;

/** The goal identity. Production mints `goal-${commandId}`, so the two are stated as a pair. */
export const GOAL_CREATE_COMMAND_ID = IDENTITY.goalCreateCommandId;
export const GOAL_ID = IDENTITY.goalId;
export const PROJECT_ID = IDENTITY.projectId;
export const CONTRACT_ID = IDENTITY.contractId;
export const REVISION_ID = IDENTITY.revisionId;

export const PRD_TEXT = [
  "# Three nodes, one goal",
  "",
  "Two independent modules and one that integrates them. The build order is a fact of the",
  "graph, not of the operator's patience: alpha and beta are unrelated, omega needs both.",
  "",
].join("\n");

/** Fixed, not minted: a random credential would be a random source in a scanned module. */
export const OPERATOR_CREDENTIAL = IDENTITY.operatorCredential;
export const AGENT_SESSION = IDENTITY.agentSession;
export const AGENT_SECRET = IDENTITY.agentSecret;
export const HUMAN_SESSION = IDENTITY.humanSession;
export const HUMAN_SECRET = IDENTITY.humanSecret;

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
 *
 * The identity is a TRAILING argument defaulted to today's, so `createMultiNodeScratch()`
 * still writes today's directories under today's project and credential. It is also the
 * carrier that reaches a throwaway daemon: `j1-loop-harness.ts:116-124` maps `projectId` and
 * `credential` off this record into `MOE_PROJECT_ID` and `MOE_DAEMON_CREDENTIAL`.
 */
export function createMultiNodeScratch(
  identity: MultiNodeIdentity = IDENTITY,
): MultiNodeScratch {
  const root = mkdtempSync(join(tmpdir(), "moe-e2e-multi-"));
  const specsDir = join(root, "specs");
  mkdirSync(specsDir);
  const repository = join(root, "workspace"); mkdirSync(repository);
  const workspaces: Record<string, string> = {};
  for (const criterion of identity.criteria) {
    const workspace = join(repository, criterion.nodeKey);
    mkdirSync(workspace);
    writeFileSync(join(workspace, "test.mjs"), NODE_TEST, "utf8");
    workspaces[criterion.nodeKey] = workspace;
  }
  writeFileSync(join(repository, "test.mjs"), [
    'import {existsSync} from "node:fs";',
    `const modules = ${JSON.stringify(identity.nodeKeys)};`,
    'let tested = 0; for (const module of modules) { if (!existsSync(new URL(`./${module}/math.mjs`, import.meta.url))) continue;',
    'await import(`./${module}/test.mjs`); tested++; }',
    'if (tested === 0) throw new Error("no module was implemented");',
  ].join("\n"), "utf8");
  initializeRepository(repository);
  return {
    // Unused by the multi-node arm (its shim is handed `--pid-dir`), but the J1Scratch shape
    // is what every harness function takes, so it is a real path rather than a lie.
    agentPidFile: join(root, "agent.pid"),
    credential: identity.operatorCredential,
    projectId: identity.projectId,
    root,
    specsDir,
    storePath: join(root, "store.sqlite"),
    // The compiled mission workspace is the physical repository shared by every node.
    workspace: repository,
    workspaces: Object.freeze(workspaces),
  };
}

/**
 * The structure the planning seat submits: the PLAN, and nothing about risk.
 *
 * The node objectives are derived from the keys rather than spelled, because an identity with
 * other keys would otherwise submit a plan whose prose names nodes it does not contain.
 */
export function multiNodeStructure(
  identity: MultiNodeIdentity = IDENTITY,
): Record<string, unknown> {
  const criterionFor = (nodeKey: string): readonly string[] => {
    const ids = identity.criteria.filter((criterion) => criterion.nodeKey === nodeKey)
      .map((criterion) => criterion.criterionId);
    // An identity whose criteria do not cover a node key would otherwise submit a node with
    // EMPTY criterionIds, which the daemon answers with an opaque internal error rather than a
    // named refusal. Saying so here costs one line and saves the next caller the bisect.
    if (ids.length === 0) throw new Error(`the identity states no criterion for ${nodeKey}`);
    return Object.freeze(ids);
  };
  const { alpha, beta, omega } = identity;
  return Object.freeze({
    completionNodeKey: omega,
    nodes: Object.freeze([
      Object.freeze({
        criterionIds: criterionFor(alpha), dependsOn: Object.freeze([]),
        nodeKey: alpha, objective: "Implement the alpha math module with its own test.",
      }),
      Object.freeze({
        criterionIds: criterionFor(beta), dependsOn: Object.freeze([]),
        nodeKey: beta, objective: "Implement the beta math module with its own test.",
      }),
      Object.freeze({
        // BOTH producers are named EXPLICITLY rather than left to the producer's
        // no-outgoing-edge rule (`compiled-policy-authority-body.ts:151`), so the submitted
        // structure states the build order this journey asserts on instead of inheriting it.
        criterionIds: criterionFor(omega),
        dependsOn: Object.freeze([alpha, beta]),
        nodeKey: omega, objective: "Integrate alpha and beta behind one math module.",
      }),
    ]),
  });
}

/** The default identity's structure, kept as a const so existing readers see one object. */
export const MULTI_NODE_STRUCTURE = multiNodeStructure();

/** The Product Contract revision draft the planning seat proposes from the PRD it can read. */
export function revisionDraft(
  sourceDigest: string, identity: MultiNodeIdentity = IDENTITY,
): Record<string, unknown> {
  return {
    authorRef: identity.agentSession,
    contractId: identity.contractId,
    criteria: identity.criteria.map((criterion) => ({
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
    revisionId: identity.revisionId,
    sourceDocumentDigests: [sourceDigest],
  };
}
