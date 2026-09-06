import { useMemo } from "react";
import type { JSX } from "react";

import type { SurfaceFrame } from "../../live/live-board-feed.js";
import type { LiveSetup } from "../../live/live-config.js";
import { readRelease } from "../../live/live-release.js";
import type { ReleaseOutcome } from "../../live/live-release.js";
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
  const port = useMemo(() => {
    const wire = createReleasePort(setup);
    return {
      submit: async (...args: Parameters<typeof wire.submit>) => {
        const result = await wire.submit(...args);
        refresh();
        return result;
      },
    };
  }, [setup, refresh]);
  const offered = releaseOffer(frame, goalId) !== null;
  if (outcome === null) return null;
  if (outcome.status === "ERROR" || outcome.status === "REFUSED") {
    return offered
      ? <OutcomeNote code={outcome.code} layer={outcome.layer}
        said="The release evidence could not be read right now." testId="cr.release.read-refusal" />
      : null;
  }
  const evidence = outcome.status === "PRESENT" ? outcome.evidence : null;
  return <GoalRelease evidence={evidence} frame={frame} goalId={goalId} port={port} />;
}
