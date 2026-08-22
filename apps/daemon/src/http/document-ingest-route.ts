/**
 * The operator DOCUMENT-INGEST write route: a human drops a PRD in the browser and this bespoke
 * POST records its text durably and a provisional DocumentWorkProposal beside it. The ingest is
 * OPERATOR-ONLY: it gates on CAPABILITIES.ADMIN, the one capability an agent session scoped to
 * WORK, GOAL or PLANNING never holds, so no agent can seed advisory proposals through this seam.
 *
 * AUTHENTICATE BEFORE DECODE, then the capability, THEN the body - the same gate order the
 * planning-run read shares, so an unidentified or unauthorized caller never has their bytes
 * decoded. Availability and the project cross-check sit after the capability, so a caller without
 * it learns neither how this daemon is composed nor which project it serves. The project is the
 * PRINCIPAL's, never a body field.
 *
 * THE PAYLOAD ALLOW-LIST IS NOT RE-VALIDATED HERE. `ingestDocument` owns the payload shape, the
 * media roster and the text-size cap and returns each refusal as its own coded DAEMON_INGRESS
 * result; this route decodes the transport frame only and forwards the decoded value straight to
 * the port. A second validator here would be a fork the two could drift apart on.
 *
 * THE LAYER CONSTANT STAYS MODULE-PRIVATE. `boundary-roster.security.ts` counts every exported
 * column-zero `*_LAYER(S)`; a pure route earns no hostile trio, so this follows the precedent the
 * planning-run reader set and exports only what a consumer switches on.
 */
import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import { ingestDocument } from "../documents/document-ingest.js";
import type { DocumentIngestResult } from "../documents/document-source-contract.js";
import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import { authenticateHttpRequest } from "./http-adapter.js";
import type { Authenticator, HttpPortRefused, HttpRefused } from "./http-contract.js";

export const DOCUMENT_INGEST_PATH = "/documents/ingest" as const;

const DOCUMENT_INGEST_ROUTE = "DOCUMENT_INGEST_ROUTE" as const;

/**
 * Refusals this route ORIGINATES. Closed on purpose: a caller switches on it exhaustively. The
 * payload's own faults (shape, media, size) are NOT here - they travel out as `ingestDocument`'s
 * coded DAEMON_INGRESS result. Transport faults - a malformed body, an absent port - carry the
 * listener's own codes and never enter this vocabulary.
 */
export const DOCUMENT_INGEST_CODES = Object.freeze([
  "DOCUMENT_INGEST_CAPABILITY_DENIED",
  "DOCUMENT_INGEST_PROJECT_MISMATCH",
] as const);

export type DocumentIngestCode = (typeof DOCUMENT_INGEST_CODES)[number];

export interface DocumentIngestRouteRefused {
  readonly code: DocumentIngestCode;
  readonly layer: typeof DOCUMENT_INGEST_ROUTE;
  readonly outcome: "REFUSED";
}

/** ONE INGEST AND THE BOUND PROJECT. The store, the clock and the id mint are SERVER facts held
 *  by the composition root, never reachable from a request, which is what makes `boundProjectId`
 *  a bound rather than a hint. */
export interface DocumentIngestPort {
  readonly boundProjectId: string;
  ingest(payload: unknown, principalId: string): DocumentIngestResult;
}

function refused(code: DocumentIngestCode): DocumentIngestRouteRefused {
  return Object.freeze({ code, layer: DOCUMENT_INGEST_ROUTE, outcome: "REFUSED" as const });
}

/**
 * Binds one ingest to the daemon's own project, store, clock and correlation mint. The correlation
 * id and decision time are minted per call, here, for the same reason the project is a fact of this
 * root: neither is request input a caller may forge.
 */
export function createDocumentIngestPort(config: {
  readonly clock: () => string;
  readonly mintCorrelationId: () => string;
  readonly projectId: string;
  readonly store: SqliteEventStore;
}): DocumentIngestPort {
  return Object.freeze({
    boundProjectId: config.projectId,
    ingest: (payload: unknown, principalId: string): DocumentIngestResult =>
      ingestDocument(config.store, {
        correlationId: config.mintCorrelationId(),
        decidedAt: config.clock(),
        payload,
        principalId,
        projectId: config.projectId,
      }),
  });
}

type DocumentIngestListenerCode =
  | "LISTENER_DOCUMENT_INGEST_REQUEST_INVALID"
  | "LISTENER_DOCUMENT_INGEST_UNAVAILABLE";

export interface DocumentIngestDependencies {
  readonly authenticator: Authenticator;
  readonly documentIngest?: DocumentIngestPort | undefined;
}

export interface DocumentIngestRequest {
  readonly body: unknown;
  readonly credential: string | null;
  readonly protocolVersion: unknown;
}

export type DocumentIngestDispatch =
  | {
      readonly body: DocumentIngestResult | DocumentIngestRouteRefused | HttpPortRefused | HttpRefused;
      readonly httpStatus: number;
      readonly kind: "REPLY";
    }
  | {
      readonly code: DocumentIngestListenerCode;
      readonly kind: "LISTENER_REFUSAL";
    };

function reply(
  httpStatus: number,
  body: DocumentIngestResult | DocumentIngestRouteRefused | HttpPortRefused | HttpRefused,
): DocumentIngestDispatch {
  return Object.freeze({ body, httpStatus, kind: "REPLY" as const });
}

function listenerRefusal(code: DocumentIngestListenerCode): DocumentIngestDispatch {
  return Object.freeze({ code, kind: "LISTENER_REFUSAL" as const });
}

/**
 * Authenticate and check compatibility, then the ADMIN capability, then availability and the
 * project cross-check, THEN decode the body. The decoded value is forwarded to the port UNPARSED:
 * `ingestDocument` is the only parser of the operator payload and owns every payload refusal.
 */
export function handleDocumentIngestRequest(
  dependencies: DocumentIngestDependencies,
  request: DocumentIngestRequest,
): DocumentIngestDispatch {
  const access = authenticateHttpRequest(
    dependencies.authenticator, request.credential, request.protocolVersion,
  );
  if (!access.ok) return reply(access.httpStatus, access);
  if (!access.principal.capabilities.includes(CAPABILITIES.ADMIN)) {
    return reply(200, refused("DOCUMENT_INGEST_CAPABILITY_DENIED"));
  }
  if (dependencies.documentIngest === undefined) {
    return listenerRefusal("LISTENER_DOCUMENT_INGEST_UNAVAILABLE");
  }
  if (access.principal.projectId !== dependencies.documentIngest.boundProjectId) {
    return reply(200, refused("DOCUMENT_INGEST_PROJECT_MISMATCH"));
  }
  const decoded = decodeBoundedJsonBytes(request.body);
  if (!decoded.ok) return listenerRefusal("LISTENER_DOCUMENT_INGEST_REQUEST_INVALID");
  return reply(200, dependencies.documentIngest.ingest(decoded.value, access.principal.principalId));
}
