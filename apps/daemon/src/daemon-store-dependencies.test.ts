import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  STORE_DEPENDENCIES_ENV_MISSING,
  createStoreDependencies,
  readStoreDependencyEnv,
} from "./daemon-store-dependencies.js";
import { handleCommandRequest } from "./http/http-adapter.js";
import { WIRE_PROTOCOL_VERSION } from "./http/http-contract.js";
import { bytes, envelopeObject } from "./http/http-test-fixtures.js";

const CREDENTIAL = "test-operator-credential";
const PROJECT = "proj-store-deps";
const CLOCK = (): string => "2026-08-09T12:00:00.000Z";

const directory = mkdtempSync(join(tmpdir(), "moe-store-deps-"));
const storePath = join(directory, "store.db");

const provider = createStoreDependencies({
  clock: CLOCK,
  credential: CREDENTIAL,
  principalId: "operator-local",
  projectId: PROJECT,
  storePath,
});
const deps = provider.provide();

afterAll(() => {
  provider.close();
  rmSync(directory, { force: true, recursive: true });
});

function dispatch(envelope: Record<string, unknown>, credential: string = CREDENTIAL) {
  return handleCommandRequest(deps, {
    body: bytes(envelope),
    credential,
    protocolVersion: WIRE_PROTOCOL_VERSION,
  });
}

function registerEnvelope(): Record<string, unknown> {
  return {
    ...envelopeObject({
      commandId: "cmd-register-1",
      commandKind: "project.register",
      payload: { owner: "operator-local" },
    }),
    expectedVersion: 0,
  };
}

describe("readStoreDependencyEnv", () => {
  it("refuses with the stable code naming every missing variable", () => {
    expect(() => readStoreDependencyEnv({})).toThrowError(
      `${STORE_DEPENDENCIES_ENV_MISSING}: MOE_STORE_PATH, MOE_PROJECT_ID, MOE_DAEMON_CREDENTIAL`,
    );
  });
});

describe("createStoreDependencies", () => {
  it("refuses an unknown credential at the AUTHENTICATE stage", () => {
    const result = dispatch(registerEnvelope(), "wrong-credential");
    expect(result).toMatchObject({
      error: { code: "AUTHENTICATION_FAILED" },
      httpStatus: 401,
      ok: false,
      outcome: "REFUSED",
      stage: "AUTHENTICATE",
    });
  });

  it("commits project.register durably through the committed bootstrap service", () => {
    const result = dispatch(registerEnvelope());
    expect(result).toMatchObject({
      decision: {
        commandId: "cmd-register-1",
        disposition: "DECIDED",
        resultCode: "EFFECTS_COMMITTED",
      },
      httpStatus: 200,
      ok: true,
      outcome: "ACCEPTED",
    });
  });

  it("replays the identical command instead of re-running its effect", () => {
    const result = dispatch(registerEnvelope());
    expect(result).toMatchObject({
      decision: { disposition: "REPLAYED", resultCode: "EFFECTS_COMMITTED" },
      ok: true,
      outcome: "ACCEPTED",
    });
  });

  it("surfaces a prerequisite refusal as a port refusal naming the refusing layer", () => {
    const result = dispatch({
      ...envelopeObject({
        commandId: "cmd-goal-early",
        commandKind: "goal.create",
        payload: {
          budgetAccountRef: "budget-1", goalId: "goal-1",
          planningRunRef: "run-1", witness: {},
        },
      }),
      expectedVersion: 0,
    });
    expect(result).toMatchObject({
      httpStatus: 422,
      ok: false,
      outcome: "PORT_REFUSED",
      refusal: { code: "BOOTSTRAP_PREREQUISITE_MISSING", layer: "DAEMON_PREREQUISITE" },
      stage: "DISPATCH",
    });
  });

  it("serves the committed subscription port, which refuses without a generation", () => {
    const port = provider.subscriptions?.();
    expect(port).toBeDefined();
    const page = port?.readPage({ projection: "moe.board", subscriberId: "control-room-1" });
    expect(page).toMatchObject({
      code: "SUBSCRIPTION_GENERATION_MISSING",
      layer: "STATE",
      outcome: "REFUSED",
    });
  });

  it("replays across a fresh store handle, proving the decision is durable", () => {
    const reopened = createStoreDependencies({
      clock: CLOCK,
      credential: CREDENTIAL,
      principalId: "operator-local",
      projectId: PROJECT,
      storePath,
    });
    try {
      const result = handleCommandRequest(reopened.provide(), {
        body: bytes(registerEnvelope()),
        credential: CREDENTIAL,
        protocolVersion: WIRE_PROTOCOL_VERSION,
      });
      expect(result).toMatchObject({
        decision: { disposition: "REPLAYED", resultCode: "EFFECTS_COMMITTED" },
        ok: true,
        outcome: "ACCEPTED",
      });
    } finally {
      reopened.close();
    }
  });
});
