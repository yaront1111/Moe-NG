import { createHmac, randomUUID } from "node:crypto";
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
import { documentSourceAggregateId } from "../documents/document-source-identifiers.js";
import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import type { AuthenticationResult, CommandAdapterDeps } from "./http-contract.js";
import { encodeGoalCatalogCursor } from "./goal-catalog-cursor.js";
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
/**
 * A FIXED secret injected into the port, so this suite can mint cursors the daemon will accept
 * and then bend exactly one property of them. With the per-port random default no forged cursor
 * could ever reach the project or horizon checks: every one would die at the signature.
 */
const CURSOR_SECRET = Buffer.from("goal-catalog-cursor-secret-for-tests-only-32b");

function signedCursorPayload(payload: string): string {
  const encodedPayload = Buffer.from(payload).toString("base64url");
  const mac = createHmac("sha256", CURSOR_SECRET)
    .update(encodedPayload, "utf8").digest("base64url");
  return `${encodedPayload}.${mac}`;
}

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

/**
 * A planted GoalCreated row shaped exactly as the production writer shapes one: the reducer's
 * own fact plus the brief the daemon normalized. The brief is stamped here by hand rather than
 * taken from a production helper on purpose — this is the reader roster's hand-pinned
 * counterpart, and a planted row derived from the writer would follow a roster edit silently.
 */
interface PlantedFactOptions {
  /** Adds the source-bound writer's frozen tenth key when present. */
  readonly binding?: unknown;
  /** Replaces the stamped brief. `undefined` keeps the writer-shaped default. */
  readonly brief?: unknown;
  /** Selects the durable decision trace independently from the fact roster. */
  readonly commandKind?: string;
  /** Extra keys merged onto the fact, for the foreign-ninth-key hybrids. */
  readonly extraKeys?: Readonly<Record<string, unknown>>;
  /** Omits `brief` entirely — the LEGACY eight-key shape written before task-9d86234a. */
  readonly legacy?: boolean;
  readonly projectId?: string;
}

function goalPayload(
  goalId: string, planningRunRef: string, options: PlantedFactOptions = {},
): Uint8Array {
  const reduced = reduceGoal(undefined, {
    budgetAccountRef: `budget-${goalId}`,
    commandId: `create-${goalId}`,
    expectedVersion: 0,
    goalId,
    kind: "goal.create",
    planningRunRef,
    projectId: options.projectId ?? PROJECT,
    witness: { projectReadyRef: `ready-${goalId}`, truthClass: "DAEMON_VERIFIED" },
  });
  if (!reduced.ok) throw new Error(`goal reducer refused ${goalId}`);
  const brief = options.brief === undefined
    ? { instructions: `Planted brief for ${goalId}.`, title: `Planted ${goalId}` }
    : options.brief;
  return ENCODER.encode(JSON.stringify(reduced.events.map((event) => ({
    ...event,
    ...(options.legacy === true ? {} : { brief }),
    ...(options.binding === undefined ? {} : { binding: options.binding }),
    ...(options.extraKeys ?? {}),
  }))));
}

/** The brief a planted non-legacy row carries, so an arm can assert the exact read-back. */
function plantedBrief(goalId: string): { instructions: string; title: string } {
  return { instructions: `Planted brief for ${goalId}.`, title: `Planted ${goalId}` };
}

const SOURCE_SHA256 = "ab".repeat(32);
const SOURCE_REF = "source:task-daf-frozen-binding";

function sourceBinding(
  overrides: Readonly<Record<string, unknown>> = {},
  projectId = PROJECT,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    byteLength: 37,
    contentSha256: SOURCE_SHA256,
    sourceAggregateId: documentSourceAggregateId(projectId, SOURCE_SHA256, SOURCE_REF),
    sourceRef: SOURCE_REF,
    ...overrides,
  });
}

function withoutKey(
  value: Readonly<Record<string, unknown>>, key: string,
): Readonly<Record<string, unknown>> {
  return Object.freeze(Object.fromEntries(Object.entries(value).filter(([name]) => name !== key)));
}

function commitGoalRow(
  store: SqliteEventStore,
  goalId: string,
  planningRunRef: string,
  options: PlantedFactOptions & { readonly payload?: Uint8Array } = {},
): string {
  const commandId = `create-${goalId}`;
  const eventId = `${commandId}-GoalCreated`;
  const payload = options.payload ?? goalPayload(goalId, planningRunRef, options);
  store.commitExpectedVersionDecision({
    commandKind: options.commandKind ?? "goal.create",
    committedResultBytes: ENCODER.encode("{}"),
    correlationId: `correlation-${goalId}`,
    decidedAt: "2026-08-24T00:00:00.000Z",
    events: [{ eventId, eventType: "GoalCreated", payload }],
    expectedVersion: 0,
    key: { commandId, principalId: "operator-local", projectId: PROJECT },
    requestBytes: ENCODER.encode(JSON.stringify({
      kind: options.commandKind ?? "goal.create",
    })),
    targetAggregateId: goalId,
  });
  return eventId;
}

/**
 * Creates a goal through the REAL writer and returns the identities the writer minted. The
 * caller chooses only the command subject: production derives `goal-${subject}` and its
 * `run-${subject}` from the authenticated command identity, and no payload can name either.
 */
function createGoalThroughProduction(
  store: SqliteEventStore, subject: string,
  submitted?: { readonly instructions: string; readonly title: string },
): { readonly goalId: string; readonly planningRunRef: string } {
  driveThrough(store, "goal.create");
  const result = sendBootstrap(store, envelope("goal.create", 0, submitted ?? {
    instructions: `Durable brief for ${subject}.`,
    title: `Goal ${subject}`,
  }, subject));
  if (!result.ok) throw new Error(`production goal.create refused: ${result.code}`);
  return { goalId: `goal-${subject}`, planningRunRef: `run-${subject}` };
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
  store: SqliteEventStore, withCatalog = true, cursorSecret = CURSOR_SECRET,
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
      ? { goalCatalog: createGoalCatalogReadPort({ cursorSecret, projectId: PROJECT, store }) }
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
    const subject = randomUUID();
    const { goalId, planningRunRef } = createGoalThroughProduction(store, subject);
    expect([goalId, planningRunRef]).not.toContain("goal-live-1");
    expect([goalId, planningRunRef]).not.toContain("run-live-1");

    expect(await send(await start(store))).toStrictEqual({
      body: {
        goals: [{
          binding: null,
          brief: {
            instructions: `Durable brief for ${subject}.`, title: `Goal ${subject}`,
          },
          goalId,
          planningRunRef,
        }],
        nextCursor: null,
        outcome: "GOALS",
      },
      status: 200,
    });
  });

  it("preserves every ref spelling the production goal writer durably accepted", async () => {
    const { store } = openStore();
    // ONE subject now carries both properties, because the writer mints both refs from it.
    const subject = `cafe\u0301${"x".repeat(140)}`;
    const { goalId, planningRunRef } = createGoalThroughProduction(store, subject);
    expect(goalId.length).toBeGreaterThan(128);
    expect(planningRunRef.normalize("NFC")).not.toBe(planningRunRef);

    expect(await send(await start(store))).toStrictEqual({
      body: {
        goals: [{
          binding: null,
          brief: {
            instructions: `Durable brief for ${subject}.`, title: `Goal ${subject}`,
          },
          goalId,
          planningRunRef,
        }],
        nextCursor: null,
        outcome: "GOALS",
      },
      status: 200,
    });
  });

  /**
   * THE WRITER'S OWN OUTPUT MUST BE READABLE (task-9d86234a). The positive control is the first
   * assertion: the durable fact really does carry brief bytes, so the read-back below is a
   * statement about the frozen roster and not about an ordinary 8-key row. Narrow
   * GOAL_CREATED_KEYS back to eight and this arm reds with GOAL_CATALOG_READ_MALFORMED.
   */
  it("reads back a brief-bearing GoalCreated instead of refusing it", async () => {
    const { store } = openStore();
    // Submitted with surrounding whitespace and a CRLF, so the read-back below can only match
    // if it carries the NORMALIZED brief the contract produced, not the caller's raw prose.
    const submittedTitle = "  Ship the café slice  ";
    const submittedInstructions = "First line.\r\nSecond line.  ";
    const normalized = {
      instructions: "First line.\nSecond line.", title: "Ship the café slice",
    };
    const { goalId, planningRunRef } = createGoalThroughProduction(store, "brief-readback", {
      instructions: submittedInstructions, title: submittedTitle,
    });
    const fact = JSON.parse(
      new TextDecoder().decode(store.readEvents(goalId)[0]?.payload),
    ) as readonly Record<string, unknown>[];
    expect(fact[0]?.["brief"]).toEqual(normalized);
    expect(normalized.title).not.toBe(submittedTitle);
    expect(normalized.instructions).not.toBe(submittedInstructions);

    expect(await send(await start(store))).toStrictEqual({
      body: {
        goals: [{ binding: null, brief: normalized, goalId, planningRunRef }],
        nextCursor: null,
        outcome: "GOALS",
      },
      status: 200,
    });
  });

  /**
   * LEGACY, task rail 3. An eight-key GoalCreated written before the brief was stamped is
   * explicitly brief-UNKNOWN. It must read back rather than refuse the whole catalog, and the
   * reader must never invent prose for it: `brief` is null, not a synthesized title.
   */
  it("reads a legacy GoalCreated back as explicitly brief-unknown, never invented", async () => {
    const { store } = openStore();
    commitGoalRow(store, "goal-legacy", "run-legacy", { legacy: true });

    expect(await send(await start(store))).toStrictEqual({
      body: {
        goals: [
          { binding: null, brief: null, goalId: "goal-legacy", planningRunRef: "run-legacy" },
        ],
        nextCursor: null,
        outcome: "GOALS",
      },
      status: 200,
    });
  });

  it("reads a mixed catalog, each row carrying only its own brief", async () => {
    const { store } = openStore();
    commitGoalRow(store, "goal-mixed-legacy", "run-mixed-legacy", { legacy: true });
    commitGoalRow(store, "goal-mixed-brief", "run-mixed-brief");

    expect(await send(await start(store))).toStrictEqual({
      body: {
        goals: [
          {
            binding: null,
            brief: null,
            goalId: "goal-mixed-legacy",
            planningRunRef: "run-mixed-legacy",
          },
          {
            binding: null,
            brief: plantedBrief("goal-mixed-brief"),
            goalId: "goal-mixed-brief",
            planningRunRef: "run-mixed-brief",
          },
        ],
        nextCursor: null,
        outcome: "GOALS",
      },
      status: 200,
    });
  });

  /**
   * FLIPPED DELIBERATELY by task-221fa0c3 (parent task-e87cfddf). This arm used to be titled
   * "...without projecting the source binding" and PINNED the discard: /goals/read validated the
   * binding's exact four keys and then returned none of it. The binding is now returned BY
   * DESIGN, because task-965cb2d6's resume condition requires a PRODUCTION reader that exposes
   * BOTH brief and binding, and nothing but this response can discharge it.
   *
   * AN EXACT-SHAPE ASSERTION THAT CHANGES WHEN THE SHAPE DELIBERATELY CHANGES IS THE ASSERTION
   * DOING ITS JOB. Reading its movement as a weakening has wrongly blocked rows on this board
   * twice; the governor's ruling names exactly that. So the old assertion is REPLACED, not left
   * alive beside a new one, and the exactness is WIDENED rather than abandoned: the roster below
   * is still hand-pinned and still four keys long, so a stray fifth key on any row still reds.
   */
  it("reads all three exact writer shapes, projecting the source binding by design", async () => {
    const { store } = openStore();
    const committedBinding = sourceBinding();
    commitGoalRow(store, "goal-three-legacy", "run-three-legacy", { legacy: true });
    commitGoalRow(store, "goal-three-brief", "run-three-brief");
    commitGoalRow(store, "goal-three-source", "run-three-source", {
      binding: committedBinding, commandKind: "goal.create_with_source",
    });

    const answer = await send(await start(store));
    expect(answer).toStrictEqual({
      body: {
        goals: [
          {
            binding: null,
            brief: null,
            goalId: "goal-three-legacy",
            planningRunRef: "run-three-legacy",
          },
          {
            binding: null,
            brief: plantedBrief("goal-three-brief"),
            goalId: "goal-three-brief",
            planningRunRef: "run-three-brief",
          },
          {
            binding: committedBinding,
            brief: plantedBrief("goal-three-source"),
            goalId: "goal-three-source",
            planningRunRef: "run-three-source",
          },
        ],
        nextCursor: null,
        outcome: "GOALS",
      },
      status: 200,
    });
    const goals = answer.body["goals"] as readonly Readonly<Record<string, unknown>>[];
    expect(goals).toHaveLength(3);
    for (const goal of goals) {
      expect(Object.keys(goal).sort())
        .toEqual(["binding", "brief", "goalId", "planningRunRef"]);
    }
  });

  /**
   * DoD 2, SIDE BY SIDE. One goal.create row, one legacy goal.create row and one
   * goal.create_with_source row live in the SAME store and are read back through the
   * PRODUCTION /goals/read listener - never a helper. The with-source row must carry the
   * EXACT binding the writer committed, asserted against `committedBinding` itself rather
   * than re-spelled literals: a hand-typed expectation is a fixed point that would survive
   * the projection handing back some other row's binding.
   *
   * The `binding: null` half is not a footnote, it is half the deliverable. It is what
   * proves the field is read FROM the row's own writer shape rather than defaulted on, and
   * it is what reds if the projection ignores `sourceBound` and stamps every row alike.
   */
  it("projects a bound source binding beside the null of an ordinary and a legacy row", async () => {
    const { store } = openStore();
    const committedBinding = sourceBinding();
    commitGoalRow(store, "goal-side-legacy", "run-side-legacy", { legacy: true });
    commitGoalRow(store, "goal-side-ordinary", "run-side-ordinary");
    commitGoalRow(store, "goal-side-source", "run-side-source", {
      binding: committedBinding, commandKind: "goal.create_with_source",
    });

    expect(await send(await start(store))).toStrictEqual({
      body: {
        goals: [
          {
            binding: null,
            brief: null,
            goalId: "goal-side-legacy",
            planningRunRef: "run-side-legacy",
          },
          {
            binding: null,
            brief: plantedBrief("goal-side-ordinary"),
            goalId: "goal-side-ordinary",
            planningRunRef: "run-side-ordinary",
          },
          {
            binding: committedBinding,
            brief: plantedBrief("goal-side-source"),
            goalId: "goal-side-source",
            planningRunRef: "run-side-source",
          },
        ],
        nextCursor: null,
        outcome: "GOALS",
      },
      status: 200,
    });
  });

  const SOURCE_BOUND_HOSTILE_FACTS: readonly {
    readonly name: string;
    readonly plant: PlantedFactOptions;
  }[] = Object.freeze([
    { name: "source payload under the ordinary trace kind", plant: {
      binding: sourceBinding(), commandKind: "goal.create",
    } },
    { name: "source trace kind without binding", plant: {
      commandKind: "goal.create_with_source",
    } },
    { name: "source trace kind without brief", plant: {
      binding: sourceBinding(), commandKind: "goal.create_with_source", legacy: true,
    } },
    { name: "source row with an eleventh outer key", plant: {
      binding: sourceBinding(), commandKind: "goal.create_with_source",
      extraKeys: { authority: "caller-forged" },
    } },
    ...(["byteLength", "contentSha256", "sourceAggregateId", "sourceRef"] as const)
      .map((key) => ({
        name: `binding missing ${key}`,
        plant: {
          binding: withoutKey(sourceBinding(), key), commandKind: "goal.create_with_source",
        },
      })),
    { name: "binding with a fifth key", plant: {
      binding: sourceBinding({ displayPath: "PRD.md" }),
      commandKind: "goal.create_with_source",
    } },
    { name: "binding with an unsafe byte length", plant: {
      binding: sourceBinding({ byteLength: Number.MAX_SAFE_INTEGER + 1 }),
      commandKind: "goal.create_with_source",
    } },
    { name: "binding with a negative byte length", plant: {
      binding: sourceBinding({ byteLength: -1 }), commandKind: "goal.create_with_source",
    } },
    { name: "binding with a fractional byte length", plant: {
      binding: sourceBinding({ byteLength: 1.5 }), commandKind: "goal.create_with_source",
    } },
    { name: "binding with a non-hex digest", plant: {
      binding: sourceBinding({ contentSha256: "G".repeat(64) }),
      commandKind: "goal.create_with_source",
    } },
    { name: "binding with an empty source ref", plant: {
      binding: sourceBinding({ sourceRef: "" }), commandKind: "goal.create_with_source",
    } },
    { name: "binding with an empty source aggregate id", plant: {
      binding: sourceBinding({ sourceAggregateId: "" }), commandKind: "goal.create_with_source",
    } },
    { name: "binding with an inconsistent source aggregate id", plant: {
      binding: sourceBinding({ sourceAggregateId: "document-source/not-derived" }),
      commandKind: "goal.create_with_source",
    } },
    { name: "source row with a null binding", plant: {
      binding: null, commandKind: "goal.create_with_source",
    } },
    { name: "source payload under a third trace kind", plant: {
      binding: sourceBinding(), commandKind: "goal.close",
    } },
  ]);

  it("names every frozen source-bound hostile case", () => {
    expect(SOURCE_BOUND_HOSTILE_FACTS).toHaveLength(18);
  });

  it.each(SOURCE_BOUND_HOSTILE_FACTS)(
    "refuses the whole catalog for $name",
    async ({ name, plant }) => {
      const { store } = openStore();
      commitGoalRow(store, "goal-valid-before-source-hostile", "run-valid-before-source-hostile");
      commitGoalRow(store, `goal-source-hostile-${name.length}`, `run-source-hostile-${name.length}`, plant);

      expect(await send(await start(store))).toStrictEqual({
        body: {
          code: "GOAL_CATALOG_READ_MALFORMED",
          layer: "GOAL_CATALOG_READ",
          outcome: "REFUSED",
        },
        status: 200,
      });
    },
  );

  /**
   * HYBRIDS. Neither the legacy eight-key shape nor the writer's exact nine-key shape. Each of
   * these could only reach the store by a route the writer does not have, so the reader refuses
   * the catalog with its own code AND layer rather than reading a half-known brief.
   */
  const HYBRID_FACTS: readonly {
    readonly name: string; readonly plant: PlantedFactOptions;
  }[] = Object.freeze([
    { name: "a brief carrying an extra key", plant: {
      brief: { instructions: "Do it.", title: "Ship it", urgency: "high" },
    } },
    { name: "a brief missing instructions", plant: { brief: { title: "Ship it" } } },
    { name: "a non-string brief title", plant: {
      brief: { instructions: "Do it.", title: 7 },
    } },
    { name: "an empty brief title", plant: { brief: { instructions: "Do it.", title: "" } } },
    { name: "a brief that is not the contract's fixed point", plant: {
      brief: { instructions: "Do it.", title: " Ship it" },
    } },
    { name: "a null brief in the stored fact", plant: { brief: null } },
    { name: "a legacy row plus a foreign ninth key", plant: {
      extraKeys: { witnessed: true }, legacy: true,
    } },
  ]);

  it("names a nonzero hybrid roster", () => {
    expect(HYBRID_FACTS.length).toBeGreaterThan(0);
  });

  it.each(HYBRID_FACTS)("refuses the whole catalog for $name", async ({ name, plant }) => {
    const { store } = openStore();
    commitGoalRow(store, "goal-valid-before-hybrid", "run-valid-before-hybrid");
    commitGoalRow(store, `goal-hybrid-${name.length}`, `run-hybrid-${name.length}`, plant);

    expect(await send(await start(store))).toStrictEqual({
      body: {
        code: "GOAL_CATALOG_READ_MALFORMED", layer: "GOAL_CATALOG_READ", outcome: "REFUSED",
      },
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

  it("classifies a source-bound fact naming a foreign project at the project fence", async () => {
    const { store } = openStore();
    commitGoalRow(store, "goal-valid-before-foreign-source", "run-valid-before-foreign-source");
    commitGoalRow(store, "goal-foreign-source", "run-foreign-source", {
      binding: sourceBinding({}, FOREIGN_PROJECT),
      commandKind: "goal.create_with_source",
      projectId: FOREIGN_PROJECT,
    });

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

  /** Seeds `count` durable goals in commit order and returns their ids in that same order. */
  function seedGoals(store: SqliteEventStore, count: number, prefix: string): readonly string[] {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const suffix = String(index).padStart(4, "0");
      const goalId = `goal-${prefix}-${suffix}`;
      commitGoalRow(store, goalId, `run-${prefix}-${suffix}`);
      ids.push(goalId);
    }
    return ids;
  }

  interface CatalogPage {
    readonly goalIds: readonly string[];
    readonly nextCursor: string | null;
  }

  async function readPage(listener: ControlRoomListener, cursor?: string): Promise<CatalogPage> {
    const answer = await send(listener, {
      body: cursor === undefined ? "{}" : JSON.stringify({ cursor }),
    });
    if (answer.status !== 200 || answer.body["outcome"] !== "GOALS") {
      throw new Error(`expected a page, got ${JSON.stringify(answer)}`);
    }
    const goals = answer.body["goals"] as readonly { readonly goalId: string }[];
    return {
      goalIds: goals.map((goal) => goal.goalId),
      nextCursor: answer.body["nextCursor"] as string | null,
    };
  }

  /** Drains every page, bounded, and returns the ids in the order the daemon emitted them. */
  async function drain(
    listener: ControlRoomListener,
  ): Promise<{ readonly goalIds: readonly string[]; readonly pages: number }> {
    const goalIds: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page: CatalogPage = await readPage(listener, cursor);
      goalIds.push(...page.goalIds);
      cursor = page.nextCursor ?? undefined;
      pages += 1;
      if (pages > 16) throw new Error("the drain did not terminate");
    } while (cursor !== undefined);
    return { goalIds, pages };
  }

  it("enumerates a catalog past the row bound instead of refusing it", async () => {
    const { store } = openStore();
    const seeded = seedGoals(store, 257, "bounded");
    const listener = await start(store);

    const first = await readPage(listener);
    expect(first.goalIds).toHaveLength(256);
    expect(typeof first.nextCursor).toBe("string");

    const second = await readPage(listener, first.nextCursor as string);
    expect(second).toStrictEqual({ goalIds: [seeded[256]], nextCursor: null });
    expect([...first.goalIds, ...second.goalIds]).toStrictEqual(seeded);
  });

  it("answers exactly the row bound in one page and issues no cursor", async () => {
    const { store } = openStore();
    const seeded = seedGoals(store, 256, "exact");

    expect(await readPage(await start(store)))
      .toStrictEqual({ goalIds: seeded, nextCursor: null });
  });

  it("enumerates six hundred goals across three pages, each once, in store order", async () => {
    const { store } = openStore();
    const seeded = seedGoals(store, 600, "many");

    const drained = await drain(await start(store));
    expect(drained.pages).toBe(3);
    expect(drained.goalIds).toStrictEqual(seeded);
    expect(new Set(drained.goalIds).size).toBe(600);
  });

  /**
   * The horizon is PINNED at page one. A goal appended between pages must not appear in the
   * pinned enumeration — otherwise a concurrent writer could shift positions under the cursor
   * and make a row appear twice or vanish. A fresh read afterwards sees everything.
   */
  it("keeps a pinned enumeration free of goals appended between pages", async () => {
    const { store } = openStore();
    const seeded = seedGoals(store, 300, "pinned");
    const listener = await start(store);

    const first = await readPage(listener);
    expect(first.goalIds).toHaveLength(256);
    const appended = seedGoals(store, 3, "appended");

    const second = await readPage(listener, first.nextCursor as string);
    expect(second.goalIds).toStrictEqual(seeded.slice(256));
    expect(second.goalIds).toHaveLength(44);
    expect(second.nextCursor).toBeNull();
    for (const id of appended) expect(second.goalIds).not.toContain(id);

    const fresh = await drain(listener);
    expect(fresh.goalIds).toStrictEqual([...seeded, ...appended]);
    expect(fresh.goalIds).toHaveLength(303);
  });

  /**
   * Every case but OVERSIZED is forged with the port's OWN secret, so the signature verifies and
   * the named check is the only mechanism left that can refuse it. OVERSIZED is refused before
   * any decoding happens and therefore needs no valid signature at all.
   */
  const CURSOR_REFUSAL_CASES = Object.freeze([
    Object.freeze({
      code: "GOAL_CATALOG_CURSOR_MALFORMED",
      cursor: (horizon: bigint): string => {
        const valid = encodeGoalCatalogCursor(CURSOR_SECRET, {
          after: 1n, horizon, projectId: PROJECT,
        });
        const separator = valid.lastIndexOf(".");
        const signature = valid.slice(separator + 1);
        const last = signature.slice(-1);
        return `${valid.slice(0, separator + 1)}${signature.slice(0, -1)}${
          last === "A" ? "B" : "A"
        }`;
      },
      name: "a cursor whose signature was tampered by one byte",
    }),
    Object.freeze({
      code: "GOAL_CATALOG_CURSOR_PROJECT_MISMATCH",
      cursor: (horizon: bigint): string => encodeGoalCatalogCursor(CURSOR_SECRET, {
        after: 1n, horizon, projectId: FOREIGN_PROJECT,
      }),
      name: "a correctly signed cursor issued for another project",
    }),
    Object.freeze({
      code: "GOAL_CATALOG_CURSOR_STALE",
      cursor: (horizon: bigint): string => encodeGoalCatalogCursor(CURSOR_SECRET, {
        after: 1n, horizon: horizon + 1_000n, projectId: PROJECT,
      }),
      name: "a correctly signed cursor pinned ahead of the store's horizon",
    }),
    Object.freeze({
      code: "GOAL_CATALOG_CURSOR_OVERSIZED",
      cursor: (): string => "a".repeat(513),
      name: "a cursor past the size bound",
    }),
  ] as const);

  it("names exactly four cursor refusal cases", () => {
    expect(CURSOR_REFUSAL_CASES).toHaveLength(4);
  });

  it.each(CURSOR_REFUSAL_CASES)("refuses $name with its own code", async ({ code, cursor }) => {
    const { store } = openStore();
    seedGoals(store, 2, "refusal");
    const listener = await start(store);

    expect(await send(listener, {
      body: JSON.stringify({ cursor: cursor(store.readEventHorizon()) }),
    })).toStrictEqual({
      body: { code, layer: "GOAL_CATALOG_READ", outcome: "REFUSED" },
      status: 200,
    });
  });

  const SIGNED_CLAIM_REFUSAL_CASES = Object.freeze([
    Object.freeze({
      cursor: (): string => signedCursorPayload("nope"),
      name: "a correctly signed payload that is not JSON",
    }),
    Object.freeze({
      cursor: (horizon: bigint): string => signedCursorPayload(JSON.stringify({
        after: "0",
        horizon: horizon.toString(),
        projectId: PROJECT,
        schema: "goal-catalog-cursor/0",
      })),
      name: "a correctly signed cursor with the wrong schema",
    }),
  ] as const);

  it("names both signed claims-decoder listener refusal cases", () => {
    expect(SIGNED_CLAIM_REFUSAL_CASES).toHaveLength(2);
  });

  it.each(SIGNED_CLAIM_REFUSAL_CASES)(
    "refuses $name with the cursor code and reader layer",
    async ({ cursor }) => {
      const { store } = openStore();
      expect(await send(await start(store), {
        body: JSON.stringify({ cursor: cursor(store.readEventHorizon()) }),
      })).toStrictEqual({
        body: {
          code: "GOAL_CATALOG_CURSOR_MALFORMED",
          layer: "GOAL_CATALOG_READ",
          outcome: "REFUSED",
        },
        status: 200,
      });
    },
  );

  it.each([
    ["a non-string cursor", JSON.stringify({ cursor: 1 })],
    ["a cursor beside an unknown key", JSON.stringify({ cursor: "x", extra: 1 })],
  ])("refuses %s at the listener, before the catalog reads", async (_label, body) => {
    const { store } = openStore();
    expect(await send(await start(store), { body })).toStrictEqual({
      body: {
        code: "LISTENER_GOAL_CATALOG_REQUEST_INVALID", layer: "CONTROL_ROOM_LISTENER",
      },
      status: 400,
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
