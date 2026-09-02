/**
 * The HTTP face of the runs read: POST /runs/read with a body that is EXACTLY `{}` (every
 * bound goal) or EXACTLY `{ goalRef }` (one goal). The listener refuses any other body
 * before the port is asked, the capability gate is the goal capability, and the port's
 * project binding is compared to the principal's.
 */
import { decodeBoundedJsonBytes } from "@moe/contracts";

import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import { authenticateHttpRequest } from "./http-command-ingress.js";
import type { Authenticator, HttpPortRefused, HttpRefused } from "./http-contract.js";
import { runsRefused as refused } from "./runs-read-contract.js";
import type { RunsReadPort, RunsReadResult, RunsSelector } from "./runs-read-contract.js";

export type RunsListenerCode =
  | "LISTENER_RUNS_REQUEST_INVALID"
  | "LISTENER_RUNS_UNAVAILABLE";

export type RunsReadDispatch =
  | {
    readonly body: RunsReadResult | HttpPortRefused | HttpRefused;
    readonly httpStatus: number;
    readonly kind: "REPLY";
  }
  | { readonly code: RunsListenerCode; readonly kind: "LISTENER_REFUSAL" };

/** `{}` or `{ goalRef: string }`, nothing else; an empty body counts as `{}`. */
export function runsSelectorOf(body: unknown): RunsSelector | null {
  if (body instanceof Uint8Array && body.length === 0) return Object.freeze({});
  const decoded = decodeBoundedJsonBytes(body);
  if (!decoded.ok) return null;
  const value: unknown = decoded.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record);
  if (keys.length === 0) return Object.freeze({});
  if (keys.length !== 1 || keys[0] !== "goalRef") return null;
  const goalRef = record["goalRef"];
  return typeof goalRef === "string" && goalRef.length > 0 ? Object.freeze({ goalRef }) : null;
}

export function handleRunsReadRequest(
  dependencies: { readonly authenticator: Authenticator; readonly runs?: RunsReadPort | undefined },
  request: { readonly body: unknown; readonly credential: string | null; readonly protocolVersion: unknown },
): RunsReadDispatch {
  const access = authenticateHttpRequest(
    dependencies.authenticator, request.credential, request.protocolVersion,
  );
  if (!access.ok) return Object.freeze({ body: access, httpStatus: access.httpStatus, kind: "REPLY" });
  if (!access.principal.capabilities.includes(CAPABILITIES.GOAL)) {
    return Object.freeze({ body: refused("RUNS_READ_CAPABILITY_DENIED"), httpStatus: 200, kind: "REPLY" });
  }
  const port = dependencies.runs;
  if (port === undefined) {
    return Object.freeze({ code: "LISTENER_RUNS_UNAVAILABLE", kind: "LISTENER_REFUSAL" });
  }
  if (access.principal.projectId !== port.boundProjectId) {
    return Object.freeze({ body: refused("RUNS_READ_PROJECT_MISMATCH"), httpStatus: 200, kind: "REPLY" });
  }
  const selector = runsSelectorOf(request.body);
  if (selector === null) {
    return Object.freeze({ code: "LISTENER_RUNS_REQUEST_INVALID", kind: "LISTENER_REFUSAL" });
  }
  return Object.freeze({ body: port.readRuns(selector), httpStatus: 200, kind: "REPLY" });
}
