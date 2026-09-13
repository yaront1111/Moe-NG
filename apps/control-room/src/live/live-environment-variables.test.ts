/**
 * THE VARIABLE-TABLE READ CLIENT, at the decoder seam.
 *
 * The frames below are the shape `handleEnvironmentsReadRequest` in
 * apps/daemon/src/http/environments-read.ts actually serves, measured off
 * apps/daemon/src/daemon-entry-ops.test.ts:219-236 against the COMPOSED production listener -
 * ok `{environment, ok, variables}`, the store's `{code, detail, layer, ok:false}` at 200, and
 * the listener's `{code, layer}` at 400/503. A daemon-side shape change reds this file rather
 * than reaching an operator as a blank table.
 *
 * EVERY REFUSAL ARM ASSERTS THE CODE AND THE LAYER THAT REFUSED, never merely that decoding
 * failed: three authorities can answer this route (store, listener, this client) and an arm that
 * checked only "not ok" would stay green while a different one of the three started answering.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EMPTY_NEXT_ALLOWED_COMMANDS, RUNTIME_ERROR_REGISTRY_VERSION, createRuntimeError, lookupRuntimeError,
} from "@moe/contracts";
import { describe, expect, it } from "vitest";

import { DEV_PROXY_PATHS } from "./dev-proxy-paths.js";
import {
  ENVIRONMENT_VARIABLE_ROW_KEYS, ENVIRONMENTS_READ_PATH, carriesValueShapedKey,
  mapEnvironmentVariablesAnswer, readEnvironmentVariables,
} from "./live-environment-variables.js";

const CLIENT_LAYER = "CONTROL_ROOM_ENVIRONMENT_VARIABLES";

/** A row exactly as `projectEnvironmentVariables` projects it. Four keys, no value. */
const row = (name: string, fingerprint: string): Record<string, unknown> => ({
  fingerprintSha256: fingerprint, isSet: true, name, updatedAt: "2026-09-07T09:00:00.000Z",
});

const FRAME = {
  environment: "preview", ok: true,
  variables: [row("DATABASE_URL", "a".repeat(64)), row("SESSION_KEY", "b".repeat(64))],
} as const;

/** The store's refusal envelope, verbatim from daemon-entry-ops.test.ts:224-231. */
const STORE_REFUSAL = {
  code: "ENV_ENVIRONMENT_UNKNOWN",
  detail: "the environment named is not one this project has",
  layer: "SCOPE", ok: false,
} as const;

const okResponse = (body: unknown, status = 200): Promise<Response> =>
  Promise.resolve({ json: () => Promise.resolve(body), status } as unknown as Response);

describe("the served frame decodes to rows the screen can render", () => {
  it("reads the environment and every four-key row", () => {
    const answer = mapEnvironmentVariablesAnswer(200, FRAME);
    expect(answer).toEqual({
      environment: "preview", status: "ENVIRONMENT_VARIABLES",
      variables: [
        { fingerprintSha256: "a".repeat(64), isSet: true, name: "DATABASE_URL", updatedAt: "2026-09-07T09:00:00.000Z" },
        { fingerprintSha256: "b".repeat(64), isSet: true, name: "SESSION_KEY", updatedAt: "2026-09-07T09:00:00.000Z" },
      ],
    });
  });

  it("reads an environment that holds nothing as an EMPTY table, not as a refusal", () => {
    // The distinction an operator depends on: nothing set is a fact, not a failure.
    expect(mapEnvironmentVariablesAnswer(200, { environment: "preview", ok: true, variables: [] }))
      .toEqual({ environment: "preview", status: "ENVIRONMENT_VARIABLES", variables: [] });
  });

  it("rosters exactly the four keys the daemon's ENVIRONMENT_VARIABLE_READ_KEYS carries", () => {
    expect([...ENVIRONMENT_VARIABLE_ROW_KEYS].sort())
      .toEqual(["fingerprintSha256", "isSet", "name", "updatedAt"]);
  });
});

describe("EXACT-KEY: an unknown key and a missing key each refuse at THIS client's layer", () => {
  it("refuses a frame carrying an UNKNOWN top-level key, with the code and the layer", () => {
    const answer = mapEnvironmentVariablesAnswer(200, { ...FRAME, projectId: "proj-0001" });
    expect(answer).toEqual({
      code: "ENVIRONMENT_VARIABLES_RESPONSE_INVALID", layer: CLIENT_LAYER, status: "ERROR",
    });
  });

  it("refuses a frame MISSING a top-level key, with the code and the layer", () => {
    const answer = mapEnvironmentVariablesAnswer(200, { environment: "preview", ok: true });
    expect(answer).toEqual({
      code: "ENVIRONMENT_VARIABLES_RESPONSE_INVALID", layer: CLIENT_LAYER, status: "ERROR",
    });
  });

  it("refuses a ROW carrying an unknown key, with the code and the layer", () => {
    const widened = { ...row("DATABASE_URL", "a".repeat(64)), source: "vault" };
    expect(mapEnvironmentVariablesAnswer(200, { environment: "preview", ok: true, variables: [widened] }))
      .toEqual({ code: "ENVIRONMENT_VARIABLES_RESPONSE_INVALID", layer: CLIENT_LAYER, status: "ERROR" });
  });

  it("refuses a ROW missing its fingerprint, with the code and the layer", () => {
    const { fingerprintSha256: _dropped, ...rest } = row("DATABASE_URL", "a".repeat(64));
    expect(mapEnvironmentVariablesAnswer(200, { environment: "preview", ok: true, variables: [rest] }))
      .toEqual({ code: "ENVIRONMENT_VARIABLES_RESPONSE_INVALID", layer: CLIENT_LAYER, status: "ERROR" });
  });

  it("refuses a non-200 that is not a recognised refusal envelope", () => {
    expect(mapEnvironmentVariablesAnswer(500, FRAME)).toEqual({
      code: "ENVIRONMENT_VARIABLES_RESPONSE_INVALID", layer: CLIENT_LAYER, status: "ERROR",
    });
  });
});

/**
 * THE CLIENT-SIDE HALF OF THE NO-VALUE PROPERTY (epic rail 3). The daemon drops every plaintext
 * before projecting, so these frames cannot occur today - which is exactly why the arm exists.
 * It is the guard for the day someone adds a helpful `value` slot to the route.
 */
describe("a frame carrying a VALUE is refused, at its own code, and never forwarded", () => {
  const SENTINEL = "zzz-not-a-real-secret-0123456789-sentinel";

  it("refuses a ROW that grew a value slot, naming the leak rather than the arity", () => {
    const leaking = { ...row("DATABASE_URL", "a".repeat(64)), value: SENTINEL };
    const answer = mapEnvironmentVariablesAnswer(
      200, { environment: "preview", ok: true, variables: [leaking] });
    // The code is the DISTINCT one: collapsing this into RESPONSE_INVALID would make the arm
    // satisfiable by any unrelated shape drift.
    expect(answer).toEqual({
      code: "ENVIRONMENT_VARIABLES_VALUE_PRESENT", layer: CLIENT_LAYER, status: "ERROR",
    });
    expect(JSON.stringify(answer)).not.toContain(SENTINEL);
  });

  it("refuses a REFUSAL envelope that grew a value slot", () => {
    // A refusal is forwarded whole, so a value slot on one would otherwise reach the screen.
    const answer = mapEnvironmentVariablesAnswer(200, { ...STORE_REFUSAL, value: SENTINEL });
    expect(answer).toEqual({
      code: "ENVIRONMENT_VARIABLES_VALUE_PRESENT", layer: CLIENT_LAYER, status: "ERROR",
    });
    expect(JSON.stringify(answer)).not.toContain(SENTINEL);
  });

  it("catches every value-shaped key, not only the one called value", () => {
    for (const key of ["cipher", "plaintext", "secret", "sealed", "value"]) {
      expect(carriesValueShapedKey({ variables: [{ [key]: SENTINEL }] }), key).toBe(true);
    }
    // CONTROL: the detector is not simply always true, so the arm above is not vacuous.
    expect(carriesValueShapedKey(FRAME)).toBe(false);
  });
});

describe("each refusing authority keeps its OWN code and layer", () => {
  it("keeps the STORE's code, layer and fixed detail", () => {
    expect(mapEnvironmentVariablesAnswer(200, STORE_REFUSAL)).toEqual({
      code: "ENV_ENVIRONMENT_UNKNOWN",
      detail: "the environment named is not one this project has",
      layer: "SCOPE", status: "REFUSED",
    });
  });

  it("keeps the LISTENER's code and layer, distinct from the store's", () => {
    expect(mapEnvironmentVariablesAnswer(
      400, { code: "LISTENER_ENVIRONMENTS_REQUEST_INVALID", layer: "CONTROL_ROOM_LISTENER" },
    )).toEqual({
      code: "LISTENER_ENVIRONMENTS_REQUEST_INVALID", detail: null,
      layer: "CONTROL_ROOM_LISTENER", status: "REFUSED",
    });
  });

  it("keeps the listener's UNAVAILABLE refusal at 503 rather than reading it as invalid", () => {
    expect(mapEnvironmentVariablesAnswer(
      503, { code: "LISTENER_ENVIRONMENTS_UNAVAILABLE", layer: "CONTROL_ROOM_LISTENER" },
    )).toMatchObject({ code: "LISTENER_ENVIRONMENTS_UNAVAILABLE", status: "REFUSED" });
  });
});

/**
 * THE THREE REFUSALS THE ROUTE ANSWERS BEFORE THE STORE IS ASKED, measured off
 * apps/daemon/src/http/environments-read.ts:103-115 and http-command-ingress.ts:73-81,89-111:
 * the route's own `{code, layer, outcome}` at 200 for a session without ADMIN, the
 * authenticator's PORT_REFUSED frame for a replayed session, and HttpRefused for an expired
 * credential or a wire-protocol mismatch. Each carries a stable code; decoding one as
 * RESPONSE_INVALID tells the operator the daemon answered garbage when it answered a reason.
 */
describe("the route's, the authenticator's and the ingress refusals keep their own codes", () => {
  const ROUTE_DENIAL = {
    code: "ENVIRONMENTS_READ_CAPABILITY_DENIED", layer: "CONTROL_ROOM_LISTENER", outcome: "REFUSED",
  } as const;
  /** The frozen RECOVERY_REPLAYED refusal (apps/daemon/src/identity/session-authenticator.ts:47-55), forwarded whole at 401. */
  const REPLAYED = {
    httpStatus: 401, ok: false, outcome: "PORT_REFUSED", stage: "AUTHENTICATE",
    refusal: {
      code: "SESSION_REPLAYED", detail: "The session belongs to a prior recovery incarnation or key epoch.",
      httpStatus: 401, layer: "IDENTITY",
    },
  } as const;

  it("keeps the route's CAPABILITY_DENIED at 200, with its layer and no detail", () => {
    expect(mapEnvironmentVariablesAnswer(200, ROUTE_DENIAL)).toEqual({
      code: "ENVIRONMENTS_READ_CAPABILITY_DENIED", detail: null,
      layer: "CONTROL_ROOM_LISTENER", status: "REFUSED",
    });
  });

  it("keeps the authenticator's SESSION_REPLAYED, its IDENTITY layer and its fixed detail", () => {
    expect(mapEnvironmentVariablesAnswer(401, REPLAYED)).toEqual({
      code: "SESSION_REPLAYED", detail: "The session belongs to a prior recovery incarnation or key epoch.",
      layer: "IDENTITY", status: "REFUSED",
    });
  });

  it("keeps AUTHENTICATION_FAILED for an expired credential, at the AUTHENTICATE stage", () => {
    const error = createRuntimeError({ code: "AUTHENTICATION_FAILED" });
    // CONTROL: the factory built the named code rather than failing closed to UNKNOWN_ERROR.
    expect(error.code).toBe("AUTHENTICATION_FAILED");
    expect(mapEnvironmentVariablesAnswer(
      401, { error, httpStatus: 401, ok: false, outcome: "REFUSED", stage: "AUTHENTICATE" },
    )).toEqual({ code: "AUTHENTICATION_FAILED", detail: null, layer: "AUTHENTICATE", status: "REFUSED" });
  });

  it("keeps DISTRIBUTION_MISMATCH for a wire-protocol mismatch, at the COMPATIBILITY stage", () => {
    // Built the way http-command-ingress.ts:60-71 builds it: a frozen literal off the registry
    // row, because the factory fails closed to UNKNOWN_ERROR for this code without a source.
    const row = lookupRuntimeError("DISTRIBUTION_MISMATCH");
    const error = Object.freeze({
      code: "DISTRIBUTION_MISMATCH", correlationId: null, details: {},
      nextAllowedCommands: EMPTY_NEXT_ALLOWED_COMMANDS, recoveryCategory: row.recoveryCategory,
      recoveryCommands: row.recoveryCommands, registryVersion: RUNTIME_ERROR_REGISTRY_VERSION,
      retryability: row.retryability, transport: row.transport, truthClass: "OBSERVED",
    });
    // CONTROL: the registry row is the named one, so the frame is the ingress's, not a stand-in.
    expect(row.code).toBe("DISTRIBUTION_MISMATCH");
    expect(row.transport.httpStatus).toBe(422);
    expect(mapEnvironmentVariablesAnswer(
      422, { error, httpStatus: 422, ok: false, outcome: "REFUSED", stage: "COMPATIBILITY" },
    )).toEqual({ code: "DISTRIBUTION_MISMATCH", detail: null, layer: "COMPATIBILITY", status: "REFUSED" });
  });

  it("still names a leak on a route refusal that grew a value slot", () => {
    expect(mapEnvironmentVariablesAnswer(200, { ...ROUTE_DENIAL, value: "zzz-sentinel" })).toEqual({
      code: "ENVIRONMENT_VARIABLES_VALUE_PRESENT", layer: CLIENT_LAYER, status: "ERROR",
    });
  });

  it("fails closed on a PORT_REFUSED frame whose refusal carries no text code", () => {
    const answer = mapEnvironmentVariablesAnswer(401, { ...REPLAYED, refusal: { code: 7 } });
    expect(answer).toEqual({
      code: "ENVIRONMENT_VARIABLES_RESPONSE_INVALID", layer: CLIENT_LAYER, status: "ERROR",
    });
  });
});

describe("the request, and the environment it is allowed to answer about", () => {
  it("POSTs exactly {environment} to the pinned path", async () => {
    let sentBody = "";
    await readEnvironmentVariables({}, "preview", (body) => {
      sentBody = body;
      return okResponse(FRAME);
    });
    expect(JSON.parse(sentBody)).toEqual({ environment: "preview" });
    expect(ENVIRONMENTS_READ_PATH).toBe("/environments/read");
  });

  it("refuses a frame that answers about a DIFFERENT environment", async () => {
    const answer = await readEnvironmentVariables({}, "production", () => okResponse(FRAME));
    expect(answer).toEqual({
      code: "ENVIRONMENT_VARIABLES_RESPONSE_INVALID", layer: CLIENT_LAYER, status: "ERROR",
    });
  });

  it("answers TRANSPORT_REQUEST_FAILED at this layer when the send throws", async () => {
    const answer = await readEnvironmentVariables({}, "preview", () => Promise.reject(new Error("down")));
    expect(answer).toEqual({ code: "TRANSPORT_REQUEST_FAILED", layer: CLIENT_LAYER, status: "ERROR" });
  });

  it("answers the invalid-response code when the body is not JSON", async () => {
    const answer = await readEnvironmentVariables({}, "preview", () => Promise.resolve({
      json: () => Promise.reject(new Error("not json")), status: 200,
    } as unknown as Response));
    expect(answer).toEqual({
      code: "ENVIRONMENT_VARIABLES_RESPONSE_INVALID", layer: CLIENT_LAYER, status: "ERROR",
    });
  });
});

describe("the dev lane can reach the route, and this client retains nothing", () => {
  it("pins /environments/read in DEV_PROXY_PATHS", () => {
    // Without the pin the dev server answers the route itself and the screen renders against
    // Vite instead of against a daemon.
    expect(DEV_PROXY_PATHS).toContain("/environments/read");
  });

  it("has no browser-local retention anywhere in its source", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "live-environment-variables.ts"), "utf8");
    // CONTROL: the file really was read, so the three absences below are not an empty string.
    expect(source).toContain("mapEnvironmentVariablesAnswer");
    expect(source).not.toContain("localStorage");
    expect(source).not.toContain("sessionStorage");
    expect(source).not.toContain("indexedDB");
  });
});
