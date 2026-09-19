/**
 * THE PUBLISH APPROVAL, TAKEN FROM THE DAEMON'S OWN PREVIEW, never built by hand.
 *
 * `repository.publish` re-measures the candidate and refuses PUBLISH_APPROVAL_STALE @
 * DAEMON_PREREQUISITE unless the submitted approval equals it (publish-services.ts:99-101). The
 * daemon, not the drive, chooses the approval's branch: a drive that builds `branch` from its own
 * checkout reimplements that choice and goes red the day it changes (task-04160615 publishes to
 * `moe/release/<goalId>` when the remote's default is unknown or is the workspace branch). So the
 * drives ask exactly as the control-room Publish card does (`readPublicationCandidate`,
 * apps/control-room/src/live/live-publication-candidate.ts): POST /repository/remote/read
 * `{ goalId, remoteUrl }`, and hand the answer to the command untouched. The preview and the
 * command compute the target by one rule, which is why every drive is green both before and after
 * that change.
 *
 * Any other answer THROWS with the daemon's own body, so a refusal reaches the log by its code.
 * There is no fallback to a hand-built approval: that is the defect this module removes. Call it
 * AFTER the landing; before it the daemon answers PUBLISH_CANDIDATE_UNREADABLE or the goal is
 * unbound, and says so.
 */
import type { PublicationApproval }
  from "../../../apps/daemon/src/repository/publication-approval-contracts.js";
import type { DaemonLane } from "./daemon-ports.js";
import { lanePost } from "./lane-preview.js";

export async function readPublicationApproval(
  lane: DaemonLane, goalId: string, remoteUrl: string,
): Promise<PublicationApproval> {
  const { body, status } = await lanePost(lane, "/repository/remote/read", { goalId, remoteUrl });
  const approval = body["approval"];
  if (status !== 200 || body["outcome"] !== "PUBLICATION_CANDIDATE" || body["goalId"] !== goalId
    || typeof approval !== "object" || approval === null) {
    throw new Error(`PUBLICATION PREVIEW for ${goalId} at ${remoteUrl}: HTTP ${String(status)} ${JSON.stringify(body)}`);
  }
  return approval as PublicationApproval;
}
