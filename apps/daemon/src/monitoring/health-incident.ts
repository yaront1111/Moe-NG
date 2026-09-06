import type { DatabaseSync } from "node:sqlite";
import { admitDeploySha, admitEnvironmentName } from "../deployment/deploy-receipt-contracts.js";
import { HEALTH_FAILURE_THRESHOLD, HEALTH_PROBE_VERSION } from "./health-probe-contracts.js";
import type { HealthIncident, HealthProbe } from "./health-probe-contracts.js";

const COLUMNS = "id, environment, opened_at, closed_at, opening_probes_json";
const PROBE_KEYS = ["at", "environment", "latencyMs", "sha", "status", "version"] as const;
const unavailable = (): never => { throw new Error("PROBE_STORE_UNAVAILABLE"); };
const isInstant = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

/** The sidecar connection and its transaction belong to the caller, never to this module. */
export function ensureHealthIncidentSchema(db: DatabaseSync): void {
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS health_incidents (
      id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, environment TEXT NOT NULL,
      opened_at TEXT NOT NULL, closed_at TEXT, opening_probes_json TEXT NOT NULL
    ); CREATE UNIQUE INDEX IF NOT EXISTS health_incidents_one_open
      ON health_incidents(project_id, environment) WHERE closed_at IS NULL;`);
  } catch { unavailable(); }
}

function openingProbe(value: unknown, environment: string): HealthProbe {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return unavailable();
  const fields = value as Readonly<Record<string, unknown>>;
  if (Object.keys(fields).sort().join("\n") !== PROBE_KEYS.join("\n")) return unavailable();
  const { at, latencyMs, sha, status, version } = fields;
  if (fields.environment !== environment || !isInstant(at) || admitDeploySha(sha) === null
    || status !== "FAILURE" || version !== HEALTH_PROBE_VERSION
    || typeof latencyMs !== "number" || !Number.isSafeInteger(latencyMs) || latencyMs < 0) return unavailable();
  return Object.freeze({ at, environment, latencyMs, sha: sha as string, status, version });
}

function openingProbes(value: unknown, environment: string): readonly HealthProbe[] {
  if (!Array.isArray(value) || value.length !== HEALTH_FAILURE_THRESHOLD) return unavailable();
  const entries: readonly unknown[] = value;
  return Object.freeze(entries.map((entry) => openingProbe(entry, environment)));
}

function incidentOf(row: Readonly<Record<string, unknown>>, environment: string): HealthIncident {
  const { id, opened_at: openedAt, closed_at: closedAt, opening_probes_json: bytes } = row;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0 || row.environment !== environment
    || admitEnvironmentName(environment) === null || !isInstant(openedAt)
    || (closedAt !== null && !isInstant(closedAt)) || typeof bytes !== "string") return unavailable();
  const parsed: unknown = JSON.parse(bytes);
  const probes = openingProbes(parsed, environment);
  if (probes.at(-1)?.at !== openedAt) return unavailable();
  return Object.freeze({ id, environment, openedAt, closedAt, openingProbes: probes });
}

/** Corrupt evidence never becomes a healthy incident or leaks database/parser diagnostics. */
export function readHealthIncidents(
  db: DatabaseSync, projectId: string, environment: string,
): readonly HealthIncident[] {
  try {
    const rows = db.prepare(`SELECT ${COLUMNS} FROM health_incidents
      WHERE project_id = ? AND environment = ? ORDER BY id`).all(projectId, environment);
    return Object.freeze(rows.map((row) => incidentOf(row, environment)));
  } catch { return unavailable(); }
}

/** Called after one ring append inside the caller's BEGIN IMMEDIATE transaction.
 * Insertion order is authoritative; wall clocks may move backwards between probes. */
export function updateHealthIncident(
  db: DatabaseSync, projectId: string, probes: readonly HealthProbe[],
): void {
  const latest = probes.at(-1);
  if (latest === undefined) return;
  try {
    const { environment } = latest;
    const rows = db.prepare(`SELECT ${COLUMNS} FROM health_incidents
      WHERE project_id = ? AND environment = ? AND closed_at IS NULL`).all(projectId, environment);
    if (rows.length > 1) return unavailable();
    const current = rows[0] === undefined ? null : incidentOf(rows[0], environment);
    if (current !== null) {
      if (latest.status === "SUCCESS") {
        if (!isInstant(latest.at)) return unavailable();
        db.prepare("UPDATE health_incidents SET closed_at = ? WHERE id = ? AND closed_at IS NULL")
          .run(latest.at, current.id);
      }
      return;
    }
    const tail = probes.slice(-HEALTH_FAILURE_THRESHOLD);
    if (tail.length !== HEALTH_FAILURE_THRESHOLD || tail.some((probe) => probe.status !== "FAILURE")) return;
    const opening = openingProbes(tail, environment);
    if (admitEnvironmentName(environment) === null) return unavailable();
    db.prepare(`INSERT INTO health_incidents(project_id, environment, opened_at, opening_probes_json)
      VALUES (?, ?, ?, ?)`).run(projectId, environment, latest.at, JSON.stringify(opening));
  } catch { unavailable(); }
}
