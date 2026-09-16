import { useMemo } from "react";
import type { JSX } from "react";
import type { LiveSetup } from "../../live/live-config.js";
import { readRepositoryIntegration } from "../../live/live-integration.js";
import type { RepositoryIntegrationOutcome } from "../../live/live-integration.js";
import { useEffectRead } from "../components/use-effect-read.js";
import { IntegrationCard } from "./integration-card.js";

const FAILURE: RepositoryIntegrationOutcome = { status: "ERROR", code: "TRANSPORT_REQUEST_FAILED", layer: "CONTROL_ROOM_INTEGRATION" };

export function LiveIntegration({ setup }: { readonly setup: LiveSetup }): JSX.Element {
  const reader = useMemo(() => () => readRepositoryIntegration(setup.headers), [setup]);
  const { outcome } = useEffectRead(reader, FAILURE);
  return <IntegrationCard outcome={outcome} />;
}
