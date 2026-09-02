import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import type {
  CoverageContractView, CoverageCriterionView, DocumentCoverageOutcome,
} from "../../live/live-document-coverage.js";
import { MIDDOT } from "../glyphs.js";

/**
 * PRD COVERAGE: how much of the opened goal's PRD is built, as the daemon can prove it.
 *
 * Every number here is the daemon's own join over its durable ledger - contracts citing the
 * document, the criteria their requirements carry, the sealed node each criterion is bound
 * to, and the acceptance the node's review ledger holds. VERIFIED is the daemon's verifier
 * receipt consumed by `integration.accept_output`, nothing softer. The card never computes
 * a verdict of its own: "complete" is spelled out as exactly the facts that make it so, and
 * closing the goal stays the operator's decision.
 *
 * The section map is the daemon's ADVISORY citation walk over the PRD prose and is labelled
 * as such; it helps a human find the parts of the document no requirement cites yet.
 */

const DEFAULT_POLL_MS = 5_000;

export interface PrdCoverageProps {
  readonly goalId: string;
  /** Re-read cadence; the coverage moves whenever a node is accepted. */
  readonly pollMs?: number | undefined;
  readonly read: (goalId: string) => Promise<DocumentCoverageOutcome>;
}

type LoadState =
  | { readonly phase: "LOADING" }
  | { readonly outcome: DocumentCoverageOutcome; readonly phase: "LOADED" };

type Coverage = Extract<DocumentCoverageOutcome, { status: "COVERAGE" }>;

/** Complete = every criterion VERIFIED and every citing contract past Gate 1; never vacuous. */
export function coverageComplete(coverage: Coverage): boolean {
  return coverage.totals.criteria > 0
    && coverage.totals.verified === coverage.totals.criteria
    && coverage.contracts.every((contract) => contract.gate1 === "APPROVED");
}

export function coverageBanner(coverage: Coverage): string {
  const { contracts, criteria, planned, verified } = coverage.totals;
  if (criteria === 0) {
    return contracts === 0
      ? "No Product Contract cites this PRD yet. Coverage starts once one is proposed."
      : "The contract carries no acceptance criteria yet.";
  }
  if (coverageComplete(coverage)) {
    return `All ${criteria} acceptance criteria VERIFIED by the daemon's verifier`
      + ` ${MIDDOT} ${contracts} contract${contracts === 1 ? "" : "s"} approved.`
      + " The PRD is built as far as its contract states it. Closing the goal is your call.";
  }
  const unplanned = criteria - verified - planned;
  return `${verified} of ${criteria} acceptance criteria VERIFIED ${MIDDOT} ${planned} planned`
    + ` ${MIDDOT} ${unplanned} unplanned`
    + (coverage.contracts.some((contract) => contract.gate1 === "PENDING")
      ? ` ${MIDDOT} a contract still awaits Gate 1` : "");
}

function CriterionRow({ criterion }: { readonly criterion: CoverageCriterionView }): JSX.Element {
  return (
    <li
      className="cr2-coverage-criterion"
      data-status={criterion.status}
      data-testid={`cr.coverage.criterion.${criterion.criterionId}`}
    >
      <span className="cr2-coverage-status">{criterion.status}</span>
      <span className="cr2-approve-mono">{criterion.criterionId}</span>
      <span className="cr2-approve-step-body">
        {criterion.statement}
        {criterion.nodeKey === null ? "" : ` ${MIDDOT} ${criterion.nodeKey}`}
      </span>
    </li>
  );
}

function ContractBlock({ contract }: { readonly contract: CoverageContractView }): JSX.Element {
  return (
    <section className="cr2-approve-block" data-testid={`cr.coverage.contract.${contract.contractId}`}>
      <h3 className="cr2-approve-heading">
        {`CONTRACT ${MIDDOT} ${contract.contractId} ${MIDDOT} ${contract.revisionId}`
          + ` ${MIDDOT} GATE 1 ${contract.gate1}`}
      </h3>
      <ul className="cr2-approve-obligations">
        {contract.requirements.map((requirement) => (
          <li
            className="cr2-approve-obligation"
            data-testid={`cr.coverage.requirement.${requirement.requirementId}`}
            key={requirement.requirementId}
          >
            <span className="cr2-approve-mono">{requirement.requirementId}</span>
            <span className="cr2-approve-step-body">{requirement.statement}</span>
            <ul className="cr2-coverage-criteria">
              {requirement.criteria.map((criterion) => (
                <CriterionRow criterion={criterion} key={criterion.criterionId} />
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}

function CoverageBody({ coverage }: { readonly coverage: Coverage }): JSX.Element {
  const { criteria, verified } = coverage.totals;
  const percent = criteria === 0 ? 0 : Math.round((verified / criteria) * 100);
  const complete = coverageComplete(coverage);
  const cited = coverage.sections?.filter((section) => section.cited > 0).length ?? null;
  return (
    <div className="cr2-approve-body" data-testid="cr.coverage.body">
      <p
        className="cr2-approve-banner"
        data-complete={complete ? "true" : "false"}
        data-reviewable={complete ? "true" : undefined}
        data-testid="cr.coverage.banner"
      >
        {coverageBanner(coverage)}
      </p>
      <div
        aria-label="acceptance criteria verified"
        aria-valuemax={criteria}
        aria-valuemin={0}
        aria-valuenow={verified}
        className="cr2-coverage-bar"
        data-testid="cr.coverage.bar"
        role="progressbar"
      >
        <span style={{ width: `${percent}%` }} />
      </div>
      <p className="cr2-approve-heading" data-testid="cr.coverage.document">
        {`${coverage.document.displayPath ?? coverage.document.contentSha256}`
          + (coverage.document.byteLength === null ? "" : ` ${MIDDOT} ${coverage.document.byteLength} bytes`)
          + ` ${MIDDOT} ${coverage.totals.goals} goal${coverage.totals.goals === 1 ? "" : "s"}`
          + ` ${MIDDOT} ${coverage.totals.requirements} requirements`
          + (cited === null
            ? "" : ` ${MIDDOT} ${cited} of ${coverage.sections?.length ?? 0} PRD sections cited`)}
      </p>
      {coverage.contracts.map((contract) => (
        <ContractBlock contract={contract} key={`${contract.contractId} ${contract.revisionId}`} />
      ))}
      {coverage.sections === null ? null : (
        <details className="cr2-approve-inspect" data-testid="cr.coverage.sections">
          <summary className="cr2-approve-inspect-summary">
            {`PRD sections ${MIDDOT} advisory, from requirement citations`}
          </summary>
          <ul className="cr2-approve-obligations">
            {coverage.sections.map((section, index) => (
              <li
                className="cr2-coverage-section"
                data-cited={section.cited === 0 ? "false" : "true"}
                data-testid={`cr.coverage.section.${section.number ?? `h${index}`}`}
                key={`${index}:${section.heading}`}
              >
                <span className="cr2-approve-step-body">{section.heading}</span>
                <span className="cr2-approve-mono">
                  {`cited ${section.cited} ${MIDDOT} verified ${section.verified}`}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function PrdCoverage({ goalId, pollMs, read }: PrdCoverageProps): JSX.Element {
  const [state, setState] = useState<LoadState>({ phase: "LOADING" });
  const generation = useRef(0);

  useEffect(() => {
    const run = generation.current + 1;
    generation.current = run;
    setState({ phase: "LOADING" });
    let inFlight = false;
    const tick = (): void => {
      if (inFlight) return;
      inFlight = true;
      void read(goalId).then((outcome) => {
        inFlight = false;
        if (generation.current === run) setState({ outcome, phase: "LOADED" });
      }, () => {
        inFlight = false;
        if (generation.current === run) {
          setState({ outcome: {
            code: "COVERAGE_READ_FAILED", layer: "CONTROL_ROOM_COVERAGE", status: "ERROR",
          }, phase: "LOADED" });
        }
      });
    };
    tick();
    const timer = setInterval(tick, pollMs ?? DEFAULT_POLL_MS);
    return (): void => { generation.current += 1; clearInterval(timer); };
  }, [goalId, pollMs, read]);

  return (
    <section className="cr2-approve" data-testid="cr.coverage.card">
      <p className="cr2-slot-kicker">{`PRD COVERAGE ${MIDDOT} ${goalId}`}</p>
      {state.phase === "LOADING" ? (
        <p className="cr2-slot-kicker" data-testid="cr.coverage.loading">Reading coverage...</p>
      ) : state.outcome.status === "COVERAGE" ? (
        <CoverageBody coverage={state.outcome} />
      ) : (
        <p className="cr2-approve-refusal" data-testid="cr.coverage.refusal">
          {`${state.outcome.status} ${MIDDOT} ${state.outcome.code} ${MIDDOT} ${state.outcome.layer}`}
        </p>
      )}
    </section>
  );
}
