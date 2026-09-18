import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

import { createRepositoryExecutionPort } from "../repository/repository-execution-port.js";
import type { NodeMission } from "./agent-wrapper.js";
import { NODE_TREES_DIRECTORY, ensureNodeTree, nodeTreeName } from "./node-worktrees.js";

/**
 * The node's mission, moved into the node's own working tree (owner decision 2026-09-16). Moe
 * holds a checkout per working tree, so briefing every node into the project's one tree is what
 * made nodes queue behind each other; a node briefed into its own tree holds its own checkout and
 * codes beside its siblings.
 *
 * Everything downstream follows the mission's workspace — the reservation's identity, the
 * baseline, the verifier's test command, the review package's binding and the landing commit — so
 * this is the only place the choice is made.
 *
 * A node that already holds the project's own checkout keeps it until that hold ends. Moving a
 * mission out from under a live hold would leave its work in a tree its verifier and lander no
 * longer look at, so turning this on mid-flight costs a node nothing: it finishes where it
 * started, and takes its own tree the next time it is staffed.
 *
 * A tree that cannot be made leaves the mission exactly as it was, on the project's own
 * workspace: that is the single-tree behaviour that shipped before, and the node still runs. Each
 * reason is said once per node rather than on every pass.
 */
export type ProjectHolder = (projectRoot: string) => string | null;

const inspectHolder: ProjectHolder = (projectRoot) => {
  try {
    const read = createRepositoryExecutionPort().inspect(projectRoot);
    return read.ok ? read.reservation?.nodeRef ?? null : null;
  } catch { return null; }
};

/**
 * The workspace `createNodeTreeMissions` briefs this node into, answered WITHOUT making anything:
 * the checkout it already holds, else its own tree when that tree exists, else the project. The
 * review submission captures its evidence here, so it binds the same tree the verifier tests.
 */
export function nodeWorkspaceOf(projectRoot: string, nodeRef: string, holder: ProjectHolder = inspectHolder): string {
  if (holder(projectRoot) === nodeRef) return projectRoot;
  const name = nodeTreeName(nodeRef);
  if (name === null) return projectRoot;
  try {
    const tree = join(realpathSync.native(resolve(projectRoot)), NODE_TREES_DIRECTORY, name);
    return existsSync(join(tree, ".git")) ? tree : projectRoot;
  } catch { return projectRoot; }
}

export function createNodeTreeMissions(log: (line: string) => void, holder: ProjectHolder = inspectHolder) {
  const reported = new Set<string>();
  const say = (nodeRef: string, line: string): void => {
    if (reported.has(nodeRef)) return;
    reported.add(nodeRef);
    log(line);
  };
  return function withNodeTree(brief: NodeMission | null, nodeRef: string): NodeMission | null {
    if (brief === null) return null;
    if (holder(brief.workspace) === nodeRef) {
      say(nodeRef, `[wrapper] ${nodeRef}: finishing in ${brief.workspace}, the checkout it already holds; it takes its own tree when it is staffed again`);
      return brief;
    }
    const tree = ensureNodeTree({ nodeRef, projectRoot: brief.workspace });
    if (tree === null) {
      say(nodeRef, `[wrapper] ${nodeRef}: no working tree of its own; it shares ${brief.workspace} and waits its turn there`);
      return brief;
    }
    reported.delete(nodeRef);
    return Object.freeze({ ...brief, workspace: tree.path });
  };
}
