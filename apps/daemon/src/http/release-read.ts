/**
 * THE RELEASE EVIDENCE ROUTE: POST `/release/read` answers, for one goal, the criterion rows a
 * release decision rests on and the receipt of the decision if one has been taken.
 *
 * The ANSWER and its derivation live in `release/release-evidence-read.ts`, next to the facts
 * they fold; this module is the HTTP edge alone — the path, the body it admits, and the
 * dispatch the listener replies with. Same split, and the same reasons, as every other read
 * route on this surface.
 */
import { decodeBoundedJsonBytes } from "@moe/contracts";

import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import { releaseReadRefusal } from "./release-evidence-read.js";
import type { ReleaseReadAnswer, ReleaseReadPort } from "./release-evidence-read.js";
import { authenticateHttpRequest } from "./http-command-ingress.js";
import type { Authenticator, HttpPortRefused, HttpRefused } from "./http-contract.js";

export const RELEASE_READ_PATH = "/release/read" as const;

/**
 * Own enumerable keys are EXACTLY `{goalId}`. A body naming a projectId is an unknown key, not
 * an override: the project comes from the authenticated principal and never from the wire.
 */
export function releaseReadBodyOf(body: unknown): { readonly goalId: string } | null {
  const decoded = decodeBoundedJsonBytes(body);
  if (!decoded.ok) return null;
  const value: unknown = decoded.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "goalId") return null;
  const goalId = record["goalId"];
  return typeof goalId === "string" && goalId.length > 0 ? { goalId } : null;
}

export type ReleaseReadDispatch =
  | {
    readonly body: ReleaseReadAnswer | HttpPortRefused | HttpRefused;
    readonly httpStatus: number;
    readonly kind: "REPLY";
  }
  | {
    readonly code: "LISTENER_RELEASE_REQUEST_INVALID" | "LISTENER_RELEASE_UNAVAILABLE";
    readonly kind: "LISTENER_REFUSAL";
  };

export function handleReleaseReadRequest(
  dependencies: {
    readonly authenticator: Authenticator;
    readonly releaseReads?: ReleaseReadPort | undefined;
  },
  request: {
    readonly body: unknown;
    readonly credential: string | null;
    readonly protocolVersion: unknown;
  },
): ReleaseReadDispatch {
  const access = authenticateHttpRequest(
    dependencies.authenticator, request.credential, request.protocolVersion,
  );
  if (!access.ok) {
    return Object.freeze({ body: access, httpStatus: access.httpStatus, kind: "REPLY" });
  }
  if (!access.principal.capabilities.includes(CAPABILITIES.GOAL)) {
    return Object.freeze({
      body: releaseReadRefusal("RELEASE_READ_CAPABILITY_DENIED"), httpStatus: 200, kind: "REPLY",
    });
  }
  const port = dependencies.releaseReads;
  if (port === undefined) {
    return Object.freeze({ code: "LISTENER_RELEASE_UNAVAILABLE", kind: "LISTENER_REFUSAL" });
  }
  const decoded = releaseReadBodyOf(request.body);
  if (decoded === null) {
    return Object.freeze({ code: "LISTENER_RELEASE_REQUEST_INVALID", kind: "LISTENER_REFUSAL" });
  }
  return Object.freeze({
    body: port.read({ goalId: decoded.goalId, projectId: access.principal.projectId }),
    httpStatus: 200,
    kind: "REPLY",
  });
}
