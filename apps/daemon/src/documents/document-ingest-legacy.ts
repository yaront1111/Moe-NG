import { identifyReplayRequest } from "@moe/store";
import type { CommandDecisionRecord } from "@moe/store";

import type { DocumentIngestMediaType } from "./document-source-contract.js";
import {
  documentSourceRef,
  documentWorkIngestCommandId,
  legacyDocumentSourceRef,
} from "./document-source-identifiers.js";
import { readDocumentSourceView } from "./document-source-read.js";
import { durableStoreRefusal, refuse } from "./document-work-result.js";
import type { DocumentWorkServiceRefused } from "./document-work-service-contract.js";
import type { DocumentWorkStorePort } from "./document-work-store-port.js";

export interface DocumentIngestIdentity {
  readonly proposalCommandId: string;
  readonly sourceRef: string;
}

export type DocumentIngestIdentityOutcome =
  | { readonly identity: DocumentIngestIdentity }
  | { readonly refusal: DocumentWorkServiceRefused };

interface SelectDocumentIngestIdentityInput {
  readonly contentSha256: string;
  readonly displayPath: string;
  readonly legacyProposalBytes: Uint8Array;
  readonly mediaType: DocumentIngestMediaType;
  readonly objective: string;
  readonly principalId: string;
  readonly projectId: string;
}

type LegacyDecisionOutcome =
  | { readonly decision: CommandDecisionRecord | null }
  | { readonly refusal: DocumentWorkServiceRefused };

function currentIdentity(input: SelectDocumentIngestIdentityInput): DocumentIngestIdentity {
  const sourceRef = documentSourceRef(
    input.contentSha256, input.displayPath, input.mediaType,
  );
  return Object.freeze({
    proposalCommandId: documentWorkIngestCommandId(
      input.projectId, input.contentSha256, sourceRef, input.objective,
    ),
    sourceRef,
  });
}

function readLegacyDecision(
  store: DocumentWorkStorePort,
  input: SelectDocumentIngestIdentityInput,
): LegacyDecisionOutcome {
  try {
    return {
      decision: store.getCommandDecision({
        commandId: documentWorkIngestCommandId(input.projectId, input.contentSha256),
        principalId: input.principalId,
        projectId: input.projectId,
      }),
    };
  } catch (error) {
    const mapped = durableStoreRefusal(error);
    if (mapped !== null) return { refusal: mapped };
    throw error;
  }
}

/**
 * Selects the historical content-only identity only when both durable legs prove they describe
 * this exact path, media and objective. A changed binding uses v2; malformed legacy evidence is
 * never treated as absence and therefore cannot be bypassed by minting a fresh identity.
 */
export function selectDocumentIngestIdentity(
  store: DocumentWorkStorePort,
  input: SelectDocumentIngestIdentityInput,
): DocumentIngestIdentityOutcome {
  const current = currentIdentity(input);
  let source: ReturnType<typeof readDocumentSourceView>;
  try {
    source = readDocumentSourceView(store, input.projectId, input.contentSha256);
  } catch (error) {
    const mapped = durableStoreRefusal(error);
    if (mapped !== null) return { refusal: mapped };
    throw error;
  }
  if (source.kind === "REFUSED") return { refusal: source.refusal };

  const read = readLegacyDecision(store, input);
  if ("refusal" in read) return read;
  const { decision } = read;
  if (source.kind === "ABSENT") {
    return decision?.effectDisposition === "EFFECTS_COMMITTED"
      ? { refusal: refuse("DOCUMENT_WORK_DOSSIER_SOURCE_INVALID", "DAEMON_READ_MODEL") }
      : { identity: current };
  }
  if (
    source.view.displayPath !== input.displayPath ||
    source.view.mediaType !== input.mediaType
  ) {
    return { identity: current };
  }
  if (decision === null) return { identity: current };
  if (decision.effectDisposition !== "EFFECTS_COMMITTED") {
    return {
      refusal: refuse(
        decision.resultCode as DocumentWorkServiceRefused["code"], "DURABLE_STORE",
      ),
    };
  }
  if (
    identifyReplayRequest(decision, input.legacyProposalBytes) !==
    decision.replayRequestSha256
  ) {
    return { identity: current };
  }
  return {
    identity: Object.freeze({
      proposalCommandId: documentWorkIngestCommandId(input.projectId, input.contentSha256),
      sourceRef: legacyDocumentSourceRef(input.contentSha256),
    }),
  };
}
