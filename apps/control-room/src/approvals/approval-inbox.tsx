import type { NextAllowedCommand } from "@moe/contracts";
import { useState } from "react";
import type { JSX } from "react";

import { FactList, FactRow } from "../nodes/node-authority.js";
import type {
  FactRowSpec, ProvenanceHandler, SuppliedFact,
} from "../nodes/node-authority.js";
import { idleConsequence } from "./approval-fixtures.js";
import type { ApprovalDecisionKind, ApprovalDecisionRecord } from "./approval-fixtures.js";
import { resolveApprovalControls } from "./approval-gating.js";
import type {
  ApprovalAuthorityContext, ApprovalControl,
} from "./approval-gating.js";

export interface ApprovalInboxItem {
  readonly affordances: readonly NextAllowedCommand[];
  readonly age: SuppliedFact;
  readonly authority?: ApprovalAuthorityContext | undefined;
  readonly decisionId: string;
  readonly kind: ApprovalDecisionKind;
  readonly preconditions: SuppliedFact;
  readonly record: ApprovalDecisionRecord;
  readonly subject: string;
  readonly title: string;
}

export interface AutoApprovalRow {
  readonly approvalRef: string;
  readonly record: ApprovalDecisionRecord;
  readonly rule: string;
}

export interface AutoApprovalGroup {
  readonly policyRevision: string;
  readonly records: readonly AutoApprovalRow[];
}

export interface ApprovalInboxProps {
  readonly autoGroup?: AutoApprovalGroup | undefined;
  readonly degraded?: boolean;
  readonly items: readonly ApprovalInboxItem[];
  readonly onDecide?: ((commandId: string) => void) | undefined;
  readonly onOpen?: ((decisionId: string) => void) | undefined;
  readonly onProvenance?: ProvenanceHandler | undefined;
}

const INLINE_CHOICE_KINDS: readonly ApprovalDecisionKind[] = ["ESCALATION", "RECONCILIATION"];

function itemTestId(item: ApprovalInboxItem): string {
  return item.kind === "ESCALATION"
    ? "cr.approvals.item.escalation"
    : `cr.approvals.item.${item.decisionId}`;
}

function authorityRows(control: ApprovalControl): readonly FactRowSpec[] {
  const authority = control.authority;
  if (authority === null || authority === undefined) return [];
  const prefix = `approval.authority.${control.testId.replace("cr.action.", "")}`;
  const fact = (value: string): SuppliedFact => ({ truthClass: authority.truthClass, value });
  const rows: FactRowSpec[] = [
    [`${prefix}.policy`, "Approval policy", fact(authority.policy.kind)],
  ];
  if (authority.policy.kind === "PROCEED_WITHOUT_HUMAN") {
    rows.push([`${prefix}.delay`, "Policy delay", fact(`${authority.policy.delayMs} ms`)]);
  }
  const { gate, grant } = authority;
  if (gate !== null) {
    rows.push(
      [`${prefix}.gate`, "Authority gate", fact(gate.gateId)],
      [`${prefix}.work`, "Gated work", fact(gate.workRef)],
      [`${prefix}.state`, "Gate state", fact(grant === null ? "UNSATISFIED" : "SATISFIED")],
    );
  }
  if (grant !== null) {
    rows.push(
      [`${prefix}.principal-kind`, "Grant principal kind", fact(grant.principalKind)],
      [`${prefix}.principal-id`, "Grant principal", fact(grant.principalId)],
      [`${prefix}.grant-moment`, "Granted at epoch ms", fact(String(grant.grantedAtEpochMs))],
    );
  }
  return Object.freeze(rows);
}

/** Refused controls cannot activate; absent controls render nothing. */
export function DecisionControl(props: {
  readonly control: ApprovalControl;
  readonly onActivate?: ((control: ApprovalControl) => void) | undefined;
}): JSX.Element | null {
  const { control, onActivate } = props;
  if (control.state === "ABSENT") return null;
  const enabled = control.state === "ENABLED" && control.commandId !== null;
  const facts = authorityRows(control);
  return (
    <span>
      <button
        data-command-id={control.commandId ?? undefined}
        data-reason-code={control.reasonCode ?? undefined}
        data-refused-by={control.refusedBy ?? undefined}
        data-refusing-layer={control.refusingLayer ?? undefined}
        data-testid={control.testId}
        disabled={!enabled}
        onClick={enabled && onActivate !== undefined ? () => onActivate(control) : undefined}
        type="button"
      >
        {control.label}
      </button>
      {control.disabledText === null ? null : <span>{control.disabledText}</span>}
      {facts.length === 0 ? null : <FactList rows={facts} />}
    </span>
  );
}

function InlineChoices(props: {
  readonly item: ApprovalInboxItem;
  readonly onDecide?: ((commandId: string) => void) | undefined;
}): JSX.Element {
  const { item, onDecide } = props;
  const controls = resolveApprovalControls({
    affordances: item.affordances,
    authority: item.authority,
    record: item.record,
    requests: item.affordances.map((entry) => ({
      commandKind: entry.commandKind, label: entry.commandKind,
    })),
    targetAggregateId: item.decisionId,
  });
  return (
    <div>
      {controls.map((control) => (
        <DecisionControl
          control={control}
          key={control.testId}
          onActivate={onDecide === undefined
            ? undefined
            : (activated) => onDecide(activated.commandId as string)}
        />
      ))}
    </div>
  );
}

function InboxItem(props: {
  readonly degraded: boolean;
  readonly item: ApprovalInboxItem;
  readonly onDecide?: ((commandId: string) => void) | undefined;
  readonly onOpen?: ((decisionId: string) => void) | undefined;
  readonly onProvenance?: ProvenanceHandler | undefined;
}): JSX.Element {
  const { degraded, item, onDecide, onOpen, onProvenance } = props;
  const idle = idleConsequence(item.kind);
  const inline = INLINE_CHOICE_KINDS.includes(item.kind);
  return (
    <li data-testid={itemTestId(item)}>
      <h3>{item.title}</h3>
      {degraded ? <span>may be stale</span> : null}
      <FactRow
        fact={{ truthClass: item.record.truthClass, value: item.record.riskTier }}
        factId="approval.risk" label="Risk tier" onProvenance={onProvenance}
      />
      <FactRow
        fact={item.preconditions} factId="approval.preconditions"
        label="Preconditions" onProvenance={onProvenance}
      />
      <FactRow fact={item.age} factId="approval.age" label="Age" onProvenance={onProvenance} />
      {idle === null ? null : <p>{`if idle: ${idle}`}</p>}
      {inline
        ? <InlineChoices item={item} onDecide={onDecide} />
        : <button onClick={() => onOpen?.(item.decisionId)} type="button">Open</button>}
    </li>
  );
}

function PolicyBadge(): JSX.Element {
  return (
    <span aria-label="POL decided by policy, not by a human" data-testid="cr.chip.policy-approved">
      <span aria-hidden="true">◉⚙</span><span>POL</span>
    </span>
  );
}

function AutoGroup(props: {
  readonly group: AutoApprovalGroup;
  readonly onProvenance?: ProvenanceHandler | undefined;
}): JSX.Element {
  const { group, onProvenance } = props;
  const [expanded, setExpanded] = useState(false);
  const { policyRevision, records } = group;
  return (
    <section data-testid="cr.approvals.auto">
      <button aria-expanded={expanded} onClick={() => setExpanded(!expanded)} type="button">
        {`Decided by policy (${records.length}) — auto-approved under rev ${policyRevision} `
          + "(project opted in)"}
      </button>
      {expanded ? records.map((row) => (
        <div data-testid={`cr.approvals.auto.row.${row.approvalRef}`} key={row.approvalRef}>
          <FactRow
            fact={{
              truthClass: row.record.truthClass,
              value: `decided by policy ${policyRevision}, rule ${row.rule}`,
            }}
            factId="approval.policydecision" label="Decision" onProvenance={onProvenance}
          />
          <PolicyBadge />
        </div>
      )) : null}
    </section>
  );
}

export function ApprovalInbox(props: ApprovalInboxProps): JSX.Element {
  const { autoGroup, degraded, items, onDecide, onOpen, onProvenance } = props;
  return (
    <section aria-label="Approvals">
      <span aria-live="polite" data-testid="cr.approvals.badge" role="status">
        {`Approvals (${items.length} pending)`}
      </span>
      {items.length === 0 ? <p>Nothing needs you.</p> : (
        <ul data-testid="cr.approvals.pending">
          {items.map((item) => (
            <InboxItem
              degraded={degraded === true} item={item} key={item.decisionId}
              onDecide={onDecide} onOpen={onOpen} onProvenance={onProvenance}
            />
          ))}
        </ul>
      )}
      {autoGroup === undefined ? null : <AutoGroup group={autoGroup} onProvenance={onProvenance} />}
    </section>
  );
}
