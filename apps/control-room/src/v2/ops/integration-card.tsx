import type { JSX } from "react";
import "../styles/cordum-repository-effects.css";
import type { IntegrationBranchView, RepositoryIntegrationOutcome } from "../../live/live-integration.js";
import { OutcomeNote } from "../components/outcome-note.js";

/**
 * THE INTEGRATION CARD (owner decision 2026-09-16). Nodes code in their own working trees, so
 * their work reaches this project's branch only through a merge. This says which branches merged,
 * which one conflicts and over what, and which are still waiting — read from what the daemon
 * recorded, never from a guess about Git.
 *
 * It offers no button: a clean merge is taken by the daemon as soon as the work is accepted, a
 * conflict is a person's answer in the tree, and pushing stays on the goal's Publish card, which
 * is the one place that binds a remote.
 */
const short = (sha: string): string => sha.slice(0, 10);

function words(branch: IntegrationBranchView): string {
  if (branch.state === "MERGED") {
    return `${branch.branch} ${short(branch.sha)} merged into this project's branch as ${short(branch.mergeSha ?? "")}`;
  }
  if (branch.state === "CONFLICTED") {
    return `${branch.branch} ${short(branch.sha)} conflicts with this project's branch and waits for you`;
  }
  return `${branch.branch} ${short(branch.sha)} is waiting to merge`;
}

export function IntegrationCard({ outcome }: { readonly outcome: RepositoryIntegrationOutcome | null }): JSX.Element {
  return <section className="cr2-ops-card" data-testid="cr.health.integration">
    <h3 className="cr2-approve-heading">Integration</h3>
    <p className="cr2-needs-note">
      Each node works in its own tree and commits to its own branch. A branch merges into this
      project&apos;s branch once its work is accepted; a conflict is left whole for you. Pushing is on
      the goal&apos;s Publish card.
    </p>
    {outcome === null ? <p>Reading node branches…</p> : outcome.status !== "INTEGRATION"
      ? <OutcomeNote code={outcome.code} layer={outcome.layer} said="Node branches could not be read."
        testId="cr.health.integration.read-refusal" />
      : outcome.view.branches.length === 0 ? <p>No node has landed work on a branch of its own.</p>
        : <>{outcome.view.branches.map((branch) => <div key={branch.nodeRef} data-testid={`cr.health.integration.${branch.nodeRef}`}>
          <p className="cr2-needs-detail">{branch.nodeRef}</p>
          <p className="cr2-needs-note">{words(branch)}</p>
          {branch.state === "CONFLICTED" && branch.conflictPaths.length > 0
            && <p className="cr2-approve-mono">{branch.conflictPaths.join(", ")}</p>}
        </div>)}</>}
  </section>;
}
