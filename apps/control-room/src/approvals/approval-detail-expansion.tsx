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
 * Approval detail — expansion (spec §4.8), the "≤ 1 decision per fan-out" surface.
 *
 * Approval routes through `graph.approve` rather than `approval.decide`: the charter gives
 * expansion/supersession exact-hash decisions to `graph.approve`, and rejection to the
 * ratified `expansion.decline`. Decision-kind routing is still ⟨TD⟩ (§13-D1), so this
 * pairing is PROVISIONAL — but both command names are ratified vocabulary, never invented.
 *
 * Preconditions render ABOVE the subgraph preview, which is also §4.16's narrow-window rule,
 * so one DOM order serves both layouts. Every precondition row is a daemon-checked claim
 * carrying its own truth chip; this surface checks nothing itself.
 */
export type ExpansionPreconditionKey = "scopes" | "oracles" | "budget" | "width";

export interface ExpansionPrecondition {
  readonly detail: SuppliedFact;
  readonly key: ExpansionPreconditionKey;
  readonly label: string;
}

export interface ApprovalDetailExpansionProps extends DecisionSurfaceProps {
  readonly goal: string;
  readonly invalidates: SuppliedFact;
  readonly preconditions: readonly ExpansionPrecondition[];
  readonly subgraph: readonly string[];
  readonly supersedesHash: string;
}

export function ApprovalDetailExpansion(props: ApprovalDetailExpansionProps): JSX.Element {
  const { goal, invalidates, onDecide, onProvenance, preconditions, reasons, record } = props;
  const [pending, setPending] = useState<ApprovalControl | null>(null);
  const controls = resolveApprovalControls({
    affordances: props.affordances,
    reasons: reasons ?? {},
    record,
    requests: [
      { commandKind: "graph.approve", label: "Approve expansion" },
      { commandKind: "expansion.decline", destructive: true, label: "Reject expansion…" },
    ],
    targetAggregateId: props.targetAggregateId,
  });
  const newHash = abbreviateHash(record.exactRevisionHash);
  return (
    <section aria-label="Approve expansion">
      <DecisionHeader
        onProvenance={onProvenance}
        record={record}
        title={`Approve expansion · ${goal} (supersedes ${abbreviateHash(props.supersedesHash)})`}
      />
      <div data-testid="cr.approvals.preconditions">
        <h3>Preconditions (checked by daemon)</h3>
        {preconditions.map((precondition) => (
          <div
            data-testid={`cr.approvals.precondition.${precondition.key}`}
            key={precondition.key}
          >
            <FactRow
              fact={precondition.detail}
              factId={`approval.precondition.${precondition.key}`}
              label={precondition.label}
              onProvenance={onProvenance}
            />
          </div>
        ))}
      </div>
      <div data-testid="cr.approvals.expansion.preview">
        <h3>Subgraph preview</h3>
        <ul>{props.subgraph.map((child, index) => <li key={`${index}:${child}`}>{child}</li>)}</ul>
      </div>
      <FactRow
        fact={invalidates}
        factId="approval.invalidates"
        label="Invalidates"
        onProvenance={onProvenance}
      />
      <IdleLine kind="EXPANSION" />
      <DecisionActions
        controls={controls}
        onActivate={(control) => {
          if (control.commandKind === "expansion.decline") setPending(control);
          else {
            onDecide?.({
              commandId: control.commandId as string, decision: "APPROVE", reason: null,
            });
          }
        }}
      />
      {pending === null ? null : (
        <ReasonModal
          auditEvent="expansion.decline"
          body={"The proposed children are not created. The ghost subgraph is dismissed and "
            + "the proposal is recorded with your reason."}
          confirmLabel="Reject expansion"
          onCancel={() => setPending(null)}
          onConfirm={(reason) => {
            onDecide?.({ commandId: pending.commandId as string, decision: "REJECT", reason });
            setPending(null);
          }}
          scope={`revision ${newHash}: ${props.subgraph.length} proposed children under ${goal}`}
          title={`Reject expansion — ${goal}`}
        />
      )}
    </section>
  );
}
