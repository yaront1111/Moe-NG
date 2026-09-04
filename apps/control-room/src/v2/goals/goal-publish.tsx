import { useState } from "react";
import type { JSX } from "react";

import type { SurfaceFrame } from "../../live/live-board-feed.js";
import type { RunGoalPublishView, RunGoalView } from "../../live/live-runs.js";
import { OutcomeNote } from "../components/outcome-note.js";
import { ActionButton } from "../components/primitives.js";
import { MIDDOT } from "../glyphs.js";
import { writeFailedSaid } from "../outcome-words.js";
import type { OfferOutcome } from "../approvals/offer-wire.js";
import type { PublishPort } from "./publish-port.js";

/**
 * THE PUBLISH CARD on an opened goal: what is landed locally, where it was last pushed, and
 * the one decision a human takes here — name a remote and publish. The daemon's offer decides
 * whether the button exists; the runs read decides what the card says happened; the port
 * spends the offer verbatim. The remote the human typed last is kept in this browser only.
 */

const REMOTE_STORAGE_KEY = "moe.publish.remoteUrl";

export interface GoalPublishProps {
  readonly frame: SurfaceFrame | null;
  readonly goal: RunGoalView | null;
  readonly goalId: string;
  readonly port: PublishPort | null;
}

function rememberedRemote(): string {
  try {
    return globalThis.localStorage?.getItem(REMOTE_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function remember(remoteUrl: string): void {
  try {
    globalThis.localStorage?.setItem(REMOTE_STORAGE_KEY, remoteUrl);
  } catch {
    // A browser that refuses storage still publishes; it just does not remember.
  }
}

/** The daemon's repository.publish offer for this goal, from the surface it stated. */
export function publishOffer(frame: SurfaceFrame | null, goalId: string): Record<string, unknown> | null {
  if (frame === null || frame.outcome !== "SURFACE") return null;
  const offer = frame.offers.find((row) =>
    row["commandKind"] === "repository.publish" && row["targetAggregateId"] === `publish:${goalId}`);
  return offer ?? null;
}

/** What the runs read says about the latest publish, in a person's words. */
export function publishLine(publish: RunGoalPublishView | null): string {
  if (publish === null) return "Not published yet. Landed commits stay in the workspace's repository until you publish.";
  if (publish.outcome === "PENDING") return `Publishing to ${publish.remoteUrl} ${MIDDOT} waiting for the wrapper to push`;
  if (publish.outcome === "PUSHED") {
    return `Pushed ${(publish.sha ?? "").slice(0, 10)} on ${publish.branch ?? "?"} to ${publish.remoteUrl}`;
  }
  return `Publish refused ${MIDDOT} ${publish.code ?? "REFUSED"} ${MIDDOT} decide again to retry`;
}

function landedCount(goal: RunGoalView | null): number {
  return goal === null ? 0 : goal.nodes.filter((node) => node.landing?.outcome === "COMMITTED").length;
}

export function GoalPublish({ frame, goal, goalId, port }: GoalPublishProps): JSX.Element {
  const [remoteUrl, setRemoteUrl] = useState(rememberedRemote);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<OfferOutcome | null>(null);
  const offer = publishOffer(frame, goalId);
  const publish = goal?.publish ?? null;
  const landed = landedCount(goal);
  const canPublish = offer !== null && port !== null && remoteUrl.trim() !== "" && !busy;
  const decide = (): void => {
    if (offer === null || port === null) return;
    setBusy(true);
    setArmed(false);
    void port.submit(offer, goalId, remoteUrl.trim()).then((outcome) => {
      setAnswer(outcome);
      setBusy(false);
      if (outcome.ok) remember(remoteUrl.trim());
    }, () => {
      setAnswer({ code: "PUBLISH_DISPATCH_FAILED", layer: "CONTROL_ROOM_PUBLISH", ok: false });
      setBusy(false);
    });
  };
  return (
    <section className="cr2-ops-panel" data-testid="cr.publish.root">
      <h3 className="cr2-approve-heading">{`PUBLISH ${MIDDOT} YOUR DECISION`}</h3>
      <p className="cr2-needs-detail" data-testid="cr.publish.landed">
        {landed === 0
          ? "No node of this goal is landed as a commit yet."
          : `${String(landed)} node${landed === 1 ? "" : "s"} landed as local commits on the workspace's branch.`}
      </p>
      <p className="cr2-needs-detail" data-testid="cr.publish.state">{publishLine(publish)}</p>
      {publish?.url === null || publish === null ? null : (
        <a className="cr2-link" data-testid="cr.publish.link" href={publish.url} rel="noreferrer" target="_blank">{publish.url}</a>
      )}
      {offer === null ? (
        <p className="cr2-slot-kicker" data-testid="cr.publish.unoffered">The daemon is not offering to publish this goal yet.</p>
      ) : (
        <div className="cr2-needs-action">
          <label className="cr2-field-label" htmlFor={`cr-publish-remote-${goalId}`}>Git remote (URL)</label>
          <input
            className="cr2-input"
            data-testid="cr.publish.remote"
            id={`cr-publish-remote-${goalId}`}
            onChange={(event): void => { setRemoteUrl(event.target.value); setArmed(false); }}
            placeholder="https://github.com/you/your-repo.git"
            value={remoteUrl}
          />
          <ActionButton
            ariaLabel="Publish the landed commits to the remote"
            disabled={!canPublish}
            onClick={(): void => { if (!armed) { setArmed(true); return; } decide(); }}
            testId="cr.publish.button"
          >
            {busy ? "Recording your decision..." : armed ? "Confirm: push to this remote" : "Publish to git"}
          </ActionButton>
          {armed && !busy ? (
            <ActionButton onClick={(): void => setArmed(false)} testId="cr.publish.cancel" variant="secondary">Keep it local</ActionButton>
          ) : null}
        </div>
      )}
      {answer === null ? null : answer.ok ? (
        <p aria-live="polite" className="cr2-needs-note" data-testid="cr.publish.answer" role="status">
          Recorded. The wrapper pushes on its next pass; this card says when it did.
        </p>
      ) : (
        <OutcomeNote
          code={answer.code}
          layer={answer.layer}
          said={writeFailedSaid()}
          testId="cr.publish.answer"
        />
      )}
    </section>
  );
}
