import { useMemo } from "react";
import type { JSX } from "react";
import type { LiveSetup } from "../../live/live-config.js";
import type { SurfaceFrame } from "../../live/live-board-feed.js";
import { readDeployments } from "../../live/live-deployments.js";
import type { DeploymentsOutcome } from "../../live/live-deployments.js";
import { OutcomeNote } from "../components/outcome-note.js";
import { useEffectRead } from "../components/use-effect-read.js";
import { createDeployPort } from "./deploy-port.js";
import { deployOffer, GoalDeployments } from "./goal-deployments.js";

const FAILURE: DeploymentsOutcome = { status: "ERROR", code: "TRANSPORT_REQUEST_FAILED", layer: "CONTROL_ROOM_DEPLOY" };
export function LiveGoalDeployments({ setup, goalRef, frame }: {
  readonly setup: LiveSetup; readonly goalRef: string; readonly frame: SurfaceFrame | null;
}): JSX.Element | null {
  const reader = useMemo(() => () => readDeployments(setup.headers, goalRef), [setup, goalRef]);
  const { outcome, refresh } = useEffectRead(reader, FAILURE);
  const port = useMemo(() => {
    const wire = createDeployPort(setup);
    return { submit: async (...args: Parameters<typeof wire.submit>) => {
      const result = await wire.submit(...args); refresh(); return result;
    } };
  }, [setup, refresh]);
  if (deployOffer(frame, goalRef) === null) return null;
  if (outcome === null) return <p className="cr2-needs-note">Reading deployment targets and receipts...</p>;
  if (outcome.status !== "DEPLOYMENTS") return <OutcomeNote code={outcome.code} layer={outcome.layer}
    said="Deployment targets and receipts could not be read right now." testId="cr.deploy.read-refusal" />;
  return <GoalDeployments key={`${goalRef}:${outcome.sha ?? ""}`} frame={frame} goalId={goalRef} environments={outcome.environments}
    port={port} releaseDecision={outcome.releaseDecision} sha={outcome.sha} />;
}
