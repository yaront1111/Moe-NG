import { decodeBoundedJsonBytes } from "@moe/contracts";

import type { ReadDocumentWorkDossierResult } from "../documents/document-work-service.js";
import { authenticateHttpRequest } from "./http-adapter.js";
import type { Authenticator, HttpPortRefused, HttpRefused } from "./http-contract.js";

export const DOCUMENT_DOSSIER_PATH = "/documents/dossier/read" as const;

export interface DocumentDossierReadPort {
  readLatest(projectId: string): ReadDocumentWorkDossierResult;
}

export interface DocumentDossierReadDependencies {
  readonly authenticator: Authenticator;
  readonly documentDossiers?: DocumentDossierReadPort | undefined;
}

export interface DocumentDossierReadRequest {
  readonly body: unknown;
  readonly credential: string | null;
  readonly protocolVersion: unknown;
}

type DocumentDossierListenerCode =
  | "LISTENER_DOCUMENT_DOSSIER_REQUEST_INVALID"
  | "LISTENER_DOCUMENT_DOSSIER_UNAVAILABLE";

export type DocumentDossierReadDispatch =
  | {
      readonly body: HttpPortRefused | HttpRefused | ReadDocumentWorkDossierResult;
      readonly httpStatus: number;
      readonly kind: "REPLY";
    }
  | {
      readonly code: DocumentDossierListenerCode;
      readonly kind: "LISTENER_REFUSAL";
    };

function listenerRefusal(code: DocumentDossierListenerCode): DocumentDossierReadDispatch {
  return Object.freeze({ code, kind: "LISTENER_REFUSAL" as const });
}

function reply(
  httpStatus: number,
  body: HttpPortRefused | HttpRefused | ReadDocumentWorkDossierResult,
): DocumentDossierReadDispatch {
  return Object.freeze({ body, httpStatus, kind: "REPLY" as const });
}

function isExactEmptyRequest(body: unknown): boolean {
  const decoded = decodeBoundedJsonBytes(body);
  if (!decoded.ok) return false;
  const value = decoded.value;
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === 0;
}

/** Authenticates before parsing and derives the only project identity from that principal. */
export function handleDocumentDossierReadRequest(
  dependencies: DocumentDossierReadDependencies,
  request: DocumentDossierReadRequest,
): DocumentDossierReadDispatch {
  const access = authenticateHttpRequest(
    dependencies.authenticator,
    request.credential,
    request.protocolVersion,
  );
  if (!access.ok) return reply(access.httpStatus, access);
  if (!isExactEmptyRequest(request.body)) {
    return listenerRefusal("LISTENER_DOCUMENT_DOSSIER_REQUEST_INVALID");
  }
  if (dependencies.documentDossiers === undefined) {
    return listenerRefusal("LISTENER_DOCUMENT_DOSSIER_UNAVAILABLE");
  }
  return reply(200, dependencies.documentDossiers.readLatest(access.principal.projectId));
}
