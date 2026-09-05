import { useMemo } from "react";
import type { JSX } from "react";
import type { LiveSetup } from "../../live/live-config.js";
import { readRepositoryRecovery } from "../../live/live-repository-recovery.js";
import type { RepositoryRecoveryOutcome } from "../../live/live-repository-recovery.js";
import { useEffectRead } from "../components/use-effect-read.js";
import { RepositoryRecoveryCard } from "./repository-recovery-card.js";
import { createRepositoryRecoveryPort } from "./repository-recovery-port.js";
const FAILURE: RepositoryRecoveryOutcome = { status: "ERROR", code: "TRANSPORT_REQUEST_FAILED", layer: "CONTROL_ROOM_RECOVERY" };
export function LiveRepositoryRecovery({ setup }: { readonly setup: LiveSetup }): JSX.Element {
  const reader = useMemo(() => () => readRepositoryRecovery(setup.headers), [setup]);
  const port = useMemo(() => createRepositoryRecoveryPort(setup), [setup]);
  const { outcome, refresh } = useEffectRead(reader, FAILURE);
  return <RepositoryRecoveryCard outcome={outcome} port={port} onRecorded={refresh} />;
}
