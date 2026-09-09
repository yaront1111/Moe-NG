/**
 * POST /design/read: listener refusals vs store answers. Listener codes are
 * CONTROL_ROOM_LISTENER; store answers travel 200 with DesignRefusal.code+layer.
 */
import { afterEach, describe, expect, it } from "vitest";

import type { ProductContractRevisionRef } from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import { GOAL_ID, PROJECT_ID, closeStores } from "../bootstrap/bootstrap-test-fixtures.js";
import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import { designAggregateId, designRefusal } from "../design/design-contracts.js";
import { readDesignRevision, submitDesignRevision } from "../design/design-store.js";
import { designRevisionFixture, secondDesignRevisionFixture }
  from "../design/design-test-fixtures.js";
import {
  approveGate1, boundWorld, committedRevision,
} from "../planning/plan-reject-test-fixtures.js";
import {
  CONTROL_ROOM_LISTENER_LAYER, LISTENER_REFUSAL_CODES, refuse, statusFor,
} from "./http-listener-guards.js";
import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import type { Authenticator } from "./http-contract.js";
import { DESIGN_READ_PATH, designReadBodyOf, handleDesignReadRequest } from "./design-read.js";
import type { DesignReadPort } from "./design-read.js";
import { GOOD_CREDENTIAL } from "./http-test-fixtures.js";

afterEach(closeStores);

const DECIDED_AT = "2026-09-05T09:00:00.000Z";
const body = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

interface World {
  readonly ref: ProductContractRevisionRef;
  readonly store: SqliteEventStore;
}

function approvedWorld(): World {
  const store = boundWorld();
  const ref = committedRevision(store);
  approveGate1(store, ref);
  return { ref, store };
}

function submit(world: World, expectedVersion: number, revision: unknown, seed: string) {
  return submitDesignRevision(world.store, {
    commandId: `cmd-design-http-${seed}`,
    contractRef: world.ref,
    correlationId: `corr-design-http-${seed}`,
    decidedAt: DECIDED_AT,
    expectedVersion,
    goalRef: GOAL_ID,
    principalId: "designer-agent-1",
    projectId: PROJECT_ID,
    revision,
  });
}

function storePort(store: SqliteEventStore): DesignReadPort {
  return { read: (input) => readDesignRevision(store, input) };
}

function designAuth(capabilities: readonly string[]): Authenticator {
  return {
    authenticate(credential: string | null) {
      if (credential !== GOOD_CREDENTIAL) return { verdict: "UNAUTHENTICATED" as const };
      return {
        principal: { capabilities, principalId: "designer-agent-1", projectId: PROJECT_ID },
        verdict: "AUTHENTICATED" as const,
      };
    },
  };
}

function request(value: unknown) {
  return { body: body(value), credential: GOOD_CREDENTIAL, protocolVersion: WIRE_PROTOCOL_VERSION };
}

function handle(
  dependencies: { readonly authenticator: Authenticator; readonly designReads?: DesignReadPort },
  value: unknown,
) {
  return handleDesignReadRequest(dependencies, request(value));
}

describe("design read route", () => {
  it("preserves the compiled run selector and refuses ambiguous version selectors", () => {
    expect(designReadBodyOf(body({ goalRef: GOAL_ID, planningRunRef: "run-compiled" })))
      .toEqual({ goalRef: GOAL_ID, planningRunRef: "run-compiled" });
    for (const selector of [{ goalRef: GOAL_ID, planningRunRef: "" },
      { goalRef: GOAL_ID, planningRunRef: "run-compiled", version: 1 },
      { goalRef: GOAL_ID, planningRunRef: "run-compiled", projectId: "other" },
    ]) expect(designReadBodyOf(body(selector))).toBeNull();
  });
  it("is routed at /design/read", () => {
    expect(DESIGN_READ_PATH).toBe("/design/read");
  });

  it("refuses LISTENER_DESIGN_UNAVAILABLE at CONTROL_ROOM_LISTENER with no port and writes nothing", () => {
    const store = approvedWorld().store;
    const before = store.readEvents(designAggregateId(GOAL_ID)).length;
    const result = handle({ authenticator: designAuth([CAPABILITIES.GOAL]) }, { goalRef: GOAL_ID });
    expect(result).toEqual({ code: "LISTENER_DESIGN_UNAVAILABLE", kind: "LISTENER_REFUSAL" });
    expect(LISTENER_REFUSAL_CODES).toContain("LISTENER_DESIGN_UNAVAILABLE");
    expect(refuse("LISTENER_DESIGN_UNAVAILABLE").layer).toBe(CONTROL_ROOM_LISTENER_LAYER);
    expect(statusFor("LISTENER_DESIGN_UNAVAILABLE")).toBe(503);
    expect(store.readEvents(designAggregateId(GOAL_ID))).toHaveLength(before);
  });

  it("refuses DESIGN_READ_CAPABILITY_DENIED at DESIGN_READ for a non-GOAL principal", () => {
    const calls: unknown[] = [];
    const designReads: DesignReadPort = {
      read: (input) => {
        calls.push(input);
        return designRefusal("DESIGN_REVISION_ABSENT");
      },
    };
    expect(handle(
      { authenticator: designAuth([CAPABILITIES.WORK]), designReads },
      { goalRef: GOAL_ID },
    )).toEqual({
      body: { code: "DESIGN_READ_CAPABILITY_DENIED", layer: "DESIGN_READ", outcome: "REFUSED" },
      httpStatus: 200,
      kind: "REPLY",
    });
    expect(calls).toEqual([]);
  });

  it("refuses LISTENER_DESIGN_REQUEST_INVALID at CONTROL_ROOM_LISTENER for extra, missing, non-string, or payload projectId", () => {
    const calls: unknown[] = [];
    const designReads: DesignReadPort = {
      read: (input) => {
        calls.push(input);
        return designRefusal("DESIGN_REVISION_ABSENT");
      },
    };
    const deps = { authenticator: designAuth([CAPABILITIES.GOAL]), designReads };
    const invalid = [
      {},
      { goalRef: "" },
      { goalRef: 1 },
      { goalRef: GOAL_ID, extra: 1 },
      { goalRef: GOAL_ID, projectId: PROJECT_ID },
      { version: 1 },
      { goalRef: GOAL_ID, version: Number.NaN },
    ];
    for (const value of invalid) {
      expect(handle(deps, value), JSON.stringify(value))
        .toEqual({ code: "LISTENER_DESIGN_REQUEST_INVALID", kind: "LISTENER_REFUSAL" });
    }
    expect(LISTENER_REFUSAL_CODES).toContain("LISTENER_DESIGN_REQUEST_INVALID");
    expect(refuse("LISTENER_DESIGN_REQUEST_INVALID").layer).toBe(CONTROL_ROOM_LISTENER_LAYER);
    expect(statusFor("LISTENER_DESIGN_REQUEST_INVALID")).toBe(400);
    expect(calls).toEqual([]);
  });

  it("forwards DESIGN_REVISION_ABSENT at LEDGER on 200 and writes nothing", () => {
    const world = approvedWorld();
    const before = world.store.readEvents(designAggregateId(GOAL_ID)).length;
    const served = handle(
      { authenticator: designAuth([CAPABILITIES.GOAL]), designReads: storePort(world.store) },
      { goalRef: GOAL_ID },
    );
    expect(served).toEqual({
      body: designRefusal("DESIGN_REVISION_ABSENT"),
      httpStatus: 200,
      kind: "REPLY",
    });
    if (served.kind !== "REPLY") throw new Error("expected store answer");
    expect(served.body).toMatchObject({ code: "DESIGN_REVISION_ABSENT", layer: "LEDGER" });
    expect(world.store.readEvents(designAggregateId(GOAL_ID))).toHaveLength(before);
  });

  it("returns the stored record plus versions, and version 1 survives version 2", () => {
    const world = approvedWorld();
    const deps = {
      authenticator: designAuth([CAPABILITIES.GOAL]),
      designReads: storePort(world.store),
    };
    expect(submit(world, 0, designRevisionFixture(), "v1").ok).toBe(true);
    const first = handle(deps, { goalRef: GOAL_ID, version: 1 });
    expect(first.kind).toBe("REPLY");
    if (first.kind !== "REPLY") throw new Error("expected store answer");
    expect(first.httpStatus).toBe(200);
    expect(first.body).toMatchObject({
      ok: true, record: { version: 1, revision: designRevisionFixture() }, versions: [1],
    });

    expect(submit(world, 1, secondDesignRevisionFixture(), "v2").ok).toBe(true);
    const latest = handle(deps, { goalRef: GOAL_ID });
    if (latest.kind !== "REPLY") throw new Error("expected latest");
    expect(latest.body).toMatchObject({
      ok: true, record: { version: 2, revision: secondDesignRevisionFixture() }, versions: [1, 2],
    });

    const pinned = handle(deps, { goalRef: GOAL_ID, version: 1 });
    if (pinned.kind !== "REPLY") throw new Error("expected version 1");
    expect(pinned.body).toMatchObject({
      ok: true, record: { version: 1, revision: designRevisionFixture() }, versions: [1, 2],
    });
  });
});
