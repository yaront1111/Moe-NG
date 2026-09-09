import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";

import { CONTROL_ROOM_TRANSPORT_LAYER } from "@moe/control-room-client";

import type { SurfaceFrame } from "../../live/live-board-feed.js";
import type { LiveSetup } from "../../live/live-config.js";
import { readRelease } from "../../live/live-release.js";
import type { ReleaseEvidenceView, ReleaseOutcome } from "../../live/live-release.js";
import { OutcomeNote } from "../components/outcome-note.js";
import { useEffectRead } from "../components/use-effect-read.js";
import { GoalRelease, releaseOffer } from "./goal-release.js";
import { createReleasePort } from "./release-port.js";

/**
 * THE RELEASE CARD ATTACHED TO THE DAEMON: one read, one port, and the card decides whether
 * there is anything to show. The card renders NOTHING with no offer and no receipt, so this
 * wrapper does not gate on the offer alone -- a released goal keeps its PR link after the
 * daemon has stopped offering the decision.
 *
 * The refusal note IS gated on the offer, because a goal nobody can release should not be
 * carrying an error about a read it never needed.
 *
 * A CLIENT-SIDE TIMEOUT IS NOT EVIDENCE THE COMMAND DID NOT HAPPEN. `release.decide` runs
 * `publishOnce`, then `gh pr create`, then a `gh pr view` re-read, and against a real remote
 * that outlasts both 15s bounds the browser holds -- the command transport's and each read's.
 * Measured: the daemon opened a real pull request while the session that ordered it sat on
 * "The release evidence could not be read right now.", a failure reported about a command that
 * was succeeding. So a read that fails while a decide is OUTSTANDING is treated as PENDING:
 * the card holds its last good evidence and lets the existing 5s poll deliver the receipt.
 * That is not a claim the command worked -- an undelivered round trip means UNKNOWN, which is
 * what `client-transport.ts` says `delivered` has always separated. A DELIVERED refusal is
 * untouched and still renders its own code at its own layer.
 */

const FAILURE: ReleaseOutcome = {
  status: "ERROR", code: "TRANSPORT_REQUEST_FAILED", layer: "CONTROL_ROOM_RELEASE_READ",
};

export function LiveGoalRelease({ setup, goalId, frame }: {
  readonly frame: SurfaceFrame | null;
  readonly goalId: string;
  readonly setup: LiveSetup;
}): JSX.Element | null {
  const reader = useMemo(() => () => readRelease(setup.headers, goalId), [setup, goalId]);
  const { outcome, refresh } = useEffectRead(reader, FAILURE);
  /**
   * `waiting` is true from the moment a decide is sent until the daemon has said SOMETHING
   * about it. CLEARED BY, and only by: a DELIVERED answer of any kind (refusal included -- the
   * daemon spoke, so the fate is known); a submit that threw; the next read that succeeds; and
   * unmount, where the state dies with the component and `live` stops a late settle from
   * writing to a card that is gone. `held` is the last evidence a read actually returned, so
   * the operator keeps reading real numbers instead of an empty card during that window.
   */
  const [waiting, setWaiting] = useState(false);
  const [held, setHeld] = useState<ReleaseEvidenceView | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return (): void => { live.current = false; };
  }, []);
  useEffect(() => {
    if (outcome === null || outcome.status === "ERROR" || outcome.status === "REFUSED") return;
    setWaiting(false);
    setHeld(outcome.status === "PRESENT" ? outcome.evidence : null);
  }, [outcome]);
  const port = useMemo(() => {
    const wire = createReleasePort(setup);
    return {
      submit: async (...args: Parameters<typeof wire.submit>) => {
        if (live.current) setWaiting(true);
        try {
          const result = await wire.submit(...args);
          // `delivered: false` is the ONE answer that leaves the command's fate unknown, and
          // `spendOffer` reports exactly that case -- and no other -- at the transport's layer.
          if (live.current && (result.ok || result.layer !== CONTROL_ROOM_TRANSPORT_LAYER)) {
            setWaiting(false);
          }
          refresh();
          return result;
        } catch (error) {
          if (live.current) setWaiting(false);
          refresh();
          throw error;
        }
      },
    };
  }, [setup, refresh]);
  const offered = releaseOffer(frame, goalId) !== null;
  if (outcome === null) return null;
  if (outcome.status === "ERROR" || outcome.status === "REFUSED") {
    // PENDING, NOT FAILED. `held` is non-null in every reachable case: a decide can only be
    // confirmed once the card has a measured sha, which only a successful read supplies.
    return waiting
      ? <GoalRelease evidence={held} frame={frame} goalId={goalId} port={port} />
      : offered
        ? <OutcomeNote code={outcome.code} layer={outcome.layer}
          said="The release evidence could not be read right now." testId="cr.release.read-refusal" />
        : null;
  }
  const evidence = outcome.status === "PRESENT" ? outcome.evidence : null;
  return <GoalRelease evidence={evidence} frame={frame} goalId={goalId} port={port} />;
}
