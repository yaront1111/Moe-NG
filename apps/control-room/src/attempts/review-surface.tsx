import type { JSX } from "react";

import {
  FactList, FactRow, NONE_SUPPLIED, Panel, isSupplied, readIdentity,
} from "../nodes/node-authority.js";
import type { ProvenanceHandler, SuppliedFact } from "../nodes/node-authority.js";
import { FindingList, ReceiptList } from "../nodes/node-evidence.js";
import type { EvidenceFinding, EvidenceReceipt } from "../nodes/node-evidence.js";

/** Stable refusal shown instead of a diff whose endpoints are not both known. */
export const NO_DIFF_WITHOUT_SHAS = "No diff without both base and head SHAs.";

/** Spec copy for calibration that has not been measured; never a blank. */
export const CALIBRATION_UNMEASURED = "calibration not yet measured";

/** A path the daemon reported as changed, with its declared-scope verdict. */
export interface ReviewPath {
  readonly outOfScope: boolean;
  readonly path: string;
}

export interface ReviewCriterion {
  readonly criterionId: string;
  readonly state: SuppliedFact;
  readonly statement: SuppliedFact;
}

export interface ReviewDiffFacts {
  readonly baseSha: SuppliedFact;
  readonly dirtyTree: SuppliedFact;
  readonly headSha: SuppliedFact;
  readonly paths: readonly ReviewPath[];
}

export interface ReviewContextFacts {
  readonly graphHash: SuppliedFact;
  readonly planHash: SuppliedFact;
  readonly planRevision: SuppliedFact;
}

export interface ReviewerFacts {
  readonly calibration: SuppliedFact;
  readonly independence: SuppliedFact;
  readonly principal: SuppliedFact;
}

/**
 * The independent reviewer's clean package.
 *
 * This prop type is the first half of the contamination firewall: it declares no
 * transcript, journal, self-assessment, or handoff channel at all, so a caller
 * cannot supply narrative even by accident. The second half is structural — the
 * component destructures only the fields named here, so an object carrying extra
 * operational-history keys loses them at this boundary rather than in a filter.
 */
export interface ReviewSurfaceProps {
  readonly context: ReviewContextFacts;
  readonly criteria: readonly ReviewCriterion[];
  readonly diff: ReviewDiffFacts;
  readonly findings: readonly EvidenceFinding[];
  readonly onProvenance?: ProvenanceHandler | undefined;
  readonly receipts: readonly EvidenceReceipt[];
  readonly reviewer: ReviewerFacts;
}

function DiffPaths(props: { readonly paths: readonly ReviewPath[] }): JSX.Element {
  const { paths } = props;
  if (paths.length === 0) {
    return <p>{NONE_SUPPLIED}</p>;
  }
  return (
    <ul>
      {paths.map((entry, index) => {
        // Anything but an explicit in-scope verdict is flagged: an unreadable
        // verdict must warn the reviewer, never quietly clear the path.
        const flagged = entry.outOfScope !== false;
        return (
          <li
            data-out-of-scope={String(flagged)}
            data-testid={`cr.review.row.${entry.path}`}
            key={`${String(index)}:${entry.path}`}
          >
            <span>{entry.path}</span>
            {flagged ? <span> out of declared write scope</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

function CriteriaList(props: {
  readonly criteria: readonly ReviewCriterion[];
  readonly onProvenance?: ProvenanceHandler | undefined;
}): JSX.Element {
  const { criteria, onProvenance } = props;
  if (criteria.length === 0) {
    return <p>{NONE_SUPPLIED}</p>;
  }
  return (
    <div>
      {criteria.map((criterion, index) => {
        const shownId = readIdentity(criterion.criterionId);
        return (
          <FactList
            key={`${String(index)}:${shownId}`}
            onProvenance={onProvenance}
            rows={[
              [`criterion.${shownId}.statement`, "Criterion", criterion.statement],
              [`criterion.${shownId}.state`, "State", criterion.state],
            ]}
          />
        );
      })}
    </div>
  );
}

/**
 * Renders exactly the five declared review components and nothing else.
 *
 * A diff appears only when both endpoint SHAs were supplied, because a file list
 * without its endpoints cannot be verified against anything. Missing proof and
 * missing reviewer eligibility render UNKNOWN; neither this module nor its copy
 * ever states or implies that the work may be accepted.
 */
export function ReviewSurface(props: ReviewSurfaceProps): JSX.Element {
  const { context, criteria, diff, findings, onProvenance, receipts, reviewer } = props;
  const diffIsAnchored = isSupplied(diff.baseSha) && isSupplied(diff.headSha);
  return (
    <div data-testid="cr.review.surface">
      <Panel heading="Diff" testId="cr.review.diff">
        <FactList
          onProvenance={onProvenance}
          rows={[
            ["review.diff.basesha", "Base SHA", diff.baseSha],
            ["review.diff.headsha", "Head SHA", diff.headSha],
            ["review.diff.dirtytree", "Worktree state", diff.dirtyTree],
          ]}
        />
        {diffIsAnchored ? <DiffPaths paths={diff.paths} /> : <p>{NO_DIFF_WITHOUT_SHAS}</p>}
      </Panel>
      <Panel heading="Criteria" testId="cr.review.criteria">
        <CriteriaList criteria={criteria} onProvenance={onProvenance} />
      </Panel>
      <Panel heading="Receipts" testId="cr.review.receipts">
        <ReceiptList onProvenance={onProvenance} receipts={receipts} />
      </Panel>
      <Panel heading="Findings" testId="cr.review.findings">
        <FindingList findings={findings} onProvenance={onProvenance} />
      </Panel>
      <Panel heading="Graph and plan context" testId="cr.review.context">
        <FactList
          onProvenance={onProvenance}
          rows={[
            ["review.context.graphhash", "Graph hash", context.graphHash],
            ["review.context.planhash", "Plan hash", context.planHash],
            ["review.context.planrevision", "Plan revision", context.planRevision],
            ["review.reviewer.principal", "Reviewer", reviewer.principal],
            ["review.reviewer.independence", "Independence", reviewer.independence],
          ]}
        />
        <FactRow
          absentValue={CALIBRATION_UNMEASURED}
          fact={reviewer.calibration}
          factId="review.reviewer.calibration"
          label="Calibration"
          onProvenance={onProvenance}
        />
      </Panel>
    </div>
  );
}
