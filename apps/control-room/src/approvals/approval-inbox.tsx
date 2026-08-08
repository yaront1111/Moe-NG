import type { NextAllowedCommand } from "@moe/contracts";
import { useState } from "react";
import type { JSX } from "react";

import { FactRow } from "../nodes/node-authority.js";
import type { ProvenanceHandler, SuppliedFact } from "../nodes/node-authority.js";
import { idleConsequence } from "./approval-fixtures.js";
import type { ApprovalDecisionKind, ApprovalDecisionRecord } from "./approval-fixtures.js";
import { resolveApprovalControls } from "./approval-gating.js";
import type { ApprovalControl } from "./approval-gating.js";

/**
 * The single human decision queue (spec §2.6, §4.6).
 *
 * The inbox lists what is waiting and never decides anything: for kinds that own a detail
 * surface it offers [Open] only. Escalation and reconciliation have no detail surface in
 * this spec, so their choices render inline — and strictly from the commands the daemon
 * returned, because their command names are still ⟨TD⟩ (§13-D1). An item with no returned
 * command therefore offers no choice at all rather than a plausible-looking one.
 */
export interface ApprovalInboxItem {
  readonly affordances: readonly NextAllowedCommand[];
  readonly age: SuppliedFact;
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

/** Present only for a project that opted specific R0/R1 action types into policy approval. */
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

/** Kinds the spec gives no detail wireframe; their choices are decided from the inbox. */
const INLINE_CHOICE_KINDS: readonly ApprovalDecisionKind[] = ["ESCALATION", "RECONCILIATION"];

function itemTestId(item: ApprovalInboxItem): string {
  return item.kind === "ESCALATION"
    ? "cr.approvals.item.escalation"
    : `cr.approvals.item.${item.decisionId}`;
}

/**
 * The canonical rendering of one resolved control; every approval surface reuses it.
 *
 * An `ABSENT` verdict renders nothing: the daemon returned neither the command nor a reason,
 * and a disabled control with guessed text is exactly what spec §8.1 forbids. `onActivate`
 * only ever fires for an enabled control, so a refused control cannot reach a handler.
 */
export function DecisionControl(props: {
  readonly control: ApprovalControl;
  readonly onActivate?: ((control: ApprovalControl) => void) | undefined;
}): JSX.Element | null {
  const { control, onActivate } = props;
  if (control.state === "ABSENT") {
    return null;
  }
  const enabled = control.state === "ENABLED" && control.commandId !== null;
  return (
    <span>
      <button
        data-reason-code={control.reasonCode ?? undefined}
        data-refused-by={control.refusedBy ?? undefined}
        data-testid={control.testId}
        disabled={!enabled}
        onClick={enabled && onActivate !== undefined ? () => onActivate(control) : undefined}
        type="button"
      >
        {control.label}
      </button>
      {control.disabledText === null ? null : <span>{control.disabledText}</span>}
    </span>
  );
}

/** Choices for a surface-less kind, derived one-for-one from the returned commands. */
function InlineChoices(props: {
  readonly item: ApprovalInboxItem;
  readonly onDecide?: ((commandId: string) => void) | undefined;
}): JSX.Element {
  const { item, onDecide } = props;
  const controls = resolveApprovalControls({
    affordances: item.affordances,
    record: item.record,
    requests: item.affordances.map((entry) => ({
      commandKind: entry.commandKind,
      label: entry.commandKind,
    })),
    targetAggregateId: item.decisionId,
  });
  return (
    <div>
      {controls.map((control) => (
        <DecisionControl
          control={control}
          key={control.testId}
          onActivate={
            onDecide === undefined
              ? undefined
              : (activated) => onDecide(activated.commandId as string)
          }
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
        factId="approval.risk"
        label="Risk tier"
        onProvenance={onProvenance}
      />
      <FactRow
        fact={item.preconditions}
        factId="approval.preconditions"
        label="Preconditions"
        onProvenance={onProvenance}
      />
      <FactRow fact={item.age} factId="approval.age" label="Age" onProvenance={onProvenance} />
      {idle === null ? null : <p>{`if idle: ${idle}`}</p>}
      {inline ? (
        <InlineChoices item={item} onDecide={onDecide} />
      ) : (
        <button onClick={() => onOpen?.(item.decisionId)} type="button">
          Open
        </button>
      )}
    </li>
  );
}

/**
 * Spec §3.1's `POL` marker. It names the deciding ACTOR, not a fact's truth class: design 701
 * fixes an auto-approval's class at `DAEMON_VERIFIED`, never `HUMAN_APPROVED`. It is therefore
 * rendered outside every `cr.fact.*` wrapper so the "one truth chip per fact" audit still
 * counts real chips exactly (§14-C6 leaves the identity semantics open).
 */
function PolicyBadge(): JSX.Element {
  return (
    <span
      aria-label="POL decided by policy, not by a human"
      data-testid="cr.chip.policy-approved"
    >
      <span aria-hidden="true">◉⚙</span>
      <span>POL</span>
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
      {expanded
        ? records.map((row) => (
          <div data-testid={`cr.approvals.auto.row.${row.approvalRef}`} key={row.approvalRef}>
            <FactRow
              fact={{
                truthClass: row.record.truthClass,
                value: `decided by policy ${policyRevision}, rule ${row.rule}`,
              }}
              factId="approval.policydecision"
              label="Decision"
              onProvenance={onProvenance}
            />
            <PolicyBadge />
          </div>
        ))
        : null}
    </section>
  );
}

/**
 * The approvals surface. A manual-default project renders no automation device at all —
 * absence is the honest representation of "risk-tier automation: OFF", and an invented
 * per-item "manual" badge would be UI the spec does not define.
 */
export function ApprovalInbox(props: ApprovalInboxProps): JSX.Element {
  const { autoGroup, degraded, items, onDecide, onOpen, onProvenance } = props;
  return (
    <section aria-label="Approvals">
      <span aria-live="polite" data-testid="cr.approvals.badge" role="status">
        {`Approvals (${items.length} pending)`}
      </span>
      {items.length === 0 ? (
        <p>Nothing needs you.</p>
      ) : (
        <ul data-testid="cr.approvals.pending">
          {items.map((item) => (
            <InboxItem
              degraded={degraded === true}
              item={item}
              key={item.decisionId}
              onDecide={onDecide}
              onOpen={onOpen}
              onProvenance={onProvenance}
            />
          ))}
        </ul>
      )}
      {autoGroup === undefined ? null : (
        <AutoGroup group={autoGroup} onProvenance={onProvenance} />
      )}
    </section>
  );
}
