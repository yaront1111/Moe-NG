import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import type {
  CoverageContractView, CoverageCriterionView, CoverageRequirementView,
  DocumentCoverageOutcome,
} from "../../live/live-document-coverage.js";
import { OutcomeNote } from "../components/outcome-note.js";
import { MIDDOT } from "../glyphs.js";
import { readFailedSaid } from "../outcome-words.js";
import { contractGateKey, useContractGates } from "./contract-gates.js";
import type { ContractGateMap, Gate1Reader } from "./contract-gates.js";

/**
 * THE APPROVED PRODUCT CONTRACT, ON THE GOAL THAT IS BUILDING IT.
 *
 * Two daemon answers meet here and neither substitutes for the other. The coverage read
 * states WHAT the contract asks for - its revision identity, its requirements, and every
 * acceptance criterion with the coverage state the daemon can prove. The Gate 1 read states
 * WHETHER a named human actually approved that exact revision, derived from the stored grant
 * rather than from the join. The coverage column is the load-bearing one: the operator can
 * already read the contract, what they cannot see anywhere else is which of its criteria are
 * genuinely covered.
 *
 * NOTHING HERE IS EVER RENDERED AS EMPTINESS. A refused read renders its code and layer
 * verbatim; a genuinely empty answer renders words that say it is empty. An empty
 * requirements list shown for a refused read would read to an operator as "this contract
 * asks for nothing", which is a different and false claim.
 */

const DEFAULT_POLL_MS = 10_000;

export interface ContractDossierProps {
  readonly coverage: DocumentCoverageOutcome | null;
  readonly gates: ContractGateMap;
}

function CriterionRow({ criterion }: { readonly criterion: CoverageCriterionView }): JSX.Element {
  return (
    <li
      className="cr2-coverage-criterion"
      data-status={criterion.status}
      data-testid={`cr.contract.criterion.${criterion.criterionId}`}
    >
      <span className="cr2-coverage-status">{criterion.status === "EVIDENCE_REQUIRED" ? "Evidence required" : criterion.status}</span>
      <span className="cr2-approve-mono">{criterion.criterionId}</span>
      <span className="cr2-approve-step-body">
        {criterion.statement}
        {criterion.nodeKey === null ? "" : ` ${MIDDOT} ${criterion.nodeKey}`}
        {criterion.nodeTestStatus === "NODE_TEST_PASSED" ? ` ${MIDDOT} Node test passed` : ""}
      </span>
    </li>
  );
}

function RequirementRow(
  { requirement }: { readonly requirement: CoverageRequirementView },
): JSX.Element {
  return (
    <li
      className="cr2-approve-obligation"
      data-testid={`cr.contract.requirement.${requirement.requirementId}`}
    >
      <span className="cr2-approve-mono">{requirement.requirementId}</span>
      <span className="cr2-approve-step-body">{requirement.statement}</span>
      {requirement.criteria.length === 0 ? (
        <p
          className="cr2-needs-note"
          data-testid={`cr.contract.requirement.${requirement.requirementId}.nocriteria`}
        >
          This requirement carries no acceptance criterion yet.
        </p>
      ) : (
        <ul className="cr2-coverage-criteria">
          {requirement.criteria.map((criterion) => (
            <CriterionRow criterion={criterion} key={criterion.criterionId} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** The DURABLE Gate 1 answer for one revision triple, or the words for not having one yet. */
function Gate1Verdict({ contract, gates }: {
  readonly contract: CoverageContractView;
  readonly gates: ContractGateMap;
}): JSX.Element {
  const outcome = gates.get(contractGateKey(contract));
  const testId = `cr.contract.gate1.${contract.contractId}`;
  if (outcome === undefined) {
    return (
      <p className="cr2-slot-kicker" data-testid={`${testId}.reading`} role="status">
        Reading the Gate 1 verdict...
      </p>
    );
  }
  if (outcome.status === "GATE") {
    return (
      <p className="cr2-approve-banner" data-testid={testId}>
        {`Gate 1 approved by a named human ${MIDDOT} approved revision ${contract.revisionId}`
          + ` ${MIDDOT} digest ${outcome.revisionDigest}`}
      </p>
    );
  }
  return (
    <OutcomeNote
      code={outcome.code}
      layer={outcome.layer}
      said={readFailedSaid("Gate 1 verdict for this revision")}
      testId={`${testId}.refusal`}
    />
  );
}

function ContractBlock({ contract, gates }: {
  readonly contract: CoverageContractView;
  readonly gates: ContractGateMap;
}): JSX.Element {
  const criteria = contract.requirements.reduce((sum, row) => sum + row.criteria.length, 0);
  return (
    <section
      className="cr2-approve-block"
      data-testid={`cr.contract.block.${contract.contractId}`}
    >
      <h3 className="cr2-approve-heading">
        {`CONTRACT ${MIDDOT} ${contract.contractId} ${MIDDOT} revision ${contract.revisionId}`
          + ` ${MIDDOT} ${contract.plane}`}
      </h3>
      <Gate1Verdict contract={contract} gates={gates} />
      <p
        className="cr2-approve-heading"
        data-testid={`cr.contract.counts.${contract.contractId}`}
      >
        {`${contract.requirements.length} requirements ${MIDDOT} ${criteria} acceptance`
          + ` criteria ${MIDDOT} each with its coverage state`}
      </p>
      {contract.requirements.length === 0 ? (
        <p className="cr2-needs-note" data-testid={`cr.contract.norequirements.${contract.contractId}`}>
          This revision states no requirement yet.
        </p>
      ) : (
        <ul className="cr2-approve-obligations">
          {contract.requirements.map((requirement) => (
            <RequirementRow key={requirement.requirementId} requirement={requirement} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** PURE. Every state the two reads can be in has its own words; none of them is blankness. */
export function ContractDossier({ coverage, gates }: ContractDossierProps): JSX.Element {
  return (
    <section className="cr2-approve" data-testid="cr.contract.card">
      <p className="cr2-slot-kicker">Product Contract, as approved</p>
      {coverage === null ? (
        <p className="cr2-slot-kicker" data-testid="cr.contract.loading" role="status">
          Reading the contract...
        </p>
      ) : coverage.status !== "COVERAGE" ? (
        <OutcomeNote
          code={coverage.code}
          layer={coverage.layer}
          said={readFailedSaid("Product Contract")}
          testId="cr.contract.refusal"
        />
      ) : coverage.contracts.length === 0 ? (
        <p className="cr2-needs-note" data-testid="cr.contract.none">
          No Product Contract cites this PRD yet.
        </p>
      ) : (
        <div className="cr2-approve-body" data-testid="cr.contract.body">
          {coverage.contracts.map((contract) => (
            <ContractBlock
              contract={contract}
              gates={gates}
              key={contractGateKey(contract)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export interface LiveContractDossierProps {
  readonly goalId: string;
  readonly pollMs?: number | undefined;
  readonly readCoverage: (goalId: string) => Promise<DocumentCoverageOutcome>;
  readonly readGate: Gate1Reader | undefined;
}

/**
 * Reads coverage on the goal, then one Gate 1 verdict per cited revision. A coverage read
 * that throws becomes a visible ERROR outcome, never a silent empty dossier.
 */
export function LiveContractDossier(
  { goalId, pollMs, readCoverage, readGate }: LiveContractDossierProps,
): JSX.Element {
  const [coverage, setCoverage] = useState<DocumentCoverageOutcome | null>(null);
  const gates = useContractGates(coverage, readGate);
  const generation = useRef(0);
  useEffect(() => {
    const run = generation.current + 1;
    generation.current = run;
    setCoverage(null);
    let inFlight = false;
    const tick = (): void => {
      if (inFlight) return;
      inFlight = true;
      void readCoverage(goalId).then((outcome) => {
        inFlight = false;
        if (generation.current === run) setCoverage(outcome);
      }, () => {
        inFlight = false;
        if (generation.current === run) {
          setCoverage({
            code: "CONTRACT_DOSSIER_COVERAGE_READ_FAILED",
            layer: "CONTROL_ROOM_GOALS",
            status: "ERROR",
          });
        }
      });
    };
    tick();
    const timer = setInterval(tick, pollMs ?? DEFAULT_POLL_MS);
    return (): void => { generation.current += 1; clearInterval(timer); };
  }, [goalId, pollMs, readCoverage]);
  return <ContractDossier coverage={coverage} gates={gates} />;
}
