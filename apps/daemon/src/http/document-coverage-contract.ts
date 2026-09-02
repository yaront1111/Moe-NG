/**
 * PRD COVERAGE, the wire contract: for one source document (its contentSha256, or a goal
 * bound to it) everything the daemon can say DURABLY about how far its product is built.
 *
 * A criterion is UNPLANNED (no sealed node carries it), PLANNED (a sealed node carries it,
 * not yet accepted) or VERIFIED (the node's review ledger holds the daemon's own
 * acceptance, the verifier receipt `integration.accept_output` consumed). The section map
 * is derived from prose and travels as `advisoryOnly: true`; "the whole PRD is done" stays
 * the human's call, made over these facts instead of over memory.
 */
import type { SectionCoverage } from "./document-coverage-sections.js";

export const DOCUMENT_COVERAGE_READ_PATH = "/documents/coverage/read" as const;
export const DOCUMENT_COVERAGE_READ_LAYER = "DOCUMENT_COVERAGE_READ" as const;

export const DOCUMENT_COVERAGE_READ_CODES = Object.freeze([
  "DOCUMENT_COVERAGE_READ_CAPABILITY_DENIED",
  "DOCUMENT_COVERAGE_READ_GOAL_UNBOUND",
  "DOCUMENT_COVERAGE_READ_MALFORMED",
  "DOCUMENT_COVERAGE_READ_PROJECT_MISMATCH",
  "DOCUMENT_COVERAGE_READ_UNREADABLE",
] as const);
export type DocumentCoverageReadCode = (typeof DOCUMENT_COVERAGE_READ_CODES)[number];

export type CriterionCoverageStatus = "PLANNED" | "UNPLANNED" | "VERIFIED";

export interface CriterionCoverage {
  readonly criterionId: string;
  /** The sealed node that carries this criterion, when one does. */
  readonly nodeKey: string | null;
  readonly statement: string;
  readonly status: CriterionCoverageStatus;
}
export interface RequirementCoverage {
  readonly criteria: readonly CriterionCoverage[];
  readonly requirementId: string;
  readonly statement: string;
}
export interface ContractCoverage {
  readonly contractId: string;
  readonly gate1: "APPROVED" | "PENDING";
  readonly requirements: readonly RequirementCoverage[];
  readonly revisionDigest: string;
  readonly revisionId: string;
}
export interface GoalCoverage {
  readonly goalId: string;
  readonly lifecycle: string | null;
  readonly title: string | null;
}
export interface DocumentCoverageView {
  readonly contracts: readonly ContractCoverage[];
  readonly document: {
    readonly byteLength: number | null;
    readonly contentSha256: string;
    readonly displayPath: string | null;
  };
  readonly goals: readonly GoalCoverage[];
  readonly outcome: "COVERAGE";
  readonly sections:
    | { readonly advisoryOnly: true; readonly entries: readonly SectionCoverage[] }
    | null;
  readonly totals: {
    readonly contracts: number;
    readonly criteria: number;
    readonly goals: number;
    readonly planned: number;
    readonly requirements: number;
    readonly verified: number;
  };
}
export interface DocumentCoverageRefused {
  readonly code: string;
  readonly layer: string;
  readonly outcome: "REFUSED";
}
export type DocumentCoverageReadResult = DocumentCoverageRefused | DocumentCoverageView;

/** Exactly one of the two: the document itself, or a goal the catalog binds to it. */
export type DocumentCoverageSelector =
  | { readonly contentSha256: string }
  | { readonly goalRef: string };

export interface DocumentCoverageReadPort {
  readonly boundProjectId: string;
  readCoverage(selector: DocumentCoverageSelector): DocumentCoverageReadResult;
}

export const coverageRefused = (
  code: string, layer: string = DOCUMENT_COVERAGE_READ_LAYER,
): DocumentCoverageRefused => Object.freeze({ code, layer, outcome: "REFUSED" as const });
