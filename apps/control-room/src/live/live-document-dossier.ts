import type { ControlRoomTransport, SendResult } from "@moe/control-room-client";
import { decodeDocumentWorkProposalBytes } from "@moe/contracts";

import {
  documentDossierStateFromProposal,
} from "../preview/document-dossier-state.js";
import type {
  DocumentDossierErrorState,
  DocumentDossierState,
} from "../preview/document-dossier-state.js";

export const LIVE_DOCUMENT_DOSSIER_LOADING = Object.freeze({
  advisoryOnly: true,
  authority: "NONE",
  status: "LOADING",
} as const);

const INVALID_RESPONSE_CODE = "DOCUMENT_DOSSIER_RESPONSE_INVALID";
const LIVE_DOCUMENT_LAYER = "CONTROL_ROOM_LIVE_DOCUMENTS";
const encoder = new TextEncoder();

function errorState(code: string, layer: string): DocumentDossierErrorState {
  return Object.freeze({
    advisoryOnly: true,
    authority: "NONE",
    code,
    layer,
    status: "ERROR",
  });
}

function invalidResponse(): DocumentDossierErrorState {
  return errorState(INVALID_RESPONSE_CODE, LIVE_DOCUMENT_LAYER);
}

function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expectedKeys.length
      || keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))) return null;
    const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        return null;
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function refusalFrom(response: unknown): DocumentDossierErrorState | null {
  const listener = exactDataRecord(response, ["code", "layer"]);
  if (listener !== null && typeof listener.code === "string" && typeof listener.layer === "string") {
    return errorState(listener.code, listener.layer);
  }
  const service = exactDataRecord(response, [
    "advisoryOnly", "authority", "code", "layer", "ok", "outcome",
  ]);
  if (service !== null
    && service.advisoryOnly === true && service.authority === "NONE"
    && service.ok === false && service.outcome === "REFUSED"
    && typeof service.code === "string" && typeof service.layer === "string") {
    return errorState(service.code, service.layer);
  }
  const http = exactDataRecord(response, [
    "error", "httpStatus", "ok", "outcome", "stage",
  ]);
  if (http === null || http.ok !== false || http.outcome !== "REFUSED"
    || typeof http.stage !== "string") return null;
  const runtimeError = typeof http.error === "object" && http.error !== null
    ? Object.getOwnPropertyDescriptor(http.error, "code") : undefined;
  return runtimeError !== undefined && "value" in runtimeError
    && typeof runtimeError.value === "string"
    ? errorState(runtimeError.value, http.stage) : null;
}

function encodedProposal(value: unknown): Uint8Array | null {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? encoder.encode(json) : null;
  } catch {
    return null;
  }
}

/** Maps only exact daemon/service frames; every other answer becomes a visible error state. */
export function mapDocumentDossierAnswer(result: SendResult): DocumentDossierState {
  if (!result.delivered) return errorState(result.code, result.layer);
  const refused = refusalFrom(result.response);
  if (refused !== null) return refused;
  if (result.status !== 200) return invalidResponse();
  const response = exactDataRecord(result.response, [
    "advisoryOnly", "aggregateId", "aggregateSequence", "authority", "committedAt",
    "eventId", "ok", "outcome", "proposal",
  ]);
  if (response === null
    || response.advisoryOnly !== true || response.authority !== "NONE"
    || response.ok !== true || response.outcome !== "DOSSIER"
    || typeof response.aggregateId !== "string" || response.aggregateId.length === 0
    || !Number.isSafeInteger(response.aggregateSequence)
    || (response.aggregateSequence as number) < 1
    || typeof response.committedAt !== "string" || response.committedAt.length === 0
    || typeof response.eventId !== "string" || response.eventId.length === 0) {
    return invalidResponse();
  }
  const proposalBytes = encodedProposal(response.proposal);
  if (proposalBytes === null) return invalidResponse();
  const decoded = decodeDocumentWorkProposalBytes(proposalBytes);
  if (!decoded.ok) return errorState(decoded.code, decoded.layer);
  return documentDossierStateFromProposal({
    dossierIdentity: response.eventId,
    origin: "DAEMON",
    proposal: decoded.proposal,
  });
}

export interface LiveDocumentDossierFeed {
  start(): void;
  stop(): void;
}

export interface LiveDocumentDossierFeedOptions {
  readonly intervalMs: number;
  readonly onState: (state: DocumentDossierState) => void;
  readonly transport: Pick<ControlRoomTransport, "readDocumentDossier">;
}

/** Polls serially and suppresses every response that lands after stop. */
export function createLiveDocumentDossierFeed(
  options: LiveDocumentDossierFeedOptions,
): LiveDocumentDossierFeed {
  let active = false;
  let generation = 0;
  let lastReady: { readonly identity: string; readonly proposal: string } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const nextVisibleState = (state: DocumentDossierState): DocumentDossierState | null => {
    if (state.status !== "READY") {
      lastReady = null;
      return state;
    }
    const proposal = JSON.stringify(state.proposal);
    if (lastReady?.identity === state.dossierIdentity) {
      return lastReady.proposal === proposal
        ? null : errorState("DOCUMENT_DOSSIER_IDENTITY_REBOUND", LIVE_DOCUMENT_LAYER);
    }
    lastReady = { identity: state.dossierIdentity, proposal };
    return state;
  };

  const poll = async (run: number): Promise<void> => {
    let state: DocumentDossierState;
    try {
      state = mapDocumentDossierAnswer(await options.transport.readDocumentDossier());
    } catch {
      state = errorState("DOCUMENT_DOSSIER_FEED_FAILED", LIVE_DOCUMENT_LAYER);
    }
    if (!active || run !== generation) return;
    const visible = nextVisibleState(state);
    if (visible !== null) options.onState(visible);
    timer = setTimeout(() => { void poll(run); }, options.intervalMs);
  };

  return Object.freeze({
    start: (): void => {
      if (active) return;
      active = true;
      generation += 1;
      lastReady = null;
      options.onState(LIVE_DOCUMENT_DOSSIER_LOADING);
      void poll(generation);
    },
    stop: (): void => {
      active = false;
      generation += 1;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  });
}
