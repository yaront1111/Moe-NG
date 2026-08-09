import type { DocumentWorkProposal } from "@moe/contracts";

import { documentDossierStateFromProposal } from "./document-dossier-state.js";
import type {
  DocumentDossierOrigin,
  DocumentDossierReadyState,
} from "./document-dossier-state.js";

export const REPOSITORY_HASH = "a".repeat(64);
export const CONTEXT_HASH = "b".repeat(64);
export const CONTENT_HASH = "c".repeat(64);

export function dossierProposal(
  overrides: Partial<DocumentWorkProposal> = {},
): DocumentWorkProposal {
  return {
    advisoryOnly: true,
    authority: "NONE",
    candidates: [{
      candidateRef: "candidate-retry-proof",
      objective: "Prove retry recovery without duplicating the accepted effect.",
      sourceRefs: ["source-acceptance", "source-brief"],
      title: "Prove retry recovery",
    }],
    contextManifestDigest: CONTEXT_HASH,
    projectId: "retry-recovery",
    repositoryBaseHash: REPOSITORY_HASH,
    schemaVersion: "moe-document-work-proposal/1",
    sources: [{
      byteLength: 412,
      contentSha256: CONTENT_HASH,
      displayPath: "docs/acceptance/retry.md",
      sourceRef: "source-acceptance",
    }, {
      byteLength: 287,
      contentSha256: "d".repeat(64),
      displayPath: "docs/incidents/retry.md",
      sourceRef: "source-brief",
    }],
    submissionState: "NOT_SUBMITTED",
    truthClass: "AGENT_REPORTED",
    ...overrides,
  };
}

export function readyState(options: {
  readonly dossierIdentity?: string;
  readonly origin?: DocumentDossierOrigin;
  readonly proposal?: DocumentWorkProposal;
} = {}): DocumentDossierReadyState {
  const state = documentDossierStateFromProposal({
    dossierIdentity: options.dossierIdentity ?? "retry-recovery@a",
    origin: options.origin ?? "DAEMON",
    proposal: options.proposal ?? dossierProposal(),
  });
  if (state.status !== "READY") throw new Error("valid test proposal was refused");
  return state;
}
