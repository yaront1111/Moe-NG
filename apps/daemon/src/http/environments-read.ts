/**
 * THE REQUIRED-VS-SET VARIABLE TABLE, over HTTP: POST `/environments/read` answers, for ONE
 * environment, the `{name, isSet, fingerprintSha256, updatedAt}` rows `readEnvironmentVariables`
 * already projects. projectId comes from the authenticated principal; a payload that names it is
 * an unknown key.
 *
 * A VALUE NEVER CROSSES THIS BOUNDARY. The store's read side already opens every seal, derives
 * the fingerprint from the authenticated plaintext and drops it, so no value reaches this module
 * to leak in the first place. What this module must not do is put one BACK: hence the answer is
 * forwarded VERBATIM from the port rather than reshaped, refusals are the store's own frozen
 * prose (never interpolated), and nothing here logs, traces or stringifies a request. The one
 * refusal this module mints carries a code and a rostered layer and nothing else.
 *
 * WHY THE ROUTE DOES NOT NAME A VARIABLE. There is no per-variable selector: the operator asks
 * for an environment and gets its whole table. A name-shaped selector would turn the route into
 * an existence oracle over arbitrary strings, and the table is what the Environments screen
 * renders anyway.
 *
 * NO NEW LAYER LITERAL (epic/task rail 5). `ENV_*` refusals arrive from the store already
 * paired with their layer by `environment-contracts.ts`'s closed `ENVIRONMENT_CODE_LAYERS`, and
 * the capability denial reuses `CONTROL_ROOM_LISTENER_LAYER`, which is what every
 * `refuseRequest` on this listener already writes.
 */
import { decodeBoundedJsonBytes } from "@moe/contracts";

import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import type { EnvironmentReadResult } from "../environment/environment-store.js";
import { authenticateHttpRequest } from "./http-command-ingress.js";
import type { Authenticator, HttpPortRefused, HttpRefused } from "./http-contract.js";
import { CONTROL_ROOM_LISTENER_LAYER } from "./http-listener-guards.js";

export const ENVIRONMENTS_READ_PATH = "/environments/read" as const;

export const ENVIRONMENTS_READ_CODES = Object.freeze([
  "ENVIRONMENTS_READ_CAPABILITY_DENIED",
] as const);

export interface EnvironmentsReadRefused {
  readonly code: (typeof ENVIRONMENTS_READ_CODES)[number];
  readonly layer: typeof CONTROL_ROOM_LISTENER_LAYER;
  readonly outcome: "REFUSED";
}

/**
 * The read this route serves. Closed over a store CONFIG by tests and by the composition
 * sibling; this module does not open one and holds no credential. `environment` stays a raw
 * string on the way in so the STORE decides whether it is a known environment — a check here
 * would be a second scope authority and would answer before `ENV_ENVIRONMENT_UNKNOWN` could.
 */
export interface EnvironmentsReadPort {
  read(input: { readonly environment: string }): EnvironmentReadResult;
}

const refused = (
  code: (typeof ENVIRONMENTS_READ_CODES)[number],
): EnvironmentsReadRefused => Object.freeze({
  code, layer: CONTROL_ROOM_LISTENER_LAYER, outcome: "REFUSED" as const,
});

/**
 * Own enumerable keys are EXACTLY `{environment}` — arity one, that name, a non-empty string.
 * A missing key and an unknown key both land here, and both refuse. Exact arity rather than a
 * "pick the keys I know" read, because the latter accepts `{environment, projectId}` and lets a
 * caller believe it named a project it does not hold.
 */
export function environmentsReadBodyOf(
  body: unknown,
): { readonly environment: string } | null {
  const decoded = decodeBoundedJsonBytes(body);
  if (!decoded.ok) return null;
  const value: unknown = decoded.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "environment") return null;
  const environment = record["environment"];
  if (typeof environment !== "string" || environment.length === 0) return null;
  return { environment };
}

export type EnvironmentsReadDispatch =
  | {
    readonly body: EnvironmentReadResult | EnvironmentsReadRefused | HttpPortRefused | HttpRefused;
    readonly httpStatus: number;
    readonly kind: "REPLY";
  }
  | {
    readonly code: "LISTENER_ENVIRONMENTS_REQUEST_INVALID" | "LISTENER_ENVIRONMENTS_UNAVAILABLE";
    readonly kind: "LISTENER_REFUSAL";
  };

export function handleEnvironmentsReadRequest(
  dependencies: {
    readonly authenticator: Authenticator;
    readonly environmentReads?: EnvironmentsReadPort | undefined;
  },
  request: {
    readonly body: unknown;
    readonly credential: string | null;
    readonly protocolVersion: unknown;
  },
): EnvironmentsReadDispatch {
  const access = authenticateHttpRequest(
    dependencies.authenticator, request.credential, request.protocolVersion,
  );
  if (!access.ok) {
    return Object.freeze({ body: access, httpStatus: access.httpStatus, kind: "REPLY" });
  }
  // ADMIN, not GOAL: an environment's variable table is a deployment secret's metadata, and the
  // capability that installs policy is the one that may see which secrets a project requires.
  if (!access.principal.capabilities.includes(CAPABILITIES.ADMIN)) {
    return Object.freeze({
      body: refused("ENVIRONMENTS_READ_CAPABILITY_DENIED"), httpStatus: 200, kind: "REPLY",
    });
  }
  const port = dependencies.environmentReads;
  if (port === undefined) {
    return Object.freeze({ code: "LISTENER_ENVIRONMENTS_UNAVAILABLE", kind: "LISTENER_REFUSAL" });
  }
  const decoded = environmentsReadBodyOf(request.body);
  if (decoded === null) {
    return Object.freeze({
      code: "LISTENER_ENVIRONMENTS_REQUEST_INVALID", kind: "LISTENER_REFUSAL",
    });
  }
  // Forwarded VERBATIM. Reshaping is where a field nobody named would come from.
  return Object.freeze({
    body: port.read({ environment: decoded.environment }), httpStatus: 200, kind: "REPLY",
  });
}
