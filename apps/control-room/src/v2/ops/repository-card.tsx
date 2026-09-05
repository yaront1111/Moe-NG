import { useState } from "react";
import type { JSX } from "react";

import type { RepositoryRemoteOutcome } from "../../live/live-repository-remote.js";
import { OutcomeNote } from "../components/outcome-note.js";
import { ActionButton } from "../components/primitives.js";
import { MIDDOT } from "../glyphs.js";
import { readFailedSaid } from "../outcome-words.js";

/**
 * THE REPOSITORY CARD on Health: the one git remote this PROJECT publishes to, who bound it and
 * when. It states the daemon's `/repository/remote/read` answer and nothing else -- unbound is a
 * sentence, not an error, and a refusal keeps the daemon's own code and layer.
 *
 * Change here does not rebind. The binding is an effect of `repository.publish`, so the only
 * honest thing this screen can do is say where the rebind happens; a button that pretended to
 * change the remote from Health would be a control with no command behind it.
 */

const UNBOUND_WORDS = "No remote bound - bind it from the Publish card on any goal.";
const CHANGE_WORDS = "The remote is bound by publishing, so it is changed from the Publish card on any goal "
  + "with landed work: press Change there, type the new remote, and the next publish rebinds the project to it.";

function Fact({ label, testId, value }: {
  readonly label: string; readonly testId: string; readonly value: string;
}): JSX.Element {
  return (
    <div className="cr2-ops-fact">
      <dt className="cr2-ops-fact-label">{label}</dt>
      <dd className="cr2-ops-fact-value" data-testid={testId}>{value}</dd>
    </div>
  );
}

export function RepositoryCard({ outcome }: { readonly outcome: RepositoryRemoteOutcome | null }): JSX.Element {
  const [showing, setShowing] = useState(false);
  if (outcome === null) {
    return (
      <section className="cr2-ops-card" data-testid="cr.health.repository">
        <p className="cr2-slot-kicker" data-testid="cr.health.repository.loading">Reading the repository...</p>
      </section>
    );
  }
  if (outcome.status !== "REMOTE") {
    return (
      <section className="cr2-ops-card" data-testid="cr.health.repository">
        <OutcomeNote
          code={outcome.code}
          layer={outcome.layer}
          said={readFailedSaid("repository")}
          testId="cr.health.repository.refusal"
        />
      </section>
    );
  }
  const bound = outcome.remoteUrl;
  return (
    <section className="cr2-ops-card" data-testid="cr.health.repository">
      <p className="cr2-slot-kicker">{`REPOSITORY ${MIDDOT} WHERE THIS PROJECT PUBLISHES`}</p>
      <p className="cr2-approve-mono" data-testid="cr.health.repository.remote">{bound ?? UNBOUND_WORDS}</p>
      {bound === null ? null : (
        <dl className="cr2-ops-facts" data-testid="cr.health.repository.facts">
          <Fact label="Bound at" testId="cr.health.repository.boundat" value={outcome.boundAt ?? "unknown"} />
          <Fact label="Bound by" testId="cr.health.repository.boundby" value={outcome.boundBy ?? "unknown"} />
        </dl>
      )}
      <ActionButton
        ariaLabel="How to change the remote this project publishes to"
        onClick={(): void => setShowing(!showing)}
        testId="cr.health.repository.change"
        variant="secondary"
      >
        {showing ? "Hide" : "Change"}
      </ActionButton>
      {showing ? (
        <p className="cr2-needs-detail" data-testid="cr.health.repository.changehow">{CHANGE_WORDS}</p>
      ) : null}
    </section>
  );
}
