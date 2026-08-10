import type { NextAllowedCommand } from "@moe/contracts";
import { useState } from "react";
import type { JSX } from "react";

import { FactRow } from "../nodes/node-authority.js";
import type { ProvenanceHandler, SuppliedFact } from "../nodes/node-authority.js";
import { idleConsequence } from "./approval-fixtures.js";
import "./approval-layout.css";
import type {
  ApprovalDecision,
  ApprovalDecisionKind,
  ApprovalDecisionRecord,
} from "./approval-fixtures.js";
import { resolveApprovalControls } from "./approval-gating.js";
import type { ApprovalControl, ApprovalReason } from "./approval-gating.js";
import { DecisionControl } from "./approval-inbox.js";
import { ReasonModal } from "./approval-reason-modal.js";

export { ReasonModal };
export type { ReasonModalProps } from "./approval-reason-modal.js";

/**
 * Approval detail — plan (spec §4.7), and the shared frame every decision surface reuses.
 *
 * This module is the canonical decision surface, so the pieces the other three kinds need —
 * the identity header, the idle line, the §9 destructive-reason modal — live here and are
 * imported in one direction only. Delta re-approval (§8.4) is a MODE of this surface rather
 * than a separate one: the same plan, reviewed against a superseding revision.
 */
export type DecideHandler = (input: {
  readonly commandId: string;
  readonly decision: ApprovalDecision;
  readonly reason: string | null;
}) => void;

export interface DecisionSurfaceProps {
  readonly affordances: readonly NextAllowedCommand[];
  readonly onDecide?: DecideHandler | undefined;
  readonly onProvenance?: ProvenanceHandler | undefined;
  readonly reasons?: Readonly<Record<string, ApprovalReason>> | undefined;
  readonly record: ApprovalDecisionRecord;
  readonly targetAggregateId: string;
}

/** Display-only shortening. The full hash stays in the DOM as the element's title. */
export function abbreviateHash(hash: string): string {
  return hash.length <= 8 ? hash : `${hash.slice(0, 8)}…`;
}

type HeaderFact = readonly [
  factId: string, label: string, read: (record: ApprovalDecisionRecord) => string | null,
];

/** The identity every decision is judged against, in the order §4.7-§4.9 present it. */
const HEADER_FACTS: readonly HeaderFact[] = [
  ["approval.risk", "Risk tier", (record) => record.riskTier],
  ["approval.revisionhash", "Exact revision hash", (record) => record.exactRevisionHash],
  ["approval.scope", "Approved scope", (record) => record.approvedNodeScope.join(", ")],
  ["approval.budget", "Budget", (record) => record.budgetRef],
  ["approval.policy", "Policy", (record) => record.applicablePolicyRef],
  ["approval.stepup", "Step-up authentication", (record) => record.stepUpAuthRef],
];

export function DecisionHeader(props: {
  readonly onProvenance?: ProvenanceHandler | undefined;
  readonly record: ApprovalDecisionRecord;
  readonly title: string;
}): JSX.Element {
  const { onProvenance, record, title } = props;
  return (
    <header data-testid="cr.approvals.detail.header">
      <h2 title={record.exactRevisionHash}>
        {`${title} · revision ${abbreviateHash(record.exactRevisionHash)}`}
      </h2>
      {HEADER_FACTS.map(([factId, label, read]) => {
        const value = read(record);
        return value === null ? null : (
          <FactRow
            fact={{ truthClass: record.truthClass, value }}
            factId={factId}
            key={factId}
            label={label}
            onProvenance={onProvenance}
          />
        );
      })}
    </header>
  );
}

export function IdleLine({ kind }: { readonly kind: ApprovalDecisionKind }): JSX.Element | null {
  const idle = idleConsequence(kind);
  return idle === null ? null : <p>{`if idle: ${idle}`}</p>;
}

export interface DecisionActionsProps {
  readonly controls: readonly ApprovalControl[];
  readonly onActivate: (control: ApprovalControl) => void;
}

/** Pinned to the end of the surface so §4.16's narrow layout keeps the buttons reachable. */
export function DecisionActions(props: DecisionActionsProps): JSX.Element {
  const { controls, onActivate } = props;
  return (
    <div data-pinned="true" data-testid="cr.approvals.detail.actions">
      {controls.map((control) => (
        <DecisionControl control={control} key={control.testId} onActivate={onActivate} />
      ))}
    </div>
  );
}

export interface PlanDelta {
  readonly supersededHash: string;
  readonly unchangedSteps: number;
}

export interface ApprovalDetailPlanProps extends DecisionSurfaceProps {
  readonly delta?: PlanDelta | undefined;
  readonly node: string;
  readonly objective: SuppliedFact;
  readonly oracle: SuppliedFact;
  readonly recipeValid: SuppliedFact;
  readonly steps: readonly string[];
  readonly writeScope: SuppliedFact;
}

export function ApprovalDetailPlan(props: ApprovalDetailPlanProps): JSX.Element {
  const { delta, node, objective, oracle, onDecide, onProvenance, reasons, record } = props;
  const [pending, setPending] = useState<ApprovalControl | null>(null);
  const [expanded, setExpanded] = useState(false);
  const controls = resolveApprovalControls({
    affordances: props.affordances,
    reasons: reasons ?? {},
    record,
    requests: [
      { commandKind: "approval.decide", label: "Approve plan", qualifier: "approve" },
      { commandKind: "approval.decide", destructive: true, label: "Reject plan…", qualifier: "reject" },
    ],
    targetAggregateId: props.targetAggregateId,
  });
  const newHash = abbreviateHash(record.exactRevisionHash);
  return (
    <section aria-label="Approve plan">
      {delta === undefined ? null : (
        <p aria-live="polite" data-testid="cr.banner.invalidated">
          {"Your approval of "}
          <span style={{ textDecoration: "line-through" }}>
            {abbreviateHash(delta.supersededHash)}
          </span>
          {` was invalidated by ${newHash} — reviewing only the delta.`}
        </p>
      )}
      <DecisionHeader
        onProvenance={onProvenance}
        record={record}
        title={`Approve plan · ${node}`}
      />
      <FactRow fact={objective} factId="approval.objective" label="Objective" onProvenance={onProvenance} />
      <FactRow fact={props.writeScope} factId="approval.writescope" label="Write scope" onProvenance={onProvenance} />
      <FactRow fact={oracle} factId="approval.oracle" label="Oracle" onProvenance={onProvenance} />
      <FactRow fact={props.recipeValid} factId="approval.recipevalid" label="Recipe" onProvenance={onProvenance} />
      <div data-testid="cr.approvals.plan.steps" style={{ overflowY: "auto" }}>
        {/* Keyed by position: two plan steps may legitimately carry identical text. */}
        <ol>{props.steps.map((step, index) => <li key={`${index}:${step}`}>{step}</li>)}</ol>
      </div>
      {delta === undefined ? null : (
        <button
          aria-expanded={expanded}
          data-testid="cr.approvals.delta.unchanged"
          onClick={() => setExpanded(!expanded)}
          type="button"
        >
          {`${delta.unchangedSteps} steps unchanged — expand`}
        </button>
      )}
      <IdleLine kind="PLAN" />
      <DecisionActions
        controls={controls}
        onActivate={(control) => {
          if (control.testId.endsWith(".reject")) setPending(control);
          else onDecide?.({ commandId: control.commandId as string, decision: "APPROVE", reason: null });
        }}
      />
      {delta === undefined ? null : (
        <p>{`Approving revision ${newHash} (this supersedes your approval of ${abbreviateHash(delta.supersededHash)}).`}</p>
      )}
      {pending === null ? null : (
        <ReasonModal
          auditEvent="approval.decide"
          body={"The plan returns to its author with your reason as a carried finding. "
            + "The node returns to PLANNING."}
          confirmLabel="Reject plan"
          onCancel={() => setPending(null)}
          onConfirm={(reason) => {
            onDecide?.({ commandId: pending.commandId as string, decision: "REJECT", reason });
            setPending(null);
          }}
          scope={`plan revision ${newHash} on ${node}`}
          title={`Reject plan — ${node}`}
        />
      )}
    </section>
  );
}
