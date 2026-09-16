import type { NodeMission } from "./agent-wrapper.js";
import { ensureNodeTree } from "./node-worktrees.js";

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
 * A tree that cannot be made leaves the mission exactly as it was, on the project's own
 * workspace: that is the single-tree behaviour that shipped before, and the node still runs. The
 * reason is said once per node rather than on every pass.
 */
export function createNodeTreeMissions(log: (line: string) => void) {
  const reported = new Set<string>();
  return function withNodeTree(brief: NodeMission | null, nodeRef: string): NodeMission | null {
    if (brief === null) return null;
    const tree = ensureNodeTree({ nodeRef, projectRoot: brief.workspace });
    if (tree === null) {
      if (!reported.has(nodeRef)) {
        reported.add(nodeRef);
        log(`[wrapper] ${nodeRef}: no working tree of its own; it shares ${brief.workspace} and waits its turn there`);
      }
      return brief;
    }
    reported.delete(nodeRef);
    return Object.freeze({ ...brief, workspace: tree.path });
  };
}
