import { useState } from "react";
import type { JSX } from "react";
import type { ProductRequirementModel, ProductRequirementState } from "@moe/control-room-model";

const WORDS: Readonly<Record<ProductRequirementState, string>> = {
  NOT_IMPLEMENTED: "No work linked yet", IN_PROGRESS: "Work is planned", IMPLEMENTED_UNCHECKED: "Built, awaiting checks",
  PASSED: "Checks passed", FAILED: "Needs a correction", NEEDS_CHECKING_AGAIN: "Needs checking again", UNKNOWN: "Not yet established",
};

export function ProductRequirements({ requirements, note }: {
  readonly requirements: readonly ProductRequirementModel[]; readonly note: string | null;
}): JSX.Element {
  const [selected, setSelected] = useState<string | null>(null);
  return <section aria-label="Product requirements" className="cr-product-requirements">
    <h2>What you asked for</h2>
    <p>Follow a requirement into the work and checks recorded for this version.</p>
    {requirements.length === 0 ? <p role="status">{note ?? "The requirements for this version are not available yet. Review the proposed definition on the product canvas."}</p> : null}
    {requirements.map((requirement) => <div className="cr-product-requirement" key={requirement.requirementId}>
      <button type="button" aria-expanded={selected === requirement.requirementId}
        onClick={() => setSelected(selected === requirement.requirementId ? null : requirement.requirementId)}>
        <span>{requirement.statement}</span><small data-state={requirement.state}>{WORDS[requirement.state]}</small>
      </button>
      {selected === requirement.requirementId ? <div className="cr-product-requirement-detail">
        {requirement.criteria.map((criterion) => <section key={criterion.criterionId}>
          <h3>{criterion.statement}</h3><p>{WORDS[criterion.state]}</p>
          <p>{criterion.implementationNodes.length === 0 ? "No implementation link is recorded." : "Linked implementation work is recorded."}</p>
          {criterion.receiptIds.length > 0 ? <p>{criterion.receiptIds.length} recorded check result(s).</p> : null}
          <details><summary>Inspect evidence references</summary>
            <dl><dt>Criterion</dt><dd>{criterion.criterionId}</dd>
              <dt>Work</dt><dd>{criterion.implementationNodes.join(", ") || "None"}</dd>
              <dt>Check receipts</dt><dd>{criterion.receiptIds.join(", ") || "None"}</dd></dl>
          </details>
        </section>)}
        <p className="cr-product-note">{requirement.relationshipNote}</p>
      </div> : null}
    </div>)}
  </section>;
}
