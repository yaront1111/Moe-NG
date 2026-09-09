import { admitEnvironmentName } from "../deployment/deploy-receipt-contracts.js";

/** Probe observations, not a stored health verdict. No URL, body or exception is persisted. */
export const HEALTH_PROBE_VERSION = "moe-health-probe/1" as const;
export const HEALTH_PROBE_RING_LIMIT = 1440;
export const HEALTH_FAILURE_THRESHOLD = 3;
export const PROBE_URL_MISSING = "PROBE_URL_MISSING" as const;
export const HEALTH_PROBE_JOB_ID = "monitoring/health-probes" as const;
/**
 * The schedule id of an environment that carries its OWN probe interval, derived from the sweep
 * job's id so a rename of one can never leave the other behind. Safe under the scheduler's
 * `validId` (`/^[\w./:-]{1,200}$/`) without touching that guard: the prefix is 25 characters and
 * `admitEnvironmentName` caps an environment at 63, so the composed id cannot exceed 88.
 */
export const healthProbeJobId = (environment: string): string => `${HEALTH_PROBE_JOB_ID}/${environment}`;
/** The inverse, so an id restored from the durable log resolves back to the environment it probes.
 * Re-admits the suffix rather than trusting it: a persisted id is input like any other. */
export function healthProbeJobEnvironment(id: string): string | null {
  const prefix = `${HEALTH_PROBE_JOB_ID}/`;
  return id.startsWith(prefix) ? admitEnvironmentName(id.slice(prefix.length)) : null;
}
/** The ring's sidecar file, appended to the event store's own database path. Shared so the job
 * that WRITES the ring and the read that serves it can never disagree about which file it is. */
export const HEALTH_PROBE_SIDECAR_SUFFIX = ".health.sqlite" as const;

export interface HealthProbe {
  readonly version: typeof HEALTH_PROBE_VERSION;
  readonly environment: string;
  readonly sha: string;
  readonly status: "SUCCESS" | "FAILURE" | "UNPROBEABLE";
  readonly latencyMs: number;
  readonly at: string;
}

/** Computed only from observations. Empty history is DEGRADED, never invented UP or DOWN. */
export type HealthState = "UP" | "DEGRADED" | "DOWN";

/** A closed incident keeps its opening evidence independently of ring eviction. */
export interface HealthIncident {
  readonly id: number;
  readonly environment: string;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly openingProbes: readonly HealthProbe[];
}

export type HealthProbeCode = typeof PROBE_URL_MISSING | "PROBE_URL_INVALID"
  | "PROBE_ABORTED" | "PROBE_RECORD_INVALID" | "PROBE_STORE_UNAVAILABLE"
  | "PROBE_RECEIPT_MISSING" | "PROBE_RECEIPT_CHANGED" | "PROBE_DEPLOYMENT_UNVERIFIED";

export interface HealthProbeRefusal {
  readonly ok: false;
  readonly code: HealthProbeCode;
  readonly layer: "DAEMON_INGRESS";
}

export type HealthProbeResult<T> = Readonly<{ readonly ok: true; readonly value: T }> | HealthProbeRefusal;
