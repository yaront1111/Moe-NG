import { useEffect, useState } from "react";
import type { JSX } from "react";

import { readDesign } from "../../live/live-design.js";
import type { DesignOutcome } from "../../live/live-design.js";
import { OutcomeNote } from "../components/outcome-note.js";

/**
 * WHICH DESIGN VERSION THIS PLAN WAS COMPILED AGAINST, stated on the plan fold.
 *
 * The human accepts the design IMPLICITLY by approving the plan, so the approval
 * surface has to name the design it was built on or the approval is uninformed. That
 * is why this is a sentence and not a label: the two states a person must be able to
 * tell apart are "there is a design, it is version N" and "there is no design at all",
 * and a blank or a zero collapses them into each other.
 *
 * It reads the SAME `/design/read` the Design card reads, through the SAME exact-key
 * decoder, with the approval's planning run selector. The daemon resolves that run's
 * immutable design selection, while the Design tab can continue to show newer revisions.
 *
 * NO VERSION PICKER. An older revision stays readable by asking the daemon for it
 * (`/design/read` takes a version), which the journey exercises; a picker here would be
 * a second way to name a revision and a second thing to keep in step with the tab.
 */

const ABSENT_CODE = "DESIGN_REVISION_ABSENT";
const ABSENT_LAYER = "LEDGER";

/** The words a person reads when the plan was compiled with no design at all. */
export const NO_DESIGN_WORDS
  = "This plan was compiled with no design. Approving it accepts the plan alone.";

/** The words when the design step ran but was deliberately skipped. */
export function skippedWords(reason: string): string {
  return `The design step was skipped, so this plan was compiled with no design. ${reason}`;
}

/** The words when a design exists: the version is the operator's anchor. */
export function versionWords(version: number): string {
  return `Design version ${String(version)}. Approving this plan accepts that design.`;
}

function isAbsent(outcome: Extract<DesignOutcome, { status: "REFUSED" | "ERROR" }>): boolean {
  return outcome.status === "REFUSED" && outcome.code === ABSENT_CODE && outcome.layer === ABSENT_LAYER;
}

export function DesignVersionNote(
  { outcome }: { readonly outcome: DesignOutcome | null },
): JSX.Element {
  if (outcome === null) {
    return (
      <p className="cr2-slot-kicker" data-testid="cr.approve.design-version">
        Reading which design this plan was compiled against...
      </p>
    );
  }
  if (outcome.status !== "DESIGN") {
    // A refusal that is NOT the absent-design case is a read failure, not a fact about
    // the plan. It carries CODE and LAYER so nobody reads "cannot say" as "no design".
    return isAbsent(outcome)
      ? <p className="cr2-needs-note" data-testid="cr.approve.design-version">{NO_DESIGN_WORDS}</p>
      : (
        <OutcomeNote
          code={outcome.code}
          layer={outcome.layer}
          said="The design version behind this plan could not be read right now."
          testId="cr.approve.design-version"
        />
      );
  }
  const revision = outcome.record.revision;
  return (
    <p className="cr2-needs-note" data-testid="cr.approve.design-version">
      {"skipped" in revision ? skippedWords(revision.reason) : versionWords(outcome.record.version)}
    </p>
  );
}

interface LiveDesignVersionNoteProps {
  readonly goalRef: string;
  readonly planningRunRef: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly read?: ((goalRef: string, planningRunRef: string) => Promise<DesignOutcome>) | undefined;
}

/** Read on mount and on subject change; an old goal cannot publish a late answer. */
export function LiveDesignVersionNote(props: LiveDesignVersionNoteProps): JSX.Element {
  const { goalRef, headers, planningRunRef, read } = props;
  const [answer, setAnswer] = useState<{
    readonly subject: LiveDesignVersionNoteProps; readonly outcome: DesignOutcome;
  } | null>(null);
  useEffect(() => {
    let live = true;
    const publish = (outcome: DesignOutcome): void => {
      if (live) setAnswer({ subject: { goalRef, headers, planningRunRef, read }, outcome });
    };
    void Promise.resolve()
      .then(() => read === undefined ? readDesign(headers, goalRef, undefined, planningRunRef) : read(goalRef, planningRunRef))
      .then(publish, () => publish({
        code: "DESIGN_READ_FAILED", layer: "CONTROL_ROOM_GOALS", status: "ERROR",
      }));
    return (): void => { live = false; };
  }, [goalRef, headers, planningRunRef, read]);
  const current = answer !== null && answer.subject.goalRef === goalRef
    && answer.subject.headers === headers && answer.subject.read === read
    && answer.subject.planningRunRef === planningRunRef;
  return <DesignVersionNote outcome={current ? answer.outcome : null} />;
}
