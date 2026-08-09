import { expect } from "vitest";

import * as contracts from "@moe/contracts";
import type { DocumentWorkProposalAdvisoryEnvelope } from "@moe/contracts";

export interface ProposalResult extends DocumentWorkProposalAdvisoryEnvelope {
  readonly ok: boolean;
  readonly outcome: string;
  readonly code?: string;
  readonly layer?: string;
  readonly decodeError?: { readonly code: string; readonly ok: false };
  readonly proposal?: Readonly<Record<string, unknown>>;
}

interface DocumentWorkApi {
  readonly DOCUMENT_WORK_PROPOSAL_ERROR_CODES: readonly string[];
  readonly DOCUMENT_WORK_PROPOSAL_LAYERS: readonly string[];
  readonly DOCUMENT_WORK_PROPOSAL_LIMITS: Readonly<Record<string, number>>;
  readonly DOCUMENT_WORK_PROPOSAL_SCHEMA_VERSION: string;
  readonly decodeDocumentWorkProposalBytes: (input: unknown) => ProposalResult;
}

export const api = contracts as unknown as DocumentWorkApi;
export const encoder = new TextEncoder();
export const HASH_A = "a".repeat(64);
export const HASH_B = "b".repeat(64);
export const ADVISORY_ENVELOPE = Object.freeze({
  advisoryOnly: true,
  authority: "NONE",
} as const) satisfies DocumentWorkProposalAdvisoryEnvelope;
export const CONTROL_CODE_POINTS = Object.freeze([
  ...Array.from({ length: 0x20 }, (_, codePoint) => codePoint),
  0x7f,
]);

export function bytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

export function source(
  index = 0,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    byteLength: 128 + index,
    contentSha256: index % 2 === 0 ? HASH_A : HASH_B,
    displayPath: `docs/source-${index}.md`,
    sourceRef: `source-${index}`,
    ...overrides,
  };
}

export function candidate(
  index = 0,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    candidateRef: `candidate-${index}`,
    objective: `Implement candidate ${index} from the cited project documents.`,
    sourceRefs: [`source-${index}`],
    title: `Candidate ${index}`,
    ...overrides,
  };
}

export function proposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    advisoryOnly: true,
    authority: "NONE",
    candidates: [candidate()],
    contextManifestDigest: HASH_B,
    projectId: "project-1",
    repositoryBaseHash: HASH_A,
    schemaVersion: "moe-document-work-proposal/1",
    sources: [source()],
    submissionState: "NOT_SUBMITTED",
    truthClass: "AGENT_REPORTED",
    ...overrides,
  };
}

export function decoded(value: unknown): ProposalResult {
  return api.decodeDocumentWorkProposalBytes(bytes(value));
}

export function expectRefusal(result: ProposalResult, code: string, layer: string): void {
  expect(result).toStrictEqual({
    ...ADVISORY_ENVELOPE, code, layer, ok: false, outcome: "REFUSED",
  });
  expect(Object.isFrozen(result)).toBe(true);
}

export function expectAccepted(value: unknown): Readonly<Record<string, unknown>> {
  const result = decoded(value);
  expect(result.ok).toBe(true);
  if (!result.ok || result.proposal === undefined) throw new Error("proposal was refused");
  expect(result.outcome).toBe("PROPOSED");
  expect({ advisoryOnly: result.advisoryOnly, authority: result.authority })
    .toStrictEqual(ADVISORY_ENVELOPE);
  return result.proposal;
}
