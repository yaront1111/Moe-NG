/**
 * PRD COVERAGE, the wire contract: for one source document (its contentSha256, or a goal
 * bound to it) everything the daemon can say DURABLY about how far its product is built.
 *
 * A criterion is UNPLANNED (no sealed node carries it), PLANNED (a sealed node carries it,
 * not yet accepted), EVIDENCE_REQUIRED (its node test passed, but no criterion-specific
 * evidence establishes the requirement) or UNATTRIBUTABLE (legacy bare-key execution cannot
 * be assigned to the plan, or the scoped review ledger does not read). The section map is derived from
 * prose and travels as `advisoryOnly: true`. VERIFIED is reserved for criterion-specific
 * evidence; the current generic node verifier cannot produce that status.
 */
import type { SectionCoverage } from "./document-coverage-sections.js";

export const DOCUMENT_COVERAGE_READ_PATH = "/documents/coverage/read" as const;
/** Module-private like every sibling read route: the boundary roster keys on EXPORTED
 *  `*_LAYER` declarations, and a route-local refusal layer is not a new boundary. */
const LAYER = "DOCUMENT_COVERAGE_READ" as const;

export const DOCUMENT_COVERAGE_READ_CODES = Object.freeze([
  "DOCUMENT_COVERAGE_READ_CAPABILITY_DENIED",
  "DOCUMENT_COVERAGE_READ_GOAL_UNBOUND",
  "DOCUMENT_COVERAGE_READ_MALFORMED",
  "DOCUMENT_COVERAGE_READ_PROJECT_MISMATCH",
  "DOCUMENT_COVERAGE_READ_UNREADABLE",
] as const);
export type DocumentCoverageReadCode = (typeof DOCUMENT_COVERAGE_READ_CODES)[number];

export const CRITERION_COVERAGE_STATUSES = Object.freeze([
  "EVIDENCE_REQUIRED", "PLANNED", "UNATTRIBUTABLE", "UNPLANNED", "VERIFIED",
] as const);
export type CriterionCoverageStatus = (typeof CRITERION_COVERAGE_STATUSES)[number];

export interface CriterionCoverage {
  readonly criterionId: string;
  /** The sealed node that carries this criterion, when one does. */
  readonly nodeKey: string | null;
  /** A node test fact, independent of whether this criterion has suitable evidence. */
  readonly nodeTestStatus: "NODE_TEST_PASSED" | null;
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
  /** The wire the revision was proposed on: the `/1` writer or the `/2` family. */
  readonly plane: "V1" | "V2";
  readonly requirements: readonly RequirementCoverage[];
  readonly revisionDigest: string;
  readonly revisionId: string;
}
export interface GoalCoverage {
  readonly goalId: string;
  /** The latest committed decision on the goal, its run or one of its sealed nodes. */
  readonly lastActivityAt: string | null;
  readonly lifecycle: string | null;
  readonly planningRunRef: string | null;
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
    readonly unattributable: number;
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
  code: string, layer: string = LAYER,
): DocumentCoverageRefused => Object.freeze({ code, layer, outcome: "REFUSED" as const });
