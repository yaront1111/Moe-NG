import { useMemo } from "react";
import type { JSX } from "react";
import type { LiveSetup } from "../../live/live-config.js";
import type { CriterionEvidenceOutcome } from "../../live/live-criterion-evidence-contracts.js";
import { readCriterionEvidence } from "../../live/live-criterion-evidence.js";
import { useEffectRead } from "../components/use-effect-read.js";
import { CriterionEvidenceCard } from "./criterion-evidence-card.js";
import { createCriterionEvidencePort } from "./criterion-evidence-port.js";
const FAILURE: CriterionEvidenceOutcome = { status: "ERROR", code: "TRANSPORT_REQUEST_FAILED", layer: "CONTROL_ROOM_CRITERIA" };
export function LiveCriterionEvidence({ setup, goalRef }: { readonly setup: LiveSetup; readonly goalRef: string }): JSX.Element {
  const reader = useMemo(() => () => readCriterionEvidence(setup.headers, goalRef), [setup, goalRef]);
  const port = useMemo(() => createCriterionEvidencePort(setup), [setup]);
  const { outcome, refresh } = useEffectRead(reader, FAILURE);
  return <CriterionEvidenceCard outcome={outcome} port={port} onRecorded={refresh} />;
}
