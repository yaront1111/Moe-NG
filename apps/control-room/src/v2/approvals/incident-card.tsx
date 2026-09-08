import { useState } from "react";
import type { JSX } from "react";

import { ActionButton } from "../components/primitives.js";
import { MIDDOT } from "../glyphs.js";
import type { IncidentFacts } from "./needs-you-incident.js";
import { incidentKeyOf } from "./needs-you-incident.js";

/**
 * THE INCIDENT CARD BODY: what an operator reads when a deployment environment is down, written
 * for someone under time pressure who has about ten seconds before they go looking at logs.
 *
 * THE ERROR LINE IS RENDERED VERBATIM AND IS NEVER TRUNCATED. No slice, no ellipsis, no
 * summary: an ellipsis in the middle of a stack line is the same failure as omitting it, in a
 * nicer font. It wraps instead - `cr2-approve-mono` is the same class the Environments section
 * renders this line under, so the two surfaces cannot drift apart on how it looks. The instant
 * and the refusing authority ride BESIDE it rather than inside it, so nothing is interpolated
 * into the operator's one real clue.
 *
 * THE CONFIRM NAMES THE SHA AND THE ENVIRONMENT, and it names them AT THE CONFIRM - not only on
 * the card behind it. That is the moment the operator commits, and rolling back the wrong
 * environment, or to the wrong commit, during an incident is a second incident. The sha shown is
 * `rollbackTarget.sha`, which the daemon resolved from the RECEIPT it will actually spend, and
 * it is shown IN FULL: a seven-character prefix is a nicety on a deploy card and a hazard here.
 *
 * DISMISS IS NOT RESOLVE. The button says so, and the shape backs it up: dismissing reaches only
 * this queue's own dismissal set, keyed by THIS incident id (`needs-you-incident.ts`). The
 * environment keeps reading DOWN on the Environments section, which renders its own health read
 * and never sees this set, and the daemon opens a NEW incident with a NEW id at the next failure
 * threshold - which this dismissal cannot match and therefore cannot silence.
 */

export interface IncidentCardProps {
  readonly busy: boolean;
  /** True once the rollback the daemon offered has been accepted. */
  readonly done: boolean;
  readonly facts: IncidentFacts;
  readonly onDismiss: (() => void) | undefined;
  /** Spends the daemon's rollback offer; absent means the card renders read-only. */
  readonly onRollback: (() => void) | undefined;
}

const STATE_WORDS: Readonly<Record<IncidentFacts["state"], string>> = Object.freeze({
  DEGRADED: "Degraded", DOWN: "Down", UP: "Up",
});

export function IncidentCard({
  busy, done, facts, onDismiss, onRollback,
}: IncidentCardProps): JSX.Element {
  const [armed, setArmed] = useState(false);
  const key = incidentKeyOf(facts.environment, facts.incidentId);
  const testId = `cr.needsyou.incident.${key}`;
  const rollback = facts.rollback;
  return (
    <div className="cr2-needs-incident" data-state={facts.state} data-testid={testId}>
      <p className="cr2-approve-step-body" data-testid={`${testId}.state`}>
        {`${STATE_WORDS[facts.state]} ${MIDDOT} incident ${String(facts.incidentId)}`
          + ` ${MIDDOT} open since ${facts.openedAt}`}
      </p>
      {facts.lastError === null ? (
        <p className="cr2-needs-note" data-testid={`${testId}.noerror`}>
          The daemon has recorded no error line for this environment yet.
        </p>
      ) : (
        <>
          <p className="cr2-approve-mono" data-testid={`${testId}.error`}>{facts.lastError.line}</p>
          <p className="cr2-needs-note" data-testid={`${testId}.errormeta`}>
            {`${facts.lastError.code} @ ${facts.lastError.layer} ${MIDDOT} ${facts.lastError.at}`}
          </p>
        </>
      )}
      {rollback === null || onRollback === undefined ? null : (
        <div className="cr2-needs-action">
          {armed && !done ? (
            <p className="cr2-approve-mono" data-testid={`${testId}.confirm`}>
              {`Roll back ${facts.environment} to ${rollback.target.sha}`}
            </p>
          ) : null}
          <ActionButton
            ariaLabel={armed
              ? `Confirm the rollback of ${facts.environment} to ${rollback.target.sha}`
              : `Roll back ${facts.environment}`}
            disabled={busy || done}
            onClick={(): void => {
              if (!armed) { setArmed(true); return; }
              setArmed(false);
              onRollback();
            }}
            testId={`${testId}.rollback`}
          >
            {done
              ? "Rolling back"
              : armed
                ? `Confirm: roll back ${facts.environment} to ${rollback.target.sha}`
                : "Roll back"}
          </ActionButton>
          {armed && !done ? (
            <ActionButton
              onClick={(): void => setArmed(false)}
              testId={`${testId}.rollback.cancel`}
              variant="secondary"
            >
              Leave it as it is
            </ActionButton>
          ) : null}
        </div>
      )}
      {onDismiss === undefined ? null : (
        <>
          <ActionButton
            ariaLabel={`Dismiss this card for ${facts.environment}. The environment stays down.`}
            onClick={onDismiss}
            testId={`${testId}.dismiss`}
            variant="secondary"
          >
            Dismiss this card
          </ActionButton>
          <p className="cr2-needs-note" data-testid={`${testId}.dismissnote`}>
            Dismissing does not fix anything: the environment stays down on the Health screen, and
            this card comes back at the next failure threshold.
          </p>
        </>
      )}
    </div>
  );
}
