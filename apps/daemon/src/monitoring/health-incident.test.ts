import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { HEALTH_PROBE_VERSION } from "./health-probe-contracts.js";
import type { HealthIncident, HealthProbe } from "./health-probe-contracts.js";

interface IncidentApi {
  ensureHealthIncidentSchema(db: DatabaseSync): void;
  updateHealthIncident(db: DatabaseSync, projectId: string, probes: readonly HealthProbe[]): void;
  readHealthIncidents(db: DatabaseSync, projectId: string, environment: string): readonly HealthIncident[];
}

// Keep the red phase an availability assertion, not a module-loader failure.
const modulePath = "./health-incident.js";
const loaded: unknown = await import(modulePath).catch(() => null);
function incidentApi(): IncidentApi {
  expect(loaded, "the production incident module must exist").not.toBeNull();
  const exports = loaded as Readonly<Record<string, unknown>>;
  for (const key of ["ensureHealthIncidentSchema", "updateHealthIncident", "readHealthIncidents"]) {
    expect(typeof exports[key], key).toBe("function");
  }
  return loaded as IncidentApi;
}

const PROJECT = "incident-project";
const ENVIRONMENT = "preview";
const SHA = "a".repeat(40);
const at = (minute: number): string => new Date(Date.UTC(2026, 8, 6, 0, minute)).toISOString();
const probe = (
  minute: number, status: HealthProbe["status"] = "FAILURE", environment = ENVIRONMENT,
): HealthProbe => Object.freeze({
  at: at(minute), environment, latencyMs: 4, sha: SHA, status, version: HEALTH_PROBE_VERSION,
});

function withDatabase(body: (db: DatabaseSync, path: string, api: IncidentApi) => void): void {
  const api = incidentApi();
  const temporaryRoot = realpathSync(tmpdir());
  const directory = mkdtempSync(join(temporaryRoot, "moe-health-incident-"));
  const path = join(directory, "main.sqlite");
  const db = new DatabaseSync(path);
  try {
    api.ensureHealthIncidentSchema(db);
    body(db, path, api);
  } finally {
    db.close();
    if (dirname(resolve(directory)) !== temporaryRoot) throw new Error("unsafe incident fixture cleanup");
    rmSync(directory, { force: true, recursive: true });
  }
}

function update(
  db: DatabaseSync, api: IncidentApi, probes: readonly HealthProbe[], projectId = PROJECT,
): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    api.updateHealthIncident(db, projectId, probes);
    db.exec("COMMIT");
  } catch (error: unknown) {
    db.exec("ROLLBACK");
    throw error;
  }
}

describe("durable health incidents", () => {
  it("publishes the incident persistence entry points", () => {
    incidentApi();
  });

  it("creates its schema idempotently without inventing an incident", () => {
    withDatabase((db, _path, api) => {
      api.ensureHealthIncidentSchema(db);
      expect(api.readHealthIncidents(db, PROJECT, ENVIRONMENT)).toEqual([]);
      update(db, api, []);
      expect(api.readHealthIncidents(db, PROJECT, ENVIRONMENT)).toEqual([]);
    });
  });

  it("opens once on the third consecutive failure and retains the opening evidence", () => {
    withDatabase((db, _path, api) => {
      const ring: HealthProbe[] = [];
      for (let minute = 1; minute <= 2; minute += 1) {
        ring.push(probe(minute));
        update(db, api, ring);
        expect(api.readHealthIncidents(db, PROJECT, ENVIRONMENT)).toEqual([]);
      }
      ring.push(probe(3));
      update(db, api, ring);
      const opened = api.readHealthIncidents(db, PROJECT, ENVIRONMENT);
      expect(opened).toHaveLength(1);
      expect(opened[0]).toEqual({
        closedAt: null, environment: ENVIRONMENT, id: expect.any(Number),
        openedAt: at(3), openingProbes: ring,
      });
      for (let minute = 4; minute <= 13; minute += 1) {
        ring.push(probe(minute));
        update(db, api, ring);
        expect(api.readHealthIncidents(db, PROJECT, ENVIRONMENT)).toEqual(opened);
      }
      ring.push(probe(14, "SUCCESS"));
      update(db, api, ring);
      const closed = [{ ...opened[0], closedAt: at(14) }];
      const recovered = api.readHealthIncidents(db, PROJECT, ENVIRONMENT);
      expect(recovered).toEqual(closed);
      expect(recovered.filter((incident) => incident.closedAt === null)).toHaveLength(0);
      for (let minute = 15; minute <= 17; minute += 1) {
        ring.push(probe(minute));
        update(db, api, ring);
        if (minute < 17) expect(api.readHealthIncidents(db, PROJECT, ENVIRONMENT)).toEqual(closed);
      }
      const secondOutage = api.readHealthIncidents(db, PROJECT, ENVIRONMENT);
      expect(secondOutage).toHaveLength(2);
      expect(secondOutage.filter((incident) => incident.closedAt !== null)).toEqual(closed);
      const reopened = secondOutage.filter((incident) => incident.closedAt === null);
      expect(reopened).toEqual([{ closedAt: null, environment: ENVIRONMENT,
        id: expect.any(Number), openedAt: at(17), openingProbes: ring.slice(-3) }]);
      expect(reopened[0]?.id).not.toBe(opened[0]?.id);
    });
  });

  it("closes on success and opens a different incident for a later outage", () => {
    withDatabase((db, _path, api) => {
      const ring = [probe(1), probe(2), probe(3)];
      update(db, api, ring);
      const first = api.readHealthIncidents(db, PROJECT, ENVIRONMENT)[0];
      expect(first).toBeDefined();
      ring.push(probe(4, "SUCCESS"));
      update(db, api, ring);
      expect(api.readHealthIncidents(db, PROJECT, ENVIRONMENT)).toEqual([
        { ...first, closedAt: at(4) },
      ]);
      update(db, api, ring);
      expect(api.readHealthIncidents(db, PROJECT, ENVIRONMENT)).toHaveLength(1);
      ring.push(probe(5), probe(6));
      update(db, api, ring);
      expect(api.readHealthIncidents(db, PROJECT, ENVIRONMENT)).toHaveLength(1);
      ring.push(probe(7));
      update(db, api, ring);
      const incidents = api.readHealthIncidents(db, PROJECT, ENVIRONMENT);
      expect(incidents).toHaveLength(2);
      expect(incidents.filter((incident) => incident.closedAt !== null)).toEqual([
        { ...first, closedAt: at(4) },
      ]);
      const open = incidents.filter((incident) => incident.closedAt === null);
      expect(open).toHaveLength(1);
      expect(open[0]).toEqual({
        closedAt: null, environment: ENVIRONMENT, id: expect.any(Number),
        openedAt: at(7), openingProbes: ring.slice(-3),
      });
      expect(open[0]?.id).not.toBe(first?.id);
    });
  });

  it("does not count intermittent failures across successful observations", () => {
    withDatabase((db, _path, api) => {
      const ring: HealthProbe[] = [];
      for (let minute = 1; minute <= 12; minute += 1) {
        ring.push(probe(minute, minute % 3 === 0 ? "SUCCESS" : "FAILURE"));
        update(db, api, ring);
        expect(api.readHealthIncidents(db, PROJECT, ENVIRONMENT)).toEqual([]);
      }
    });
  });

  it("does not treat missing probe observations as a third failure or a recovery", () => {
    withDatabase((db, _path, api) => {
      const ring = [probe(1), probe(2), probe(3, "UNPROBEABLE")];
      update(db, api, ring);
      expect(api.readHealthIncidents(db, PROJECT, ENVIRONMENT)).toEqual([]);
      ring.push(probe(4), probe(5));
      update(db, api, ring);
      expect(api.readHealthIncidents(db, PROJECT, ENVIRONMENT)).toEqual([]);
      ring.push(probe(6));
      update(db, api, ring);
      const opened = api.readHealthIncidents(db, PROJECT, ENVIRONMENT);
      expect(opened).toHaveLength(1);
      ring.push(probe(7, "UNPROBEABLE"));
      update(db, api, ring);
      expect(api.readHealthIncidents(db, PROJECT, ENVIRONMENT)).toEqual(opened);
    });
  });

  it("isolates open incidents and recovery across projects and environments", () => {
    withDatabase((db, _path, api) => {
      const preview = [probe(1), probe(2), probe(3)];
      const production = [1, 2, 3].map((minute) => probe(minute, "FAILURE", "production"));
      update(db, api, preview);
      update(db, api, production);
      update(db, api, preview, "other-project");
      const otherEnvironment = api.readHealthIncidents(db, PROJECT, "production");
      const otherProject = api.readHealthIncidents(db, "other-project", ENVIRONMENT);
      expect(otherEnvironment).toHaveLength(1);
      expect(otherProject).toHaveLength(1);
      update(db, api, [...preview, probe(4, "SUCCESS")]);
      expect(api.readHealthIncidents(db, PROJECT, ENVIRONMENT)[0]?.closedAt).toBe(at(4));
      expect(api.readHealthIncidents(db, PROJECT, "production")).toEqual(otherEnvironment);
      expect(api.readHealthIncidents(db, "other-project", ENVIRONMENT)).toEqual(otherProject);
      expect(api.readHealthIncidents(db, "absent-project", ENVIRONMENT)).toEqual([]);
    });
  });

  it("retains original evidence on disk after the supplied ring evicts it", () => {
    withDatabase((db, path, api) => {
      const opening = [probe(1), probe(2), probe(3)];
      update(db, api, opening);
      const opened = api.readHealthIncidents(db, PROJECT, ENVIRONMENT)[0];
      expect(opened).toBeDefined();
      const evicted = Array.from({ length: 1440 }, (_, index) => probe(index + 4));
      update(db, api, evicted);
      update(db, api, [...evicted.slice(1), probe(1444, "SUCCESS")]);
      const reopened = new DatabaseSync(path);
      try {
        api.ensureHealthIncidentSchema(reopened);
        expect(api.readHealthIncidents(reopened, PROJECT, ENVIRONMENT)).toEqual([
          { ...opened, closedAt: at(1444), openingProbes: opening },
        ]);
      } finally { reopened.close(); }
    });
  });

  it("rolls back incident changes with its caller's transaction", () => {
    withDatabase((db, _path, api) => {
      db.exec("BEGIN IMMEDIATE");
      api.updateHealthIncident(db, PROJECT, [probe(1), probe(2), probe(3)]);
      expect(api.readHealthIncidents(db, PROJECT, ENVIRONMENT)).toHaveLength(1);
      db.exec("ROLLBACK");
      expect(api.readHealthIncidents(db, PROJECT, ENVIRONMENT)).toEqual([]);
    });
  });

  it("creates a database-enforced unique open-incident index", () => {
    withDatabase((db) => {
      const indexes = db.prepare("PRAGMA index_list(health_incidents)").all();
      const unique = indexes.filter((index) => index.unique === 1 && index.partial === 1);
      expect(unique).toHaveLength(1);
      const indexName = unique[0]?.name;
      expect(typeof indexName).toBe("string");
      const columns = db.prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno").all(indexName ?? "");
      expect(columns.map((column) => column.name)).toEqual(["project_id", "environment"]);
    });
  });

  it.each([
    ["invalid JSON", "{"],
    ["non-array", "{}"],
    ["wrong threshold", JSON.stringify([probe(1), probe(2)])],
    ...[
      ["unknown field", { secret: "not-admitted" }],
      ["wrong version", { version: "unknown/1" }],
      ["foreign environment", { environment: "production" }],
      ["invalid SHA", { sha: "bad" }],
      ["non-failure", { status: "SUCCESS" }],
      ["negative latency", { latencyMs: -1 }],
      ["fractional latency", { latencyMs: 1.5 }],
      ["invalid timestamp", { at: "invalid" }],
    ].map(([name, changed]) => [name, JSON.stringify([
      { ...probe(1), ...(changed as Readonly<Record<string, unknown>>) }, probe(2), probe(3),
    ])]),
  ])("refuses corrupt opening evidence: %s", (_name, value) => {
    withDatabase((db, _path, api) => {
      update(db, api, [probe(1), probe(2), probe(3)]);
      db.prepare("UPDATE health_incidents SET opening_probes_json = ?").run(String(value));
      expect(() => api.readHealthIncidents(db, PROJECT, ENVIRONMENT))
        .toThrowError(/^PROBE_STORE_UNAVAILABLE$/u);
      expect(() => update(db, api, [probe(4, "SUCCESS")]))
        .toThrowError(/^PROBE_STORE_UNAVAILABLE$/u);
    });
  });

  it.each(["opened_at", "closed_at"])("refuses an invalid stored %s", (column) => {
    withDatabase((db, _path, api) => {
      update(db, api, [probe(1), probe(2), probe(3)]);
      db.exec(`UPDATE health_incidents SET ${column} = 'invalid'`);
      expect(() => api.readHealthIncidents(db, PROJECT, ENVIRONMENT))
        .toThrowError(/^PROBE_STORE_UNAVAILABLE$/u);
    });
  });
});
