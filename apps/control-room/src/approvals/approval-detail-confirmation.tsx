import type { RuntimeCommandKind } from "@moe/contracts";
import { useState } from "react";
import type { JSX } from "react";

import { FactRow } from "../nodes/node-authority.js";
import { CUTOVER_PROVISIONAL_NOTE } from "./approval-fixtures.js";
import type { CutoverConsequence } from "./approval-fixtures.js";
import { resolveApprovalControls } from "./approval-gating.js";
import type { ApprovalControl } from "./approval-gating.js";
import {
  DecisionActions,
  DecisionHeader,
  IdleLine,
  ReasonModal,
} from "./approval-detail-plan.js";
import type { DecisionSurfaceProps } from "./approval-detail-plan.js";

/**
 * Confirmation decisions: revocation confirmation (spec §8.2/§9) and the two cutover gates.
 *
 * ⟨TD⟩ / PROVISIONAL: the control-room spec contains NO cutover text at all. The cutover
 * surfaces here are derived from the system design's consequence frame — exact stored hash,
 * disposition, funding reservation, planning-fence membership, deadline, release action,
 * consequence payload — rendered under the §9 destructive-modal pattern. They therefore
 * claim no spec-declared component test IDs, carry a visible provisional note, and expose no
 * idle-consequence line, because §8.10 defines none for them and inventing one would be a
 * fabricated consequence claim.
 *
 * Command routing is SUPPLIED, never guessed: decision-kind routing is unratified (§13-D1),
 * so the caller passes the command kind the daemon actually offered rather than this module
 * choosing between `approval.decide` and `cutover.*`.
 */
export type ConfirmationKind = "REVOCATION_CONFIRMATION" | "CUTOVER_QUIESCE" | "CUTOVER_ACTIVATE";

export interface ApprovalDetailConfirmationProps extends DecisionSurfaceProps {
  readonly auditEvent: string;
  readonly commandKind: RuntimeCommandKind;
  /** Design-derived; present for the cutover gates, absent for revocation confirmation. */
  readonly consequence?: CutoverConsequence | undefined;
  readonly confirmLabel: string;
  readonly kind: ConfirmationKind;
  readonly scope: string;
  readonly subject: string;
}

const CONSEQUENCE_FIELDS: readonly (readonly [keyof CutoverConsequence, string, string])[] = [
  ["exactStoredHash", "consequence.storedhash", "Exact stored hash"],
  ["disposition", "consequence.disposition", "Disposition"],
  ["fundingReservation", "consequence.funding", "Funding reservation"],
  ["planningFenceMembership", "consequence.fence", "Planning-fence membership"],
  ["deadline", "consequence.deadline", "Deadline"],
  ["releaseAction", "consequence.release", "Release action"],
  ["consequencePayload", "consequence.payload", "Consequence payload"],
];

function ConsequenceFrame(props: {
  readonly consequence: CutoverConsequence;
  readonly onProvenance?: DecisionSurfaceProps["onProvenance"];
  readonly truthClass: unknown;
}): JSX.Element {
  const { consequence, onProvenance, truthClass } = props;
  return (
    <div data-provisional="true">
      <h3>Consequences</h3>
      <p>{CUTOVER_PROVISIONAL_NOTE}</p>
      {CONSEQUENCE_FIELDS.map(([field, factId, label]) => (
        <FactRow
          fact={{ truthClass, value: consequence[field] }}
          factId={`approval.${factId}`}
          key={factId}
          label={label}
          onProvenance={onProvenance}
        />
      ))}
    </div>
  );
}

/**
 * A confirmation is destructive by definition, so the decision never lands on the button:
 * activating the control opens the §9 modal, and only a supplied reason confirms it.
 */
export function ApprovalDetailConfirmation(
  props: ApprovalDetailConfirmationProps,
): JSX.Element {
  const { consequence, kind, onDecide, onProvenance, reasons, record, subject } = props;
  const [pending, setPending] = useState<ApprovalControl | null>(null);
  const controls = resolveApprovalControls({
    affordances: props.affordances,
    reasons: reasons ?? {},
    record,
    requests: [{ commandKind: props.commandKind, destructive: true, label: props.confirmLabel }],
    targetAggregateId: props.targetAggregateId,
  });
  return (
    <section aria-label={props.confirmLabel}>
      <DecisionHeader
        onProvenance={onProvenance}
        record={record}
        title={`${props.confirmLabel} · ${subject}`}
      />
      {consequence === undefined ? null : (
        <ConsequenceFrame
          consequence={consequence}
          onProvenance={onProvenance}
          truthClass={record.truthClass}
        />
      )}
      <IdleLine kind={kind} />
      <DecisionActions controls={controls} onActivate={(control) => setPending(control)} />
      {pending === null ? null : (
        <ReasonModal
          auditEvent={props.auditEvent}
          body={`${props.confirmLabel} on ${subject}? This is recorded against your identity `
            + "and cannot be undone from this surface."}
          confirmLabel={props.confirmLabel}
          onCancel={() => setPending(null)}
          onConfirm={(reason) => {
            onDecide?.({ commandId: pending.commandId as string, decision: "APPROVE", reason });
            setPending(null);
          }}
          scope={props.scope}
          title={`${props.confirmLabel} — ${subject}`}
        />
      )}
    </section>
  );
}
