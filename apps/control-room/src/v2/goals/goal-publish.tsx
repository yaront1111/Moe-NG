import { useState } from "react";
import type { JSX } from "react";

import type { SurfaceFrame } from "../../live/live-board-feed.js";
import type { RepositoryRemoteOutcome } from "../../live/live-repository-remote.js";
import type { RunGoalPublishView, RunGoalView } from "../../live/live-runs.js";
import { OutcomeNote } from "../components/outcome-note.js";
import { ActionButton } from "../components/primitives.js";
import { MIDDOT } from "../glyphs.js";
import { writeFailedSaid } from "../outcome-words.js";
import type { OfferOutcome } from "../approvals/offer-wire.js";
import type { PublishPort } from "./publish-port.js";
import type { PublicationApproval } from "../../live/live-publication-candidate.js";

/**
 * THE PUBLISH CARD on an opened goal: ONE control. The remote belongs to the PROJECT, not to
 * this goal and not to this browser -- the daemon binds it on the first publish and states it
 * back on /repository/remote/read. So once it is bound the card shows "Publish to <remote>"
 * with the commits it will push and nothing to type; a Change link reveals the field again,
 * and the next publish rebinds. Nothing is remembered in this browser: a url kept here would go
 * stale, shadow the bound remote, and push to a repository this project never named.
 *
 * With nothing landed the daemon withholds the offer and this card renders NOTHING at all,
 * rather than inviting a decision there is no work for.
 */

export interface GoalPublishProps {
  readonly frame: SurfaceFrame | null;
  readonly goal: RunGoalView | null;
  readonly goalId: string;
  readonly port: PublishPort | null;
  /** The project's bound remote as the daemon stated it; null while the read has not answered. */
  readonly remote: RepositoryRemoteOutcome | null;
}

/** The daemon's repository.publish offer for this goal, from the surface it stated. */
export function publishOffer(frame: SurfaceFrame | null, goalId: string): Record<string, unknown> | null {
  if (frame === null || frame.outcome !== "SURFACE") return null;
  const offer = frame.offers.find((row) =>
    row["commandKind"] === "repository.publish" && row["targetAggregateId"] === `publish:${goalId}`);
  return offer ?? null;
}

/** The url the project is bound to, or null for unbound, unread, refused and unreadable alike. */
export function boundRemoteUrl(remote: RepositoryRemoteOutcome | null): string | null {
  return remote !== null && remote.status === "REMOTE" ? remote.remoteUrl : null;
}

/** What the runs read says about the latest publish, in a person's words. */
export function publishLine(publish: RunGoalPublishView | null): string {
  if (publish === null) return "Not published yet. Landed commits stay in the workspace's repository until you publish.";
  if (publish.outcome === "PENDING") return `Publishing to ${publish.remoteUrl} ${MIDDOT} waiting for the wrapper to push`;
  if (publish.outcome === "UNKNOWN") return `Publication outcome unknown ${MIDDOT} Repository remains held while the daemon checks the approved remote branch.`;
  if (publish.outcome === "PUSHED") {
    return `Pushed ${(publish.sha ?? "").slice(0, 10)} on ${publish.branch ?? "?"} to ${publish.remoteUrl}`;
  }
  return `Publish refused ${MIDDOT} ${publish.code ?? "REFUSED"} ${MIDDOT} decide again to retry`;
}

interface LandedCommit { readonly nodeKey: string; readonly sha: string }

/** The commits this publish would push, as the runs read landed them. */
export function landedCommits(goal: RunGoalView | null): readonly LandedCommit[] {
  if (goal === null) return [];
  return goal.nodes.flatMap((node) => node.landing?.outcome === "COMMITTED"
    ? [{ nodeKey: node.nodeKey, sha: node.landing.sha ?? "" }] : []);
}

function landedWords(commits: readonly LandedCommit[]): string {
  if (commits.length === 0) return "No node of this goal is landed as a commit yet.";
  const count = String(commits.length);
  return `${count} node${commits.length === 1 ? "" : "s"} landed as local commits on the workspace branch.`;
}

export function GoalPublish({ frame, goal, goalId, port, remote }: GoalPublishProps): JSX.Element | null {
  const [typed, setTyped] = useState("");
  const [changing, setChanging] = useState(false);
  const [armed, setArmed] = useState<PublicationApproval | null>(null);
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<OfferOutcome | null>(null);
  const offer = publishOffer(frame, goalId);
  const publish = goal?.publish ?? null;
  const commits = landedCommits(goal);
  const bound = boundRemoteUrl(remote);
  // Nothing landed means no offer and no receipt: the card is not a thing on this screen at all.
  if (offer === null && publish === null) return null;
  // ALSO binding while something has been typed. The bound remote arrives from a POLL, so it can
  // land mid-keystroke; without this, the field an operator was typing into would vanish under
  // them and their url would be silently dropped in favour of the remote they were replacing.
  const binding = bound === null || changing || typed.trim() !== "";
  const canPublish = offer !== null && port !== null && !busy && publish?.outcome !== "UNKNOWN" && (!binding || typed.trim() !== "");
  const decide = (): void => {
    if (offer === null || port === null || armed === null) return;
    setBusy(true);
    setArmed(null);
    void port.submit(offer, goalId, binding ? typed.trim() : null, armed).then((outcome) => {
      setAnswer(outcome);
      setBusy(false);
      if (outcome.ok) { setChanging(false); setTyped(""); }
    }, () => {
      setAnswer({ code: "PUBLISH_DISPATCH_FAILED", layer: "CONTROL_ROOM_PUBLISH", ok: false });
      setBusy(false);
    });
  };
  const prepare = (): void => {
    if (port === null) return;
    setBusy(true); setAnswer(null);
    void port.prepare(goalId, binding ? typed.trim() : null).then((result) => {
      if (result.ok) setArmed(result.approval); else setAnswer(result);
      setBusy(false);
    }, () => { setAnswer({ ok: false, code: "PUBLISH_CANDIDATE_UNREADABLE", layer: "CONTROL_ROOM_PUBLISH" }); setBusy(false); });
  };
  return (
    <section className="cr2-ops-panel" data-testid="cr.publish.root">
      <h3 className="cr2-approve-heading">{`PUBLISH ${MIDDOT} YOUR DECISION`}</h3>
      <p className="cr2-needs-detail" data-testid="cr.publish.landed">{landedWords(commits)}</p>
      {commits.length === 0 ? null : (
        <ul className="cr2-approve-obligations" data-testid="cr.publish.commits">
          {commits.map((commit) => (
            <li className="cr2-coverage-section" key={commit.nodeKey}>
              <span className="cr2-approve-step-body">{commit.nodeKey}</span>
              <span className="cr2-approve-mono">{commit.sha.slice(0, 10)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="cr2-needs-detail" data-testid="cr.publish.state">{publishLine(publish)}</p>
      {publish?.url === null || publish === null ? null : (
        <a className="cr2-link" data-testid="cr.publish.link" href={publish.url} rel="noreferrer" target="_blank">{publish.url}</a>
      )}
      {offer === null ? null : (
        <div className="cr2-needs-action">
          {bound === null ? null : (
            <p className="cr2-slot-kicker" data-testid="cr.publish.bound">
              {`This project publishes to ${bound}`}
              <button className="cr2-link" data-testid="cr.publish.change" disabled={busy} onClick={(): void => { setChanging(!changing); setArmed(null); }} type="button">
                {changing ? "Keep this remote" : "Change"}
              </button>
            </p>
          )}
          {!binding ? null : (
            <>
              <label className="cr2-field-label" htmlFor={`cr-publish-remote-${goalId}`}>Git remote (URL)</label>
              <input
                className="cr2-input"
                data-testid="cr.publish.remote"
                disabled={busy}
                id={`cr-publish-remote-${goalId}`}
                onChange={(event): void => { setTyped(event.target.value); setArmed(null); }}
                placeholder="https://github.com/you/your-repo.git"
                value={typed}
              />
            </>
          )}
          {armed === null ? null : <p className="cr2-approve-mono" data-testid="cr.publish.candidate">
            {`Commit ${armed.sha} on branch ${armed.branch} to ${armed.remoteUrl}`}
          </p>}
          <ActionButton
            ariaLabel="Publish the landed commits to the remote"
            disabled={!canPublish}
            onClick={(): void => { if (armed === null) { prepare(); return; } decide(); }}
            testId="cr.publish.button"
          >
            {busy ? "Recording your decision..."
              : armed ? `Confirm: push to ${armed.remoteUrl}`
                : binding ? "Bind this remote and publish" : `Publish to ${bound ?? ""}`}
          </ActionButton>
          {armed && !busy ? (
            <ActionButton onClick={(): void => setArmed(null)} testId="cr.publish.cancel" variant="secondary">Keep it local</ActionButton>
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
