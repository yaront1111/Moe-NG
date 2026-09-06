import { chmodSync, existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SqliteEventStore } from "@moe/store";
import { DEPLOY_ENGINE_PRINCIPAL_ID, DEPLOY_RECEIPT_COMMAND_KIND, admitDeploySha, admitEnvironmentName, deployAggregateId }
  from "../deployment/deploy-receipt-contracts.js";
import type { DeployReceiptV1 } from "../deployment/deploy-receipt-contracts.js";
import { readCurrentDeployReceipt, readDeployLedger } from "../deployment/deploy-ledger.js";
import { DEPLOYMENT_HEALTH_PATH } from "../repository/deployment/deployment-infrastructure-templates.js";
import { ensureHealthIncidentSchema, readHealthIncidents, updateHealthIncident } from "./health-incident.js";
import { HEALTH_FAILURE_THRESHOLD, HEALTH_PROBE_RING_LIMIT, HEALTH_PROBE_VERSION } from "./health-probe-contracts.js";
import type { HealthIncident, HealthProbe, HealthProbeCode, HealthProbeResult, HealthState } from "./health-probe-contracts.js";

const APPLICATION_ID = 0x4d485031;
const KEYS = ["version", "environment", "sha", "status", "latencyMs", "at"] as const;
const refusal = (code: HealthProbeCode) => Object.freeze({ ok: false, code, layer: "DAEMON_INGRESS" } as const);

function probeOf(value: unknown): HealthProbe | null {
  if (typeof value !== "object" || value === null) return null;
  const properties = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(properties).length !== KEYS.length
    || KEYS.some((key) => !properties[key]?.enumerable || !("value" in properties[key]))) return null;
  const fields = Object.fromEntries(KEYS.map((key) => [key, properties[key]?.value])) as Record<string, unknown>;
  const { version, environment, sha, status, latencyMs, at } = fields;
  if (version !== HEALTH_PROBE_VERSION || admitEnvironmentName(environment) === null || admitDeploySha(sha) === null
    || (status !== "SUCCESS" && status !== "FAILURE" && status !== "UNPROBEABLE")
    || typeof latencyMs !== "number" || !Number.isSafeInteger(latencyMs) || latencyMs < 0
    || typeof at !== "string" || !Number.isFinite(Date.parse(at))) return null;
  return Object.freeze({ version, environment: environment as string, sha: sha as string, status, latencyMs, at });
}

function initialize(database: DatabaseSync, create: boolean): void {
  const app = database.prepare("PRAGMA application_id").get()?.application_id;
  const version = database.prepare("PRAGMA user_version").get()?.user_version;
  if (create && app === 0 && version === 0 && database.prepare("SELECT name FROM sqlite_master").all().length === 0) {
    database.exec(`CREATE TABLE health_probes (
      sequence INTEGER PRIMARY KEY, project_id TEXT NOT NULL, environment TEXT NOT NULL,
      version TEXT NOT NULL, sha TEXT NOT NULL, status TEXT NOT NULL, latencyMs INTEGER NOT NULL, at TEXT NOT NULL
    ); CREATE INDEX health_probe_scope ON health_probes(project_id, environment, sequence);
    PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = 1;`);
    ensureHealthIncidentSchema(database);
  } else if (app !== APPLICATION_ID || version !== 1) throw new Error("PROBE_STORE_UNAVAILABLE");
  const names = database.prepare("SELECT name FROM sqlite_master ORDER BY name").all().map((row) => row.name);
  if (names.join("\n") !== ["health_incidents", "health_incidents_one_open", "health_probe_scope", "health_probes"].join("\n")) {
    throw new Error("PROBE_STORE_UNAVAILABLE");
  }
}

function access<T>(path: string, operation: (database: DatabaseSync) => T, create = false): HealthProbeResult<T> {
  let database: DatabaseSync | null = null;
  let transaction = false;
  try {
    if (!isAbsolute(path)) return refusal("PROBE_STORE_UNAVAILABLE");
    const existed = existsSync(path);
    if (!existed && !create) return refusal("PROBE_STORE_UNAVAILABLE");
    database = new DatabaseSync(path);
    database.exec("PRAGMA busy_timeout = 1000; PRAGMA synchronous = FULL; BEGIN IMMEDIATE");
    transaction = true;
    initialize(database, create && !existed);
    if (!existed) chmodSync(path, 0o600);
    const value = operation(database);
    database.exec("COMMIT"); transaction = false;
    return Object.freeze({ ok: true, value });
  } catch { return refusal("PROBE_STORE_UNAVAILABLE"); }
  finally {
    if (database !== null) {
      if (transaction) { try { database.exec("ROLLBACK"); } catch { /* No success is returned. */ } }
      database.close();
    }
  }
}

function rows(database: DatabaseSync, projectId: string, environment: string): readonly HealthProbe[] {
  const records = database.prepare(`SELECT version, environment, sha, status, latencyMs, at
    FROM health_probes WHERE project_id = ? AND environment = ? ORDER BY sequence`).all(projectId, environment);
  if (records.length > HEALTH_PROBE_RING_LIMIT) throw new Error("PROBE_STORE_UNAVAILABLE");
  return Object.freeze(records.map((record) => {
    const probe = probeOf(record);
    if (probe === null) throw new Error("PROBE_STORE_UNAVAILABLE");
    return probe;
  }));
}

export interface HealthProbeRing {
  append(probe: HealthProbe): HealthProbeResult<readonly HealthProbe[]>;
  read(environment: string): HealthProbeResult<readonly HealthProbe[]>;
  incidents(environment: string): HealthProbeResult<readonly HealthIncident[]>;
}

/** Per-operation connections own no shutdown handle. Sequence order survives backwards clocks.
 * Only this sidecar's probe rows are evicted; the main event database is never opened here. */
export function createHealthProbeRing(path: string, projectId: string): HealthProbeRing {
  return Object.freeze({
    append(input: HealthProbe): HealthProbeResult<readonly HealthProbe[]> {
      let probe: HealthProbe | null;
      try { probe = probeOf(input); } catch { probe = null; }
      if (probe === null) return refusal("PROBE_RECORD_INVALID");
      return access(path, (database) => {
        database.prepare(`INSERT INTO health_probes(project_id, environment, version, sha, status, latencyMs, at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(projectId, probe.environment, probe.version, probe.sha, probe.status, probe.latencyMs, probe.at);
        database.prepare(`DELETE FROM health_probes WHERE project_id = ? AND environment = ? AND sequence NOT IN
          (SELECT sequence FROM health_probes WHERE project_id = ? AND environment = ? ORDER BY sequence DESC LIMIT ?)`)
          .run(projectId, probe.environment, projectId, probe.environment, HEALTH_PROBE_RING_LIMIT);
        const history = rows(database, projectId, probe.environment);
        updateHealthIncident(database, projectId, history);
        return history;
      }, true);
    },
    read(environment: string): HealthProbeResult<readonly HealthProbe[]> {
      if (admitEnvironmentName(environment) === null) return refusal("PROBE_RECORD_INVALID");
      if (!isAbsolute(path)) return refusal("PROBE_STORE_UNAVAILABLE");
      if (!existsSync(path)) return Object.freeze({ ok: true, value: Object.freeze([]) });
      return access(path, (database) => rows(database, projectId, environment));
    },
    incidents(environment: string): HealthProbeResult<readonly HealthIncident[]> {
      if (admitEnvironmentName(environment) === null) return refusal("PROBE_RECORD_INVALID");
      if (!isAbsolute(path)) return refusal("PROBE_STORE_UNAVAILABLE");
      if (!existsSync(path)) return Object.freeze({ ok: true, value: Object.freeze([]) });
      return access(path, (database) => readHealthIncidents(database, projectId, environment));
    },
  });
}

export function deriveHealthState(probes: readonly HealthProbe[]): HealthState {
  if (probes.at(-1)?.status === "SUCCESS") return "UP";
  const tail = probes.slice(-HEALTH_FAILURE_THRESHOLD);
  return tail.length === HEALTH_FAILURE_THRESHOLD && tail.every((probe) => probe.status === "FAILURE") ? "DOWN" : "DEGRADED";
}

export type HealthHttpPort = (url: string, signal: AbortSignal) => Promise<number>;
export interface HealthProbeOptions {
  readonly store: SqliteEventStore;
  readonly projectId: string;
  readonly environment: string;
  readonly ring: HealthProbeRing;
  readonly signal: AbortSignal;
  readonly http?: HealthHttpPort;
  readonly clock?: () => string;
}

const nodeHttp: HealthHttpPort = async (url, signal) => {
  const response = await fetch(url, { signal, redirect: "error" });
  await response.body?.cancel();
  return response.status;
};

function healthUrl(base: string | null): string | null {
  try {
    if (base === null) return null;
    const url = new URL(base);
    if (!["http:", "https:"].includes(url.protocol) || url.username !== "" || url.password !== "") return null;
    return new URL(DEPLOYMENT_HEALTH_PATH, url).href;
  } catch { return null; }
}

/** A port that ignores cancellation still cannot keep this job pending or persist late success. */
function statusOf(http: HealthHttpPort, url: string, signal: AbortSignal): Promise<number> {
  return new Promise((resolve) => {
    const finish = (status: number): void => { signal.removeEventListener("abort", abort); resolve(status); };
    const abort = (): void => finish(0);
    if (signal.aborted) { finish(0); return; }
    signal.addEventListener("abort", abort, { once: true });
    try { void http(url, signal).then(finish, () => finish(0)); } catch { finish(0); }
  });
}

/** The broad ledger reader skips invalid receipts; the physical tip must still attest this one. */
function receiptIsTip(store: SqliteEventStore, receipt: DeployReceiptV1): boolean {
  try {
    const aggregateId = deployAggregateId(receipt.projectId, receipt.environment);
    const version = store.getAggregateVersion(aggregateId);
    if (version < 1) return false;
    const page = store.readAggregateEvents(aggregateId, version - 1, 1);
    const event = page.items[0], trace = event?.decisionTrace;
    if (page.hasMore || page.items.length !== 1 || event === undefined
      || event.aggregateSequence !== version || event.aggregateId !== aggregateId
      || event.eventId !== `${receipt.receiptId}-DeployRecorded`
      || event.eventType !== (receipt.outcome === "DEPLOYED" ? "EnvironmentDeployed" : "EnvironmentDeployRefused")
      || trace?.commandId !== receipt.receiptId || trace.commandKind !== DEPLOY_RECEIPT_COMMAND_KIND
      || trace.principalId !== DEPLOY_ENGINE_PRINCIPAL_ID || trace.projectId !== receipt.projectId) return false;
    const decoded: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(event.payload));
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) return false;
    const payload = decoded as Record<string, unknown>;
    return Object.keys(payload).length === 4 && payload.environment === receipt.environment
      && payload.outcome === receipt.outcome && payload.receiptId === receipt.receiptId && payload.sha === receipt.sha
      && store.getAggregateVersion(aggregateId) === version;
  } catch { return false; }
}

export async function probeEnvironment(options: HealthProbeOptions): Promise<HealthProbeResult<HealthProbe>> {
  if (options.signal.aborted) return refusal("PROBE_ABORTED");
  try {
    const receipt = readCurrentDeployReceipt(options.store, options.projectId, options.environment);
    if (receipt === null) return refusal("PROBE_RECEIPT_MISSING");
    if (receipt.outcome !== "DEPLOYED" || !receiptIsTip(options.store, receipt)) return refusal("PROBE_DEPLOYMENT_UNVERIFIED");
    const url = healthUrl(receipt.url);
    const missing = receipt.url === null ? "PROBE_URL_MISSING" : "PROBE_URL_INVALID";
    const start = performance.now();
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]);
    const status = url === null ? 0 : await statusOf(options.http ?? nodeHttp, url, signal);
    // release() aborts synchronously but does not await us; never touch a possibly closed store after it.
    if (options.signal.aborted) return refusal("PROBE_ABORTED");
    if (readCurrentDeployReceipt(options.store, options.projectId, options.environment)?.receiptId !== receipt.receiptId
      || !receiptIsTip(options.store, receipt)) {
      return refusal("PROBE_RECEIPT_CHANGED");
    }
    const probe: HealthProbe = Object.freeze({ version: HEALTH_PROBE_VERSION, environment: receipt.environment,
      sha: receipt.sha, status: url === null ? "UNPROBEABLE" : status >= 200 && status < 300 ? "SUCCESS" : "FAILURE",
      latencyMs: Math.max(0, Math.round(performance.now() - start)), at: (options.clock ?? (() => new Date().toISOString()))() });
    const appended = options.ring.append(probe);
    if (!appended.ok) return appended;
    return url === null ? refusal(missing) : Object.freeze({ ok: true, value: probe });
  } catch { return refusal("PROBE_STORE_UNAVAILABLE"); }
}

/** Composition owns the timer. A null durable path is not a license to create a cwd sidecar. */
export function createHealthProbeJob(
  options: Omit<HealthProbeOptions, "environment" | "ring" | "signal">,
): (signal: AbortSignal) => Promise<void> {
  const databasePath = options.store.getHealth().databasePath;
  if (databasePath === null) throw new Error("PROBE_STORE_UNAVAILABLE");
  const ring = createHealthProbeRing(`${databasePath}.health.sqlite`, options.projectId);
  return async (signal) => {
    if (signal.aborted) return;
    let failure: HealthProbeCode | null = null;
    for (const environment of readDeployLedger(options.store, options.projectId).keys()) {
      if (signal.aborted) return;
      const result = await probeEnvironment({ ...options, environment, ring, signal });
      if (!result.ok) failure = result.code;
    }
    if (!signal.aborted && failure !== null) throw new Error(failure);
  };
}
