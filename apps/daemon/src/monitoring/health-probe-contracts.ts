/** Probe observations, not a stored health verdict. No URL, body or exception is persisted. */
export const HEALTH_PROBE_VERSION = "moe-health-probe/1" as const;
export const HEALTH_PROBE_RING_LIMIT = 1440;
export const HEALTH_FAILURE_THRESHOLD = 3;
export const PROBE_URL_MISSING = "PROBE_URL_MISSING" as const;
export const HEALTH_PROBE_JOB_ID = "monitoring/health-probes" as const;

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
