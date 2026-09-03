/**
 * THE PRD A GOAL BINDS, over HTTP: the full source text the goal was created from, read
 * through the same `GoalSourceReadPort` the MCP dispatcher and the wrapper's compiler lane
 * already use. The port re-derives the binding from the goal's own GoalCreated row and
 * re-hashes the stored bytes, so what the browser shows is what the daemon planned from.
 * A goal without a source binding refuses by name; nothing here invents a text.
 */
import { decodeBoundedJsonBytes } from "@moe/contracts";

import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import type { GoalSourceReadPort } from "../documents/document-source-full-read.js";
import { authenticateHttpRequest } from "./http-command-ingress.js";
import type { Authenticator, HttpPortRefused, HttpRefused } from "./http-contract.js";

export const GOAL_SOURCE_READ_PATH = "/goals/source/read" as const;
const LAYER = "GOAL_SOURCE_READ" as const;

export const GOAL_SOURCE_READ_CODES = Object.freeze(["GOAL_SOURCE_READ_CAPABILITY_DENIED"] as const);

export interface GoalSourceView {
  readonly byteLength: number;
  readonly contentSha256: string;
  readonly displayPath: string;
  readonly mediaType: string;
  readonly outcome: "GOAL_SOURCE";
  readonly sourceRef: string;
  readonly text: string;
}
export interface GoalSourceRefused { readonly code: string; readonly layer: string; readonly outcome: "REFUSED" }
export type GoalSourceReadResult = GoalSourceRefused | GoalSourceView;

const refused = (code: string, layer: string = LAYER): GoalSourceRefused =>
  Object.freeze({ code, layer, outcome: "REFUSED" as const });

/** `{ goalRef }` exactly: one non-empty string key, nothing else. */
export function goalRefOf(body: unknown): string | null {
  const decoded = decodeBoundedJsonBytes(body);
  if (!decoded.ok) return null;
  const value: unknown = decoded.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  const goalRef = (value as Record<string, unknown>)["goalRef"];
  if (keys.length !== 1 || keys[0] !== "goalRef" || typeof goalRef !== "string" || goalRef.length === 0) return null;
  return goalRef;
}

/** Maps the port's own answer onto the wire: text on `ok`, the port's code and layer otherwise. */
export function goalSourceViewOf(port: GoalSourceReadPort, goalRef: string): GoalSourceReadResult {
  const result = port.read(goalRef);
  if (!result.ok) return refused(result.code, result.layer);
  return Object.freeze({
    byteLength: result.byteLength,
    contentSha256: result.contentSha256,
    displayPath: result.displayPath,
    mediaType: result.mediaType,
    outcome: "GOAL_SOURCE" as const,
    sourceRef: result.sourceRef,
    text: result.text,
  });
}

export type GoalSourceReadDispatch =
  | { readonly body: GoalSourceReadResult | HttpPortRefused | HttpRefused; readonly httpStatus: number; readonly kind: "REPLY" }
  | { readonly code: "LISTENER_GOAL_SOURCE_REQUEST_INVALID" | "LISTENER_GOAL_SOURCE_UNAVAILABLE"; readonly kind: "LISTENER_REFUSAL" };

export function handleGoalSourceReadRequest(
  dependencies: { readonly authenticator: Authenticator; readonly goalSource?: GoalSourceReadPort | undefined },
  request: { readonly body: unknown; readonly credential: string | null; readonly protocolVersion: unknown },
): GoalSourceReadDispatch {
  const access = authenticateHttpRequest(dependencies.authenticator, request.credential, request.protocolVersion);
  if (!access.ok) return Object.freeze({ body: access, httpStatus: access.httpStatus, kind: "REPLY" });
  if (!access.principal.capabilities.includes(CAPABILITIES.GOAL)) {
    return Object.freeze({ body: refused("GOAL_SOURCE_READ_CAPABILITY_DENIED"), httpStatus: 200, kind: "REPLY" });
  }
  const port = dependencies.goalSource;
  if (port === undefined) return Object.freeze({ code: "LISTENER_GOAL_SOURCE_UNAVAILABLE", kind: "LISTENER_REFUSAL" });
  const goalRef = goalRefOf(request.body);
  if (goalRef === null) return Object.freeze({ code: "LISTENER_GOAL_SOURCE_REQUEST_INVALID", kind: "LISTENER_REFUSAL" });
  return Object.freeze({ body: goalSourceViewOf(port, goalRef), httpStatus: 200, kind: "REPLY" });
}
