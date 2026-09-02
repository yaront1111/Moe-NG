/**
 * The HTTP face of the PRD coverage read: POST /documents/coverage/read with a body that is
 * EXACTLY `{ contentSha256 }` or EXACTLY `{ goalRef }`, a string either way. The listener
 * refuses any other body before the port is asked (a caller cannot smuggle a projectId or a
 * second selector), the capability gate is the goal capability, and the port's own project
 * binding is compared to the principal's so a credential for one project can never read
 * another project's coverage through a shared listener.
 */
import { decodeBoundedJsonBytes } from "@moe/contracts";

import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import { coverageRefused as refused } from "./document-coverage-contract.js";
import type {
  DocumentCoverageReadPort, DocumentCoverageReadResult, DocumentCoverageSelector,
} from "./document-coverage-contract.js";
import { authenticateHttpRequest } from "./http-command-ingress.js";
import type { Authenticator, HttpPortRefused, HttpRefused } from "./http-contract.js";

export type DocumentCoverageListenerCode =
  | "LISTENER_DOCUMENT_COVERAGE_REQUEST_INVALID"
  | "LISTENER_DOCUMENT_COVERAGE_UNAVAILABLE";

export type DocumentCoverageReadDispatch =
  | {
    readonly body: DocumentCoverageReadResult | HttpPortRefused | HttpRefused;
    readonly httpStatus: number;
    readonly kind: "REPLY";
  }
  | { readonly code: DocumentCoverageListenerCode; readonly kind: "LISTENER_REFUSAL" };

export interface DocumentCoverageRouteDependencies {
  readonly authenticator: Authenticator;
  readonly documentCoverage?: DocumentCoverageReadPort | undefined;
}

export interface DocumentCoverageRouteRequest {
  readonly body: unknown;
  readonly credential: string | null;
  readonly protocolVersion: unknown;
}

/** The exact one-key body, or null: `{ contentSha256: string }` or `{ goalRef: string }`. */
export function coverageSelectorOf(body: unknown): DocumentCoverageSelector | null {
  const decoded = decodeBoundedJsonBytes(body);
  if (!decoded.ok) return null;
  const value: unknown = decoded.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record);
  if (keys.length !== 1) return null;
  const [key] = keys;
  const selected = record[key as string];
  if (typeof selected !== "string") return null;
  if (key === "contentSha256") return Object.freeze({ contentSha256: selected });
  if (key === "goalRef") return Object.freeze({ goalRef: selected });
  return null;
}

export function handleDocumentCoverageReadRequest(
  dependencies: DocumentCoverageRouteDependencies,
  request: DocumentCoverageRouteRequest,
): DocumentCoverageReadDispatch {
  const access = authenticateHttpRequest(
    dependencies.authenticator, request.credential, request.protocolVersion,
  );
  if (!access.ok) return Object.freeze({ body: access, httpStatus: access.httpStatus, kind: "REPLY" });
  if (!access.principal.capabilities.includes(CAPABILITIES.GOAL)) {
    return Object.freeze({
      body: refused("DOCUMENT_COVERAGE_READ_CAPABILITY_DENIED"), httpStatus: 200, kind: "REPLY",
    });
  }
  const port = dependencies.documentCoverage;
  if (port === undefined) {
    return Object.freeze({ code: "LISTENER_DOCUMENT_COVERAGE_UNAVAILABLE", kind: "LISTENER_REFUSAL" });
  }
  if (access.principal.projectId !== port.boundProjectId) {
    return Object.freeze({
      body: refused("DOCUMENT_COVERAGE_READ_PROJECT_MISMATCH"), httpStatus: 200, kind: "REPLY",
    });
  }
  const selector = coverageSelectorOf(request.body);
  if (selector === null) {
    return Object.freeze({ code: "LISTENER_DOCUMENT_COVERAGE_REQUEST_INVALID", kind: "LISTENER_REFUSAL" });
  }
  return Object.freeze({ body: port.readCoverage(selector), httpStatus: 200, kind: "REPLY" });
}
