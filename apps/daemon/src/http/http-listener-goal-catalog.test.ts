import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { DatabaseSync } from "node:sqlite";

import { reduceGoal } from "@moe/core";
import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  PROJECT_ID, driveThrough, envelope, send as sendBootstrap,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import type { AuthenticationResult, CommandAdapterDeps } from "./http-contract.js";
import { createGoalCatalogReadPort } from "./goal-catalog-read.js";
import { startControlRoomListener } from "./http-listener.js";
import type { ControlRoomListener } from "./http-listener.js";

const PROJECT = PROJECT_ID;
const FOREIGN_PROJECT = "project-goal-catalog-foreign";
const CSRF = "goal-catalog-csrf";
const CREDENTIAL = "goal-catalog-session";
const NO_CAPABILITY_CREDENTIAL = "goal-catalog-readonly";
const FOREIGN_PROJECT_CREDENTIAL = "goal-catalog-foreign-project";
const ENCODER = new TextEncoder();

const directories: string[] = [];
const listeners: ControlRoomListener[] = [];
const stores: SqliteEventStore[] = [];

afterEach(async () => {
  while (listeners.length > 0) await listeners.pop()?.close();
  while (stores.length > 0) stores.pop()?.close();
  while (directories.length > 0) rmSync(directories.pop() as string, { force: true, recursive: true });
});

interface StoreHarness {
  readonly databasePath: string;
  readonly store: SqliteEventStore;
}

function openStore(): StoreHarness {
  const directory = mkdtempSync(join(tmpdir(), "moe-goal-catalog-"));
  const databasePath = join(directory, "store.db");
  const store = SqliteEventStore.openForProject(databasePath, PROJECT);
  directories.push(directory);
  stores.push(store);
  return { databasePath, store };
}

function goalPayload(goalId: string, planningRunRef: string, projectId = PROJECT): Uint8Array {
  const reduced = reduceGoal(undefined, {
    budgetAccountRef: `budget-${goalId}`,
    commandId: `create-${goalId}`,
    expectedVersion: 0,
    goalId,
    kind: "goal.create",
    planningRunRef,
    projectId,
    witness: { projectReadyRef: `ready-${goalId}`, truthClass: "DAEMON_VERIFIED" },
  });
  if (!reduced.ok) throw new Error(`goal reducer refused ${goalId}`);
  return ENCODER.encode(JSON.stringify(reduced.events));
}

function commitGoalRow(
  store: SqliteEventStore,
  goalId: string,
  planningRunRef: string,
  options: { readonly payload?: Uint8Array; readonly projectId?: string } = {},
): string {
  const commandId = `create-${goalId}`;
  const eventId = `${commandId}-GoalCreated`;
  const payload = options.payload ?? goalPayload(
    goalId, planningRunRef, options.projectId ?? PROJECT,
  );
  store.commitExpectedVersionDecision({
    commandKind: "goal.create",
    committedResultBytes: ENCODER.encode("{}"),
    correlationId: `correlation-${goalId}`,
    decidedAt: "2026-08-24T00:00:00.000Z",
    events: [{ eventId, eventType: "GoalCreated", payload }],
    expectedVersion: 0,
    key: { commandId, principalId: "operator-local", projectId: PROJECT },
    requestBytes: ENCODER.encode(JSON.stringify({ kind: "goal.create" })),
    targetAggregateId: goalId,
  });
  return eventId;
}

function createGoalThroughProduction(
  store: SqliteEventStore, goalId: string, planningRunRef: string,
): void {
  driveThrough(store, "goal.create");
  const result = sendBootstrap(store, envelope("goal.create", 0, {
    budgetAccountRef: `budget-${goalId}`,
    goalId,
    planningRunRef,
    witness: { projectReadyRef: `ready-${goalId}`, truthClass: "DAEMON_VERIFIED" },
  }, `command-${goalId}`));
  if (!result.ok) throw new Error(`production goal.create refused: ${result.code}`);
}

function authentication(credential: string | null): AuthenticationResult {
  if (credential === CREDENTIAL) {
    return {
      principal: {
        capabilities: [CAPABILITIES.GOAL], principalId: "operator-local", projectId: PROJECT,
      },
      verdict: "AUTHENTICATED",
    };
  }
  if (credential === NO_CAPABILITY_CREDENTIAL) {
    return {
      principal: { capabilities: [], principalId: "reader", projectId: PROJECT },
      verdict: "AUTHENTICATED",
    };
  }
  if (credential === FOREIGN_PROJECT_CREDENTIAL) {
    return {
      principal: {
        capabilities: [CAPABILITIES.GOAL], principalId: "foreign-reader",
        projectId: FOREIGN_PROJECT,
      },
      verdict: "AUTHENTICATED",
    };
  }
  return { verdict: "UNAUTHENTICATED" };
}

async function start(
  store: SqliteEventStore, withCatalog = true,
): Promise<ControlRoomListener> {
  const deps: CommandAdapterDeps = {
    authenticator: { authenticate: authentication },
    decisions: { decide: (): never => { throw new Error("goal read entered decision port"); } },
    registry: { get: (): never => { throw new Error("goal read entered command registry"); } },
  } as unknown as CommandAdapterDeps;
  const candidate = await startControlRoomListener({
    csrfToken: CSRF,
    deps,
    ...(withCatalog
      ? { goalCatalog: createGoalCatalogReadPort({ projectId: PROJECT, store }) }
      : {}),
  });
  if (!candidate.ok) throw new Error(`listener failed: ${candidate.code}`);
  listeners.push(candidate);
  return candidate;
}

async function send(listener: ControlRoomListener, options: {
  readonly body?: string;
  readonly credential?: string | null;
  readonly method?: string;
} = {}): Promise<{ readonly body: Record<string, unknown>; readonly status: number }> {
  const payload = options.body ?? "{}";
  const headers: Record<string, string | number> = {
    "content-length": Buffer.byteLength(payload),
    "content-type": "application/json",
    host: `127.0.0.1:${listener.port}`,
    origin: listener.origin,
    "x-moe-csrf": CSRF,
    "x-moe-protocol-version": WIRE_PROTOCOL_VERSION,
  };
  if (options.credential !== null) {
    headers["x-moe-session-credential"] = options.credential ?? CREDENTIAL;
  }
  return await new Promise((resolve, reject) => {
    const request = httpRequest({
      headers, host: "127.0.0.1", method: options.method ?? "POST",
      path: "/goals/read", port: listener.port, setHost: false,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          body: (text === "" ? {} : JSON.parse(text)) as Record<string, unknown>,
          status: response.statusCode ?? 0,
        });
      });
    });
    request.on("error", reject);
    request.end(payload);
  });
}

describe("POST /goals/read", () => {
  it("returns the random durable goal and its non-default planning run", async () => {
    const { store } = openStore();
    const goalId = `goal-${randomUUID()}`;
    const planningRunRef = `run-${randomUUID()}`;
    expect([goalId, planningRunRef]).not.toContain("goal-live-1");
    expect([goalId, planningRunRef]).not.toContain("run-live-1");
    createGoalThroughProduction(store, goalId, planningRunRef);

    expect(await send(await start(store))).toStrictEqual({
      body: { goals: [{ goalId, planningRunRef }], outcome: "GOALS" },
      status: 200,
    });
  });

  it("preserves every ref spelling the production goal writer durably accepted", async () => {
    const { store } = openStore();
    const goalId = `goal-${"x".repeat(140)}`;
    const planningRunRef = "run-cafe\u0301";
    expect(goalId.length).toBeGreaterThan(128);
    expect(planningRunRef.normalize("NFC")).not.toBe(planningRunRef);
    createGoalThroughProduction(store, goalId, planningRunRef);

    expect(await send(await start(store))).toStrictEqual({
      body: { goals: [{ goalId, planningRunRef }], outcome: "GOALS" },
      status: 200,
    });
  });

  it("refuses the whole catalog when a stored GoalCreated record is corrupt", async () => {
    const { databasePath, store } = openStore();
    commitGoalRow(store, "goal-valid-before-corrupt", "run-valid-before-corrupt");
    const corruptEvent = commitGoalRow(store, "goal-corrupt", "run-corrupt");
    const database = new DatabaseSync(databasePath);
    try {
      database.prepare("UPDATE domain_events SET record_version = ? WHERE event_id = ?")
        .run("future-event-record/999", corruptEvent);
    } finally {
      database.close();
    }

    expect(await send(await start(store))).toStrictEqual({
      body: {
        code: "GOAL_CATALOG_READ_UNREADABLE", layer: "GOAL_CATALOG_READ", outcome: "REFUSED",
      },
      status: 200,
    });
  });

  it("refuses the whole catalog when a GoalCreated fact names a foreign project", async () => {
    const { store } = openStore();
    commitGoalRow(store, "goal-valid-before-foreign", "run-valid-before-foreign");
    commitGoalRow(store, "goal-foreign", "run-foreign", { projectId: FOREIGN_PROJECT });

    expect(await send(await start(store))).toStrictEqual({
      body: {
        code: "GOAL_CATALOG_READ_PROJECT_MISMATCH",
        layer: "GOAL_CATALOG_READ",
        outcome: "REFUSED",
      },
      status: 200,
    });
  });

  it("refuses the whole catalog when a GoalCreated payload is malformed", async () => {
    const { store } = openStore();
    commitGoalRow(store, "goal-valid-before-malformed", "run-valid-before-malformed");
    commitGoalRow(store, "goal-malformed", "run-malformed", {
      payload: ENCODER.encode(JSON.stringify([{
        goalId: "goal-malformed", kind: "GoalCreated", planningRunRef: "run-malformed",
      }])),
    });

    expect(await send(await start(store))).toStrictEqual({
      body: {
        code: "GOAL_CATALOG_READ_MALFORMED", layer: "GOAL_CATALOG_READ", outcome: "REFUSED",
      },
      status: 200,
    });
  });

  it("refuses instead of truncating when the durable catalog exceeds its row bound", async () => {
    const { store } = openStore();
    for (let index = 0; index < 257; index += 1) {
      const suffix = String(index).padStart(3, "0");
      commitGoalRow(store, `goal-bounded-${suffix}`, `run-bounded-${suffix}`);
    }

    expect(await send(await start(store))).toStrictEqual({
      body: {
        code: "GOAL_CATALOG_READ_LIMIT_EXCEEDED",
        layer: "GOAL_CATALOG_READ",
        outcome: "REFUSED",
      },
      status: 200,
    });
  });

  it.each(["{", "[]", "null", "{\"projectId\":\"attacker\"}"])(
    "accepts only the exact empty request, refusing %s",
    async (body) => {
      const { store } = openStore();
      expect(await send(await start(store), { body })).toStrictEqual({
        body: {
          code: "LISTENER_GOAL_CATALOG_REQUEST_INVALID", layer: "CONTROL_ROOM_LISTENER",
        },
        status: 400,
      });
    },
  );

  it("gates the read on the existing GOAL capability", async () => {
    const { store } = openStore();
    commitGoalRow(store, "goal-capability", "run-capability");
    expect(await send(await start(store), {
      body: "{", credential: NO_CAPABILITY_CREDENTIAL,
    })).toStrictEqual({
      body: {
        code: "GOAL_CATALOG_READ_CAPABILITY_DENIED",
        layer: "GOAL_CATALOG_READ",
        outcome: "REFUSED",
      },
      status: 200,
    });
  });

  it("refuses a GOAL principal bound to a foreign project before decoding", async () => {
    const { store } = openStore();
    expect(await send(await start(store), {
      body: "{", credential: FOREIGN_PROJECT_CREDENTIAL,
    })).toStrictEqual({
      body: {
        code: "GOAL_CATALOG_READ_PROJECT_MISMATCH",
        layer: "GOAL_CATALOG_READ",
        outcome: "REFUSED",
      },
      status: 200,
    });
  });

  it("refuses an absent catalog only after successful authentication", async () => {
    const { store } = openStore();
    const listener = await start(store, false);
    expect(await send(listener)).toStrictEqual({
      body: {
        code: "LISTENER_GOAL_CATALOG_UNAVAILABLE", layer: "CONTROL_ROOM_LISTENER",
      },
      status: 503,
    });
    const unauthenticated = await send(listener, { credential: null });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body).toMatchObject({ stage: "AUTHENTICATE" });
  });

  it("accepts the catalog route only as POST", async () => {
    const { store } = openStore();
    expect(await send(await start(store), { method: "GET" })).toStrictEqual({
      body: {
        code: "LISTENER_GOAL_CATALOG_REQUEST_INVALID", layer: "CONTROL_ROOM_LISTENER",
      },
      status: 400,
    });
  });
});
