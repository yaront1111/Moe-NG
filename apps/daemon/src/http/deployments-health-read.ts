/**
 * DEPLOYMENT-ENVIRONMENT HEALTH, over HTTP: POST `/deployments/health/read` answers, for ONE
 * environment, the state an operator needs before they open a log — the derived UP/DEGRADED/DOWN,
 * the last probe, the last recorded error line VERBATIM, the open incident, and the sha of the
 * receipt the current deploy replaced so a caller can name a rollback target.
 *
 * THIS IS NOT `/health/read`. That route serves the DAEMON's own liveness (provider pause,
 * repository reservation). An environment outage behind a daemon-liveness code would make one
 * path mean two unrelated things, so the two stay separate and `health-read.ts` is untouched.
 *
 * THE STATE IS DERIVED, NEVER STORED. `deriveHealthState` — the probe row's own function over the
 * bounded ring — is CALLED here, and nothing served is a persisted status field. A second
 * derivation would be a second opinion, and this route's answer is the one a browser renders.
 *
 * WHERE THE ERROR LINE COMES FROM, AND WHY. The probe ring persists no error text at all —
 * `health-probe-contracts.ts:1` says so: "No URL, body or exception is persisted". The only
 * verbatim error text this domain records is a deploy receipt's `refusal.detail`, documented as
 * docker's own last stderr line. It travels here UNTOUCHED, tagged with its `source`, its `at`,
 * its own code and its own layer, so a consumer can neither mistake a deploy-time line for a
 * probe-time one nor be handed a summary in place of the words the tool actually printed.
 *
 * NO NEW LAYER LITERAL (task rail 6): the one refusal this module mints reuses the rostered
 * `CONTROL_ROOM_LISTENER_LAYER`. projectId comes from the AUTHENTICATED PRINCIPAL, so a payload
 * that names it is an unknown key.
 */
import { decodeBoundedJsonBytes } from "@moe/contracts";

import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import type { EnvironmentDeployState } from "../deployment/deploy-ledger.js";
import type { DeployEngineStamp, DeployRefusalCode } from "../deployment/deploy-receipt-contracts.js";
import { PROBE_URL_MISSING } from "../monitoring/health-probe-contracts.js";
import type {
  HealthIncident, HealthProbe, HealthProbeRefusal, HealthProbeResult, HealthState,
} from "../monitoring/health-probe-contracts.js";
import { deriveHealthState } from "../monitoring/health-probe-ring.js";
import { authenticateHttpRequest } from "./http-command-ingress.js";
import type { Authenticator, HttpPortRefused, HttpRefused } from "./http-contract.js";
import { CONTROL_ROOM_LISTENER_LAYER } from "./http-listener-guards.js";

export const DEPLOYMENTS_HEALTH_READ_PATH = "/deployments/health/read" as const;

export const DEPLOYMENTS_HEALTH_READ_CODES = Object.freeze([
  "DEPLOYMENTS_HEALTH_READ_CAPABILITY_DENIED",
] as const);

export interface DeploymentsHealthReadRefused {
  readonly code: (typeof DEPLOYMENTS_HEALTH_READ_CODES)[number];
  readonly layer: typeof CONTROL_ROOM_LISTENER_LAYER;
  readonly outcome: "REFUSED";
}

/** The recorded error line, carried verbatim beside the code and layer that produced it. */
export interface DeploymentsHealthErrorLine {
  readonly at: string;
  readonly code: DeployRefusalCode;
  readonly layer: DeployEngineStamp;
  /** The tool's own words, exactly as recorded. Never summarised, never truncated. */
  readonly line: string;
  readonly source: "DEPLOY_RECEIPT";
}

export interface DeploymentsHealthView {
  readonly environment: string;
  /** The open incident, or null. A healthy environment has no incident member to fabricate. */
  readonly incident: { readonly id: number; readonly openedAt: string } | null;
  readonly lastError: DeploymentsHealthErrorLine | null;
  readonly lastProbe:
    | { readonly at: string; readonly latencyMs: number; readonly status: HealthProbe["status"] }
    | null;
  readonly ok: true;
  /** The probe row's own refusal when this environment cannot be probed at all. */
  readonly probeRefusal: HealthProbeRefusal | null;
  /** The sha of the receipt the current deploy replaced — the rollback target, or null. */
  readonly rollbackSha: string | null;
  readonly state: HealthState;
}

/**
 * The DURABLE MATERIAL this route projects, never a verdict. Closed over a store and a ring by
 * the composition sibling and by tests; this module opens neither. Deliberately raw: a port that
 * handed back a state would move the derivation out of the served path.
 */
export interface DeploymentsHealthSource {
  readonly deploys: EnvironmentDeployState | null;
  readonly incidents: readonly HealthIncident[];
  readonly probes: readonly HealthProbe[];
}

export interface DeploymentsHealthReadPort {
  read(input: { readonly environment: string }): HealthProbeResult<DeploymentsHealthSource>;
}

const refused = (
  code: (typeof DEPLOYMENTS_HEALTH_READ_CODES)[number],
): DeploymentsHealthReadRefused => Object.freeze({
  code, layer: CONTROL_ROOM_LISTENER_LAYER, outcome: "REFUSED" as const,
});

/**
 * The request codes, SPLIT rather than merged: a caller that named a key this route does not
 * serve and one that named no environment fix different mistakes, so a single generic "decoding
 * failed" would leave them indistinguishable to a client.
 */
export type DeploymentsHealthBodyCode =
  | "LISTENER_DEPLOYMENTS_HEALTH_MISSING_KEY"
  | "LISTENER_DEPLOYMENTS_HEALTH_REQUEST_INVALID"
  | "LISTENER_DEPLOYMENTS_HEALTH_UNKNOWN_KEY";

export type DeploymentsHealthBody =
  | Readonly<{ readonly environment: string; readonly ok: true }>
  | Readonly<{ readonly code: DeploymentsHealthBodyCode; readonly ok: false }>;

const badBody = (code: DeploymentsHealthBodyCode): DeploymentsHealthBody =>
  Object.freeze({ code, ok: false as const });

/**
 * Own enumerable keys are EXACTLY `{environment}` — that name, a non-empty string, and nothing
 * else. `environment` stays raw on the way in so the STORE decides whether it names a known
 * environment; a check here would be a second scope authority answering first.
 */
export function deploymentsHealthReadBodyOf(body: unknown): DeploymentsHealthBody {
  const decoded = decodeBoundedJsonBytes(body);
  if (!decoded.ok) return badBody("LISTENER_DEPLOYMENTS_HEALTH_REQUEST_INVALID");
  const value: unknown = decoded.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return badBody("LISTENER_DEPLOYMENTS_HEALTH_REQUEST_INVALID");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => key !== "environment")) {
    return badBody("LISTENER_DEPLOYMENTS_HEALTH_UNKNOWN_KEY");
  }
  if (!keys.includes("environment")) return badBody("LISTENER_DEPLOYMENTS_HEALTH_MISSING_KEY");
  const environment = record["environment"];
  if (typeof environment !== "string" || environment.length === 0) {
    return badBody("LISTENER_DEPLOYMENTS_HEALTH_REQUEST_INVALID");
  }
  return Object.freeze({ environment, ok: true as const });
}

/** The last receipt that recorded a refusal, in ledger order. Its detail is the error line. */
function errorLineOf(deploys: EnvironmentDeployState | null): DeploymentsHealthErrorLine | null {
  if (deploys === null) return null;
  for (let index = deploys.receipts.length - 1; index >= 0; index -= 1) {
    const receipt = deploys.receipts[index];
    if (receipt?.refusal == null) continue;
    return Object.freeze({
      at: receipt.decidedAt,
      code: receipt.refusal.code,
      layer: receipt.refusal.layer,
      line: receipt.refusal.detail,
      source: "DEPLOY_RECEIPT" as const,
    });
  }
  return null;
}

/**
 * A DEPLOYED environment whose receipt names no url is exactly the condition under which
 * `probeEnvironment` mints PROBE_URL_MISSING, so the refusal carries the probe row's own code and
 * layer. It never makes the state UP: `deriveHealthState` needs a SUCCESS, which such an
 * environment can never record.
 */
function probeRefusalOf(deploys: EnvironmentDeployState | null): HealthProbeRefusal | null {
  if (deploys === null || deploys.current.outcome !== "DEPLOYED" || deploys.current.url !== null) {
    return null;
  }
  return Object.freeze({ code: PROBE_URL_MISSING, layer: "DAEMON_INGRESS" as const, ok: false as const });
}

function openIncidentOf(
  incidents: readonly HealthIncident[],
): { readonly id: number; readonly openedAt: string } | null {
  const open = incidents.findLast((incident) => incident.closedAt === null);
  return open === undefined ? null : Object.freeze({ id: open.id, openedAt: open.openedAt });
}

function lastProbeOf(probes: readonly HealthProbe[]): DeploymentsHealthView["lastProbe"] {
  const probe = probes.at(-1);
  return probe === undefined
    ? null
    : Object.freeze({ at: probe.at, latencyMs: probe.latencyMs, status: probe.status });
}

/** Projection only: every value below is read off the durable material or derived by its owner. */
export function projectDeploymentsHealth(
  environment: string, source: DeploymentsHealthSource,
): DeploymentsHealthView {
  return Object.freeze({
    environment,
    incident: openIncidentOf(source.incidents),
    lastError: errorLineOf(source.deploys),
    lastProbe: lastProbeOf(source.probes),
    ok: true as const,
    probeRefusal: probeRefusalOf(source.deploys),
    rollbackSha: source.deploys?.previous?.sha ?? null,
    state: deriveHealthState(source.probes),
  });
}

export type DeploymentsHealthReadDispatch =
  | {
    readonly body:
      | DeploymentsHealthView | DeploymentsHealthReadRefused | HealthProbeRefusal
      | HttpPortRefused | HttpRefused;
    readonly httpStatus: number;
    readonly kind: "REPLY";
  }
  | {
    readonly code: DeploymentsHealthBodyCode | "LISTENER_DEPLOYMENTS_HEALTH_UNAVAILABLE";
    readonly kind: "LISTENER_REFUSAL";
  };

export function handleDeploymentsHealthReadRequest(
  dependencies: {
    readonly authenticator: Authenticator;
    readonly deploymentsHealth?: DeploymentsHealthReadPort | undefined;
  },
  request: {
    readonly body: unknown;
    readonly credential: string | null;
    readonly protocolVersion: unknown;
  },
): DeploymentsHealthReadDispatch {
  const access = authenticateHttpRequest(
    dependencies.authenticator, request.credential, request.protocolVersion,
  );
  if (!access.ok) {
    return Object.freeze({ body: access, httpStatus: access.httpStatus, kind: "REPLY" });
  }
  // GOAL, the capability every `deployment.*` command already carries (BOOTSTRAP_FAMILY) and the
  // one `/deployments/read` fences on: deployment state belongs to the product a goal produced.
  if (!access.principal.capabilities.includes(CAPABILITIES.GOAL)) {
    return Object.freeze({
      body: refused("DEPLOYMENTS_HEALTH_READ_CAPABILITY_DENIED"), httpStatus: 200, kind: "REPLY",
    });
  }
  const port = dependencies.deploymentsHealth;
  if (port === undefined) {
    return Object.freeze({ code: "LISTENER_DEPLOYMENTS_HEALTH_UNAVAILABLE", kind: "LISTENER_REFUSAL" });
  }
  const decoded = deploymentsHealthReadBodyOf(request.body);
  if (!decoded.ok) return Object.freeze({ code: decoded.code, kind: "LISTENER_REFUSAL" });
  const source = port.read({ environment: decoded.environment });
  // The store's own refusal travels VERBATIM with its code and layer. Reshaping it here is where
  // a health verdict nobody measured would come from.
  if (!source.ok) return Object.freeze({ body: source, httpStatus: 200, kind: "REPLY" });
  return Object.freeze({
    body: projectDeploymentsHealth(decoded.environment, source.value), httpStatus: 200, kind: "REPLY",
  });
}
