/**
 * THE VERSIONED DESIGN AGGREGATE, over HTTP: POST `/design/read` answers the
 * record `readDesignRevision` already stores. projectId comes from the
 * authenticated principal; a payload that names it is an unknown key.
 */
import { decodeBoundedJsonBytes } from "@moe/contracts";

import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import type { DesignReadInput, DesignReadResult } from "../design/design-store.js";
import { authenticateHttpRequest } from "./http-command-ingress.js";
import type { Authenticator, HttpPortRefused, HttpRefused } from "./http-contract.js";

export const DESIGN_READ_PATH = "/design/read" as const;
const LAYER = "DESIGN_READ" as const;

export const DESIGN_READ_CODES = Object.freeze(["DESIGN_READ_CAPABILITY_DENIED"] as const);

export interface DesignReadRefused {
  readonly code: string;
  readonly layer: string;
  readonly outcome: "REFUSED";
}

/** Closed over a store by tests and by the composition sibling; this module does not open one. */
export interface DesignReadPort {
  read(input: DesignReadInput): DesignReadResult;
}

const refused = (code: string, layer: string = LAYER): DesignReadRefused =>
  Object.freeze({ code, layer, outcome: "REFUSED" as const });

/**
 * Own enumerable keys are exactly `{goalRef}` or `{goalRef, version}`. version,
 * when present, is a finite safe integer so a 1.5 cannot masquerade as ABSENT.
 */
export function designReadBodyOf(
  body: unknown,
): { readonly goalRef: string; readonly version?: number } | null {
  const decoded = decodeBoundedJsonBytes(body);
  if (!decoded.ok) return null;
  const value: unknown = decoded.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const allowed = keys.length === 1
    ? keys[0] === "goalRef"
    : keys.length === 2 && keys.includes("goalRef") && keys.includes("version");
  if (!allowed) return null;
  const goalRef = record["goalRef"];
  if (typeof goalRef !== "string" || goalRef.length === 0) return null;
  if (!Object.hasOwn(record, "version")) return { goalRef };
  const version = record["version"];
  if (typeof version !== "number" || !Number.isFinite(version) || !Number.isSafeInteger(version)) {
    return null;
  }
  return { goalRef, version };
}

export type DesignReadDispatch =
  | {
    readonly body: DesignReadResult | DesignReadRefused | HttpPortRefused | HttpRefused;
    readonly httpStatus: number;
    readonly kind: "REPLY";
  }
  | {
    readonly code: "LISTENER_DESIGN_REQUEST_INVALID" | "LISTENER_DESIGN_UNAVAILABLE";
    readonly kind: "LISTENER_REFUSAL";
  };

export function handleDesignReadRequest(
  dependencies: {
    readonly authenticator: Authenticator;
    readonly designReads?: DesignReadPort | undefined;
  },
  request: {
    readonly body: unknown;
    readonly credential: string | null;
    readonly protocolVersion: unknown;
  },
): DesignReadDispatch {
  const access = authenticateHttpRequest(
    dependencies.authenticator, request.credential, request.protocolVersion,
  );
  if (!access.ok) return Object.freeze({ body: access, httpStatus: access.httpStatus, kind: "REPLY" });
  if (!access.principal.capabilities.includes(CAPABILITIES.GOAL)) {
    return Object.freeze({
      body: refused("DESIGN_READ_CAPABILITY_DENIED"), httpStatus: 200, kind: "REPLY",
    });
  }
  const port = dependencies.designReads;
  if (port === undefined) {
    return Object.freeze({ code: "LISTENER_DESIGN_UNAVAILABLE", kind: "LISTENER_REFUSAL" });
  }
  const decoded = designReadBodyOf(request.body);
  if (decoded === null) {
    return Object.freeze({ code: "LISTENER_DESIGN_REQUEST_INVALID", kind: "LISTENER_REFUSAL" });
  }
  const input: DesignReadInput = decoded.version === undefined
    ? { goalRef: decoded.goalRef, projectId: access.principal.projectId }
    : { goalRef: decoded.goalRef, projectId: access.principal.projectId, version: decoded.version };
  return Object.freeze({ body: port.read(input), httpStatus: 200, kind: "REPLY" });
}
