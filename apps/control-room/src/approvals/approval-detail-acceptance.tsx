import { useState } from "react";
import type { JSX } from "react";

import { FactRow } from "../nodes/node-authority.js";
import type { SuppliedFact } from "../nodes/node-authority.js";
import { resolveApprovalControls } from "./approval-gating.js";
import type { ApprovalControl } from "./approval-gating.js";
import {
  DecisionActions,
  DecisionHeader,
  IdleLine,
  ReasonModal,
  abbreviateHash,
} from "./approval-detail-plan.js";
import type { DecisionSurfaceProps } from "./approval-detail-plan.js";

/**
 * Approval detail — acceptance (spec §4.9). The HUMAN acceptance surface, distinct from the
 * agent reviewer's working surface (§10.1) even though it shows the same diff and receipt.
 *
 * Accept and decline both route through `approval.decide` (§4.9; kind routing ⟨TD⟩ per
 * §13-D1). Nothing here judges the evidence: the distinct-principal check, the receipt, and
 * the findings count are all daemon claims rendered with the class the daemon assigned them.
 */
export interface AcceptanceDiff {
  readonly baseSha: SuppliedFact;
  readonly fileCount: SuppliedFact;
  readonly headSha: SuppliedFact;
  readonly inScope: SuppliedFact;
}

export interface AcceptanceReceipt {
  readonly digest: SuppliedFact;
  readonly exitCode: SuppliedFact;
  readonly recipe: SuppliedFact;
  readonly time: SuppliedFact;
}

export interface AcceptanceReview {
  readonly distinctPrincipal: SuppliedFact;
  readonly findings: SuppliedFact;
  readonly reviewer: SuppliedFact;
}

export interface ApprovalDetailAcceptanceProps extends DecisionSurfaceProps {
  readonly diff: AcceptanceDiff;
  readonly node: string;
  readonly receipt: AcceptanceReceipt;
  readonly reopenBound: number;
  readonly reopenCount: number;
  readonly review: AcceptanceReview;
}

export function ApprovalDetailAcceptance(props: ApprovalDetailAcceptanceProps): JSX.Element {
  const { diff, node, onDecide, onProvenance, reasons, receipt, record, review } = props;
  const [pending, setPending] = useState<ApprovalControl | null>(null);
  const controls = resolveApprovalControls({
    affordances: props.affordances,
    reasons: reasons ?? {},
    record,
    requests: [
      { commandKind: "approval.decide", label: "Accept work", qualifier: "accept" },
      {
        commandKind: "approval.decide",
        destructive: true,
        label: "Decline acceptance…",
        qualifier: "decline",
      },
    ],
    targetAggregateId: props.targetAggregateId,
  });
  return (
    <section aria-label="Accept work">
      <DecisionHeader onProvenance={onProvenance} record={record} title={`Accept work · ${node}`} />
      <div data-testid="cr.approvals.acceptance.diff">
        <h3>Diff</h3>
        <FactRow fact={diff.baseSha} factId="approval.diff.base" label="Base" onProvenance={onProvenance} />
        <FactRow fact={diff.headSha} factId="approval.diff.head" label="Head" onProvenance={onProvenance} />
        <FactRow fact={diff.fileCount} factId="approval.diff.files" label="Files" onProvenance={onProvenance} />
        <FactRow fact={diff.inScope} factId="approval.diff.inscope" label="In scope" onProvenance={onProvenance} />
      </div>
      <div data-testid="cr.approvals.acceptance.receipt">
        <h3>Receipt</h3>
        <FactRow fact={receipt.recipe} factId="approval.receipt.recipe" label="Recipe" onProvenance={onProvenance} />
        <FactRow fact={receipt.exitCode} factId="approval.receipt.exit" label="Exit code" onProvenance={onProvenance} />
        <FactRow fact={receipt.time} factId="approval.receipt.time" label="Time" onProvenance={onProvenance} />
        <FactRow fact={receipt.digest} factId="approval.receipt.digest" label="Digest" onProvenance={onProvenance} />
      </div>
      <div data-testid="cr.approvals.acceptance.review">
        <h3>Review</h3>
        <FactRow fact={review.reviewer} factId="approval.review.reviewer" label="Reviewer" onProvenance={onProvenance} />
        <FactRow
          fact={review.distinctPrincipal}
          factId="approval.review.distinct"
          label="Distinct principal"
          onProvenance={onProvenance}
        />
        <FactRow fact={review.findings} factId="approval.review.findings" label="Findings" onProvenance={onProvenance} />
      </div>
      <IdleLine kind="ACCEPTANCE" />
      <DecisionActions
        controls={controls}
        onActivate={(control) => {
          if (control.testId.endsWith(".decline")) setPending(control);
          else {
            onDecide?.({
              commandId: control.commandId as string, decision: "APPROVE", reason: null,
            });
          }
        }}
      />
      {pending === null ? null : (
        <ReasonModal
          auditEvent="approval.decide"
          body={"The work is not merged. The node returns to PLANNING with your reason as a "
            + `carried finding, counting toward its reopen bound (${props.reopenCount} of `
            + `${props.reopenBound}).`}
          confirmLabel="Decline acceptance"
          onCancel={() => setPending(null)}
          onConfirm={(reason) => {
            onDecide?.({ commandId: pending.commandId as string, decision: "REJECT", reason });
            setPending(null);
          }}
          scope={`work on ${node} at revision ${abbreviateHash(record.exactRevisionHash)}`}
          title={`Decline acceptance — ${node}`}
        />
      )}
    </section>
  );
}
