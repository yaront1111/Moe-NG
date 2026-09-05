import { useState } from "react";
import type { JSX } from "react";

import { readActivation } from "../../live/live-activation.js";
import type { ActivationReadOutcome } from "../../live/live-activation.js";
import { readHealth, readPolicy } from "../../live/live-ops.js";
import type { HealthOutcome, PolicyOutcome } from "../../live/live-ops.js";
import { readRepositoryRemote } from "../../live/live-repository-remote.js";
import type { RepositoryRemoteOutcome } from "../../live/live-repository-remote.js";
import { readSessions } from "../../live/live-sessions.js";
import type { SessionsOutcome } from "../../live/live-sessions.js";
import { useOpsRead } from "../ops/live-ops.js";
import { ResourcesScreen } from "./resources-screen.js";

/**
 * THE LIVE RESOURCES SCREEN: the five reads the daemon already serves, on the ops
 * poller, folded through the pure screen. This adds NO daemon route and NO second
 * decoder - every reader here is the one the rest of the app already spends.
 *
 * Each read is polled independently, so one refusing leaves the other four rendering.
 */

const POLL_MS = 5_000;
const LAYER = "CONTROL_ROOM_RESOURCES";

const ACTIVATION_FAILURE: ActivationReadOutcome
  = Object.freeze({ code: "ACTIVATION_READ_FAILED", layer: LAYER, status: "ERROR" as const });
const HEALTH_FAILURE: HealthOutcome
  = Object.freeze({ code: "HEALTH_READ_FAILED", layer: LAYER, status: "ERROR" as const });
const POLICY_FAILURE: PolicyOutcome
  = Object.freeze({ code: "POLICY_READ_FAILED", layer: LAYER, status: "ERROR" as const });
const REMOTE_FAILURE: RepositoryRemoteOutcome
  = Object.freeze({ code: "REPOSITORY_REMOTE_READ_FAILED", layer: LAYER, status: "ERROR" as const });
const SESSIONS_FAILURE: SessionsOutcome
  = Object.freeze({ code: "SESSIONS_READ_FAILED", layer: LAYER, status: "ERROR" as const });

export interface LiveResourcesProps {
  readonly headers: Readonly<Record<string, string>>;
  readonly pollMs?: number | undefined;
  /** Injectable for tests; each default spends the attached session's own wire. */
  readonly readActivationOutcome?: (() => Promise<ActivationReadOutcome>) | undefined;
  readonly readHealthOutcome?: (() => Promise<HealthOutcome>) | undefined;
  readonly readPolicyOutcome?: (() => Promise<PolicyOutcome>) | undefined;
  readonly readRemoteOutcome?: (() => Promise<RepositoryRemoteOutcome>) | undefined;
  readonly readSessionsOutcome?: (() => Promise<SessionsOutcome>) | undefined;
}

export function LiveResources({
  headers, pollMs, readActivationOutcome, readHealthOutcome, readPolicyOutcome,
  readRemoteOutcome, readSessionsOutcome,
}: LiveResourcesProps): JSX.Element {
  const every = pollMs ?? POLL_MS;
  const [activationReader] = useState(() => readActivationOutcome
    ?? ((): Promise<ActivationReadOutcome> => readActivation(headers)));
  const [healthReader] = useState(() => readHealthOutcome
    ?? ((): Promise<HealthOutcome> => readHealth(headers)));
  const [policyReader] = useState(() => readPolicyOutcome
    ?? ((): Promise<PolicyOutcome> => readPolicy(headers)));
  const [remoteReader] = useState(() => readRemoteOutcome
    ?? ((): Promise<RepositoryRemoteOutcome> => readRepositoryRemote(headers)));
  const [sessionsReader] = useState(() => readSessionsOutcome
    ?? ((): Promise<SessionsOutcome> => readSessions(headers)));
  const activation = useOpsRead(activationReader, ACTIVATION_FAILURE, every, undefined).outcome;
  const health = useOpsRead(healthReader, HEALTH_FAILURE, every, undefined).outcome;
  const policy = useOpsRead(policyReader, POLICY_FAILURE, every, undefined).outcome;
  const remote = useOpsRead(remoteReader, REMOTE_FAILURE, every, undefined).outcome;
  const sessions = useOpsRead(sessionsReader, SESSIONS_FAILURE, every, undefined).outcome;
  return <ResourcesScreen reads={{ activation, health, policy, remote, sessions }} />;
}
