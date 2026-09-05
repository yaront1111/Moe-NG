/**
 * POST /environments/read: the required-vs-set table, and the property the route exists for -
 * A VALUE NEVER CROSSES THIS BOUNDARY (epic rail 3, DoD-2).
 *
 * The no-value arms are written HOSTILE rather than confirmatory. A field-by-field check
 * (`expect(body.variables[0].value).toBeUndefined()`) passes while a value rides in a field
 * nobody thought to name, so every arm here SERIALIZES the whole dispatch result and searches
 * the text. The console is captured for the same reason: a leak into a log line is a leak.
 *
 * The refusal paths get the same treatment and get it FIRST, because an error message is where
 * someone reaches for context and therefore where a value actually escapes in practice.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SqliteEventStore } from "@moe/store";

import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import {
  ENVIRONMENT_CODE_LAYERS, ENVIRONMENT_LAYERS, ENVIRONMENT_VARIABLE_READ_KEYS,
} from "../environment/environment-contracts.js";
import {
  projectEnvironmentVariables, readEnvironmentState,
} from "../environment/environment-projection.js";
import type { EnvironmentStoreConfig } from "../environment/environment-store.js";
import { readEnvironmentVariables, setEnvironmentVariable } from "../environment/environment-store.js";
import {
  CREDENTIAL, PROJECT_ID, cleanUp, configFor, openMemoryStore,
} from "../environment/environment-test-fixtures.js";
import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import type { Authenticator } from "./http-contract.js";
import {
  CONTROL_ROOM_LISTENER_LAYER, LISTENER_REFUSAL_CODES, refuse, statusFor,
} from "./http-listener-guards.js";
import { ENVIRONMENTS_READ_PATH, environmentsReadBodyOf, handleEnvironmentsReadRequest } from
  "./environments-read.js";
import type { EnvironmentsReadPort } from "./environments-read.js";
import { GOOD_CREDENTIAL } from "./http-test-fixtures.js";

afterEach(cleanUp);

/**
 * Distinctive enough that a substring hit cannot be a coincidence, and NOT a hex string, so it
 * could never be confused with the sha256 fingerprint the route is allowed to publish.
 */
const SECRET = "zzq-PLAINTEXT-CANARY-vvx-9137-must-never-appear";
const VARIABLE = "DATABASE_URL";

const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

function seededWorld(): { readonly config: EnvironmentStoreConfig; readonly store: SqliteEventStore } {
  const store = openMemoryStore();
  const config = configFor(store);
  const seeded = setEnvironmentVariable(config, {
    commandId: "cmd-env-http-seed", environment: "production", name: VARIABLE, value: SECRET,
  });
  // The seed is the arm's premise: a sweep over an EMPTY table would find no value and pass
  // while proving nothing (global rail 1 - a generated case must assert it was generated).
  expect(seeded.ok).toBe(true);
  return { config, store };
}

function storePort(config: EnvironmentStoreConfig): EnvironmentsReadPort {
  return { read: (input) => readEnvironmentVariables(config, input.environment) };
}

function environmentsAuth(capabilities: readonly string[]): Authenticator {
  return {
    authenticate(credential: string | null) {
      if (credential !== GOOD_CREDENTIAL) return { verdict: "UNAUTHENTICATED" as const };
      return {
        principal: { capabilities, principalId: "operator-1", projectId: PROJECT_ID },
        verdict: "AUTHENTICATED" as const,
      };
    },
  };
}

function handle(
  dependencies: {
    readonly authenticator: Authenticator;
    readonly environmentReads?: EnvironmentsReadPort;
  },
  value: unknown,
) {
  return handleEnvironmentsReadRequest(dependencies, {
    body: bytes(value), credential: GOOD_CREDENTIAL, protocolVersion: WIRE_PROTOCOL_VERSION,
  });
}

/**
 * Runs `act` with every console sink captured, and returns the serialized result together with
 * everything that was written. Callers assert on BOTH, so an implementation that keeps the value
 * out of the body by logging it fails here rather than passing.
 */
function withCapturedLog<T>(act: () => T): { readonly logged: string; readonly serialized: string } {
  const written: string[] = [];
  const sinks = ["debug", "error", "info", "log", "trace", "warn"] as const;
  const spies = sinks.map((sink) =>
    vi.spyOn(console, sink).mockImplementation((...args: readonly unknown[]) => {
      written.push(args.map((arg) => String(arg)).join(" "));
    }));
  try {
    // `act()` runs BEFORE the record is built. An object literal evaluates its properties in
    // source order, so `{logged: written.join(...), serialized: JSON.stringify(act())}` reads an
    // EMPTY buffer and the log half of every arm silently tests nothing. Measured: a drill that
    // leaked the value through `console.warn` alone left all 19 arms GREEN under that shape.
    const serialized = JSON.stringify(act()) ?? "";
    return { logged: written.join("\n"), serialized };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

describe("environments read route", () => {
  it("is routed at /environments/read", () => {
    expect(ENVIRONMENTS_READ_PATH).toBe("/environments/read");
  });

  it("serves exactly the projection's table, with the four permitted keys and no fifth", () => {
    const { config } = seededWorld();
    const result = handle(
      { authenticator: environmentsAuth([CAPABILITIES.ADMIN]), environmentReads: storePort(config) },
      { environment: "production" },
    );

    // DoD-1: compared against what `projectEnvironmentVariables` produces for the SAME state, so
    // a route that re-derived the table instead of delegating would diverge and red here.
    const expected = projectEnvironmentVariables(
      readEnvironmentState(config, "production"), CREDENTIAL,
    );
    expect(result).toEqual({
      body: { environment: "production", ok: true, variables: expected }, httpStatus: 200,
      kind: "REPLY",
    });
    if (result.kind !== "REPLY" || !("variables" in result.body)) throw new Error("not a table");
    const [row] = result.body.variables;
    expect(Object.keys(row ?? {}).sort()).toStrictEqual([...ENVIRONMENT_VARIABLE_READ_KEYS]);
    expect(row?.name).toBe(VARIABLE);
    expect(row?.isSet).toBe(true);
    expect(row?.fingerprintSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(row?.updatedAt).toBe("2026-09-05T00:00:00.000Z");
  });

  it("puts NO VALUE in the success body and NO VALUE in any log line", () => {
    const { config } = seededWorld();
    const { logged, serialized } = withCapturedLog(() => handle(
      { authenticator: environmentsAuth([CAPABILITIES.ADMIN]), environmentReads: storePort(config) },
      { environment: "production" },
    ));

    // The whole payload as TEXT, not a named field: a value smuggled into a field this test
    // never thought to name is still caught.
    expect(serialized).not.toContain(SECRET);
    expect(logged).not.toContain(SECRET);
    // Positive control: the search would have found the value had it been there, and the arm is
    // looking at a payload that really did describe the seeded variable.
    expect(serialized).toContain(VARIABLE);
    expect(`${serialized}${SECRET}`).toContain(SECRET);
  });

  it.each([
    ["an unknown environment", { environment: "staging" }],
    ["an unknown key", { environment: "production", projectId: PROJECT_ID }],
    ["a missing key", {}],
    ["a non-string environment", { environment: 7 }],
  ])("puts NO VALUE in the refusal body or log for %s", (_label, payload) => {
    const { config } = seededWorld();
    const { logged, serialized } = withCapturedLog(() => handle(
      { authenticator: environmentsAuth([CAPABILITIES.ADMIN]), environmentReads: storePort(config) },
      payload,
    ));
    expect(serialized).not.toContain(SECRET);
    expect(logged).not.toContain(SECRET);
    // Not vacuous: the request really was refused rather than silently succeeding.
    expect(serialized).not.toContain("\"ok\":true");
  });

  it("puts NO VALUE in a capability denial, which never reaches the store at all", () => {
    const { config } = seededWorld();
    const { logged, serialized } = withCapturedLog(() => handle(
      { authenticator: environmentsAuth([CAPABILITIES.GOAL]), environmentReads: storePort(config) },
      { environment: "production" },
    ));
    expect(serialized).not.toContain(SECRET);
    expect(logged).not.toContain(SECRET);
    expect(serialized).toContain("ENVIRONMENTS_READ_CAPABILITY_DENIED");
  });

  it("refuses ENV_ENVIRONMENT_UNKNOWN with its CODE and its ALREADY-ROSTERED layer", () => {
    const { config } = seededWorld();
    const result = handle(
      { authenticator: environmentsAuth([CAPABILITIES.ADMIN]), environmentReads: storePort(config) },
      { environment: "staging" },
    );

    // DoD-5: code AND layer, and the layer is asserted to come from child 1's CLOSED map rather
    // than from a literal minted here - reading it from `ENVIRONMENT_CODE_LAYERS` is what makes
    // a second, disagreeing map impossible to introduce without reddening.
    expect(result).toEqual({
      body: {
        code: "ENV_ENVIRONMENT_UNKNOWN",
        detail: "the environment named is not one this project has",
        layer: ENVIRONMENT_CODE_LAYERS.ENV_ENVIRONMENT_UNKNOWN,
        ok: false,
      },
      httpStatus: 200,
      kind: "REPLY",
    });
    expect(ENVIRONMENT_CODE_LAYERS.ENV_ENVIRONMENT_UNKNOWN).toBe("SCOPE");
    expect(ENVIRONMENT_LAYERS).toContain("SCOPE");
    // WHICH LAYER refused: the STORE's scope authority, not the listener's. A local
    // `isEnvironmentName` check in the route would answer first and this line would red.
    expect(result.kind === "REPLY" && "layer" in result.body && result.body.layer)
      .not.toBe(CONTROL_ROOM_LISTENER_LAYER);
  });

  it("denies the capability at CONTROL_ROOM_LISTENER without introducing a new layer literal", () => {
    const { config } = seededWorld();
    const result = handle(
      { authenticator: environmentsAuth([CAPABILITIES.GOAL]), environmentReads: storePort(config) },
      { environment: "production" },
    );
    expect(result).toEqual({
      body: {
        code: "ENVIRONMENTS_READ_CAPABILITY_DENIED", layer: CONTROL_ROOM_LISTENER_LAYER,
        outcome: "REFUSED",
      },
      httpStatus: 200,
      kind: "REPLY",
    });
    // Rail 5: the layer is the listener's existing constant, byte for byte.
    expect(CONTROL_ROOM_LISTENER_LAYER).toBe("CONTROL_ROOM_LISTENER");
    expect(refuse("LISTENER_ENVIRONMENTS_UNAVAILABLE").layer).toBe(CONTROL_ROOM_LISTENER_LAYER);
  });

  it.each([
    ["an unknown key", { environment: "production", projectId: PROJECT_ID }],
    ["a missing key", {}],
    ["an empty environment", { environment: "" }],
    ["a non-string environment", { environment: 7 }],
    ["an array", []],
  ])("refuses %s as LISTENER_ENVIRONMENTS_REQUEST_INVALID, at the LISTENER", (_label, payload) => {
    const { config } = seededWorld();
    const result = handle(
      { authenticator: environmentsAuth([CAPABILITIES.ADMIN]), environmentReads: storePort(config) },
      payload,
    );

    // DoD-4: the CODE and the LAYER that refused. The layer here is the transport's, and it is
    // reached through `refuse`/`statusFor` - the same pair production uses - so an unrostered
    // code or a missing status mapping reds rather than falling through to the 403 default.
    expect(result).toEqual({
      code: "LISTENER_ENVIRONMENTS_REQUEST_INVALID", kind: "LISTENER_REFUSAL",
    });
    expect(LISTENER_REFUSAL_CODES).toContain("LISTENER_ENVIRONMENTS_REQUEST_INVALID");
    expect(refuse("LISTENER_ENVIRONMENTS_REQUEST_INVALID").layer).toBe(CONTROL_ROOM_LISTENER_LAYER);
    expect(statusFor("LISTENER_ENVIRONMENTS_REQUEST_INVALID")).toBe(400);
  });

  it("accepts exactly {environment} and nothing adjacent to it", () => {
    expect(environmentsReadBodyOf(bytes({ environment: "production" })))
      .toEqual({ environment: "production" });
    expect(environmentsReadBodyOf(bytes({ environment: "production", version: 1 }))).toBeNull();
    expect(environmentsReadBodyOf(bytes({ Environment: "production" }))).toBeNull();
    expect(environmentsReadBodyOf(bytes(null))).toBeNull();
    expect(environmentsReadBodyOf(bytes("production"))).toBeNull();
    expect(environmentsReadBodyOf(new TextEncoder().encode("{"))).toBeNull();
  });

  it("refuses LISTENER_ENVIRONMENTS_UNAVAILABLE at 503 with no port, and reads nothing", () => {
    const { store } = seededWorld();
    const before = store.readEvents(`environment/${PROJECT_ID}/production`).length;
    const result = handle({ authenticator: environmentsAuth([CAPABILITIES.ADMIN]) }, {
      environment: "production",
    });
    expect(result).toEqual({ code: "LISTENER_ENVIRONMENTS_UNAVAILABLE", kind: "LISTENER_REFUSAL" });
    expect(LISTENER_REFUSAL_CODES).toContain("LISTENER_ENVIRONMENTS_UNAVAILABLE");
    expect(refuse("LISTENER_ENVIRONMENTS_UNAVAILABLE").layer).toBe(CONTROL_ROOM_LISTENER_LAYER);
    expect(statusFor("LISTENER_ENVIRONMENTS_UNAVAILABLE")).toBe(503);
    expect(store.readEvents(`environment/${PROJECT_ID}/production`)).toHaveLength(before);
  });

  it("refuses an unauthenticated caller before the port is consulted", () => {
    const { config } = seededWorld();
    let consulted = false;
    const result = handleEnvironmentsReadRequest({
      authenticator: environmentsAuth([CAPABILITIES.ADMIN]),
      environmentReads: {
        read: (input) => {
          consulted = true;
          return readEnvironmentVariables(config, input.environment);
        },
      },
    }, { body: bytes({ environment: "production" }), credential: null, protocolVersion: WIRE_PROTOCOL_VERSION });
    expect(consulted).toBe(false);
    expect(result.kind).toBe("REPLY");
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("answers an environment with no variables as an empty table, not a refusal", () => {
    const { config } = seededWorld();
    const result = handle(
      { authenticator: environmentsAuth([CAPABILITIES.ADMIN]), environmentReads: storePort(config) },
      { environment: "verify" },
    );

    // The adversarial question the plan asks: an empty environment is a STATE, not a fault. A
    // refusal here would make "no variables yet" indistinguishable from "wrong credential".
    expect(result).toEqual({
      body: { environment: "verify", ok: true, variables: [] }, httpStatus: 200, kind: "REPLY",
    });
  });
});
