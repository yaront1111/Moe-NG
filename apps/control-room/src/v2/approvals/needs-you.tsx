import { useState } from "react";
import type { JSX } from "react";

import { IncidentCard } from "./incident-card.js";
import { incidentKeyOf } from "./needs-you-incident.js";
import { ActionButton } from "../components/primitives.js";
import { MIDDOT } from "../glyphs.js";
import type { NeedsYouData, NeedsYouItem, NeedsYouKind } from "./needs-you-model.js";
import { PreviewCard } from "./preview-card.js";
import type { PreviewDecision, PreviewFinding } from "./preview-port.js";
import type { OfferOutcome } from "./offer-wire.js";
import { RefusalNote } from "../components/outcome-note.js";

/**
 * The NEEDS YOU queue: one card per decision the daemon is waiting on, in the order a person
 * should take them (an environment INCIDENT first - it is an outage already running - then
 * plans, exhausted reviews, contracts, goals ready to close).
 * Every card names its goal and opens it; a card whose item carries a daemon offer also
 * carries that decision inline, and the daemon's answer is shown beside it at its own layer.
 * Closing a goal is terminal, so its button asks twice (arm, then confirm) and the armed
 * state is the card's own. Otherwise pure: no fetch, no dispatch, no clock.
 */

/** What a decision's port answered for one item, kept beside its card. */
export interface DecisionResult {
  readonly busy: boolean;
  /** Which answer this result belongs to; absent means the card's primary decision. */
  readonly choice?: NeedsYouChoice | undefined;
  readonly outcome: OfferOutcome | null;
}

const REPLAN_DONE_LINE = "Replanned. A successor goal now carries the findings; the planning agent takes it next.";

/** The second answer an exhausted review takes: re-plan the work instead of retrying it. */
export type NeedsYouChoice = "REPLAN";

export interface NeedsYouProps {
  readonly data: NeedsYouData;
  readonly decisionResults?: ReadonlyMap<string, DecisionResult> | undefined;
  /** Spends the daemon's offer this item carries; absent means no inline decision. */
  readonly onDecide?: ((item: NeedsYouItem, choice?: NeedsYouChoice) => void) | undefined;
  /** Drops an INCIDENT item from THIS queue only; absent means the card cannot be dismissed. */
  readonly onDismissIncident?: ((item: NeedsYouItem) => void) | undefined;
  /** Spends the INCIDENT item's `deployment.rollback` offer; absent renders it read-only. */
  readonly onRollback?: ((item: NeedsYouItem) => void) | undefined;
  /** Spends the PREVIEW item's `preview.decide` offer. Absent means the card renders read-only. */
  readonly onPreviewDecide?: ((
    item: NeedsYouItem, decision: PreviewDecision, findings: readonly PreviewFinding[],
  ) => void) | undefined;
  readonly onOpenBoard: (goalId: string, planningRunRef: string, title: string) => void;
}

const KIND_EYEBROW: Readonly<Record<NeedsYouKind, string>> = Object.freeze({
  DEPLOY: "Deploy",
  ESCALATION: "Review exhausted",
  GATE_1: "Product contract",
  INCIDENT: "Incident",
  PLAN_APPROVAL: "Plan",
  PLAN_REJECTED: "Plan sent back",
  PREVIEW: "Gate 2",
  READY_TO_CLOSE: "Ready to close",
  RELEASE: "Gate 3",
});

interface InlineDecision {
  readonly ariaLabel: string;
  readonly armLabel: string | null;
  readonly buttonLabel: string;
  readonly doneLabel: string;
  readonly doneLine: string;
  readonly testId: string;
}

/** The key a decision's result is kept under: the node for an escalation, else the goal. */
export function decisionKeyOf(item: NeedsYouItem): string {
  const incident = item.incident;
  if (incident !== undefined) return incidentKeyOf(incident.environment, incident.incidentId);
  const escalation = item.escalation;
  if (escalation === undefined) return item.goalId;
  const nodeRef = escalation.affordance["targetAggregateId"];
  return typeof nodeRef === "string" && nodeRef.length > 0
    ? nodeRef : JSON.stringify([item.goalId, escalation.nodeKey]);
}

function decisionOf(item: NeedsYouItem): InlineDecision | null {
  if (item.escalation !== undefined) {
    return {
      ariaLabel: `Allow more attempts on ${item.escalation.nodeKey}`,
      armLabel: null,
      buttonLabel: "Allow more attempts",
      doneLabel: "Allowed",
      doneLine: "Allowed. Agents may submit new review rounds for this node.",
      testId: `cr.needsyou.escalate.${decisionKeyOf(item)}`,
    };
  }
  if (item.close !== undefined) {
    return {
      ariaLabel: `Close the goal ${item.title}`,
      armLabel: "Confirm: close the goal",
      buttonLabel: "Close the goal",
      doneLabel: "Closed",
      doneLine: "Closed. The goal is complete and its verified work stays on record.",
      testId: `cr.needsyou.close.${item.goalId}`,
    };
  }
  return null;
}

function resultLine(decision: InlineDecision, result: DecisionResult | undefined): string | null {
  if (result === undefined) return null;
  if (result.busy) return "Recording your decision...";
  if (result.outcome === null || !result.outcome.ok) return null;
  return result.choice === "REPLAN" ? REPLAN_DONE_LINE : decision.doneLine;
}

function DecisionCard({
  item, onDecide, onDismissIncident, onOpenBoard, onPreviewDecide, onRollback, result,
}: {
  readonly item: NeedsYouItem;
  readonly onDecide: NeedsYouProps["onDecide"];
  readonly onDismissIncident: NeedsYouProps["onDismissIncident"];
  readonly onRollback: NeedsYouProps["onRollback"];
  readonly onOpenBoard: NeedsYouProps["onOpenBoard"];
  readonly onPreviewDecide: NeedsYouProps["onPreviewDecide"];
  readonly result: DecisionResult | undefined;
}): JSX.Element {
  const [armed, setArmed] = useState(false);
  const key = decisionKeyOf(item);
  const slug = `${item.kind.toLowerCase().replace(/_/gu, "-")}.${key}`;
  const decision = decisionOf(item);
  const line = decision === null ? null : resultLine(decision, result);
  const done = result?.outcome?.ok === true;
  const replan = item.escalation === undefined ? null : item.escalation;
  return (
    <li className="cr2-needs-card" data-kind={item.kind} data-testid={`cr.needsyou.item.${slug}`}>
      <div className="cr2-needs-main">
        <p className="cr2-slot-kicker">{`${KIND_EYEBROW[item.kind]} ${MIDDOT} ${item.title}`}</p>
        <h2 className="cr2-needs-headline">{item.headline}</h2>
        <p className="cr2-needs-detail">{item.detail}</p>
        {item.incident === undefined ? null : (
          <IncidentCard
            busy={result?.busy === true}
            done={done}
            facts={item.incident}
            onDismiss={onDismissIncident === undefined ? undefined : (): void => onDismissIncident(item)}
            onRollback={onRollback === undefined ? undefined : (): void => onRollback(item)}
          />
        )}
        {item.preview === undefined || onPreviewDecide === undefined ? null : (
          <PreviewCard
            accepted={done}
            busy={result?.busy === true}
            facts={item.preview}
            onDecide={(decision, findings): void => onPreviewDecide(item, decision, findings)}
          />
        )}
      </div>
      <div className="cr2-needs-action">
        {decision === null || onDecide === undefined ? null : (
          <ActionButton
            ariaLabel={decision.ariaLabel}
            disabled={result?.busy === true || done}
            onClick={(): void => {
              if (decision.armLabel !== null && !armed) { setArmed(true); return; }
              setArmed(false);
              onDecide(item);
            }}
            testId={decision.testId}
          >
            {done ? decision.doneLabel : armed && decision.armLabel !== null ? decision.armLabel : decision.buttonLabel}
          </ActionButton>
        )}
        {armed && !done ? (
          <ActionButton
            onClick={(): void => setArmed(false)}
            testId={`${decision?.testId ?? "cr.needsyou.decision"}.cancel`}
            variant="secondary"
          >
            Keep it open
          </ActionButton>
        ) : null}
        {replan === null || onDecide === undefined ? null : (
          <ActionButton
            ariaLabel={`Replan ${replan.nodeKey} from its findings`}
            disabled={result?.busy === true || done}
            onClick={(): void => { setArmed(false); onDecide(item, "REPLAN"); }}
            testId={`cr.needsyou.replan.${key}`}
            variant="secondary"
          >
            Replan from the findings
          </ActionButton>
        )}
        {item.planningRunRef === "" ? null : (
          <ActionButton
            ariaLabel={`${item.actionLabel} for ${item.title}`}
            onClick={(): void => onOpenBoard(item.goalId, item.planningRunRef, item.title)}
            testId={`cr.needsyou.open.${slug}`}
            {...(decision === null ? {} : { variant: "secondary" as const })}
          >
            {`${item.actionLabel} →`}
          </ActionButton>
        )}
        {result?.outcome !== undefined && result.outcome !== null && !result.outcome.ok ? (
          <RefusalNote refusal={result.outcome} role="status" testId={`cr.needsyou.result.${key}`} />
        ) : line === null ? null : (
          <p aria-live="polite" className="cr2-needs-note" data-testid={`cr.needsyou.result.${key}`} role="status">{line}</p>
        )}
      </div>
    </li>
  );
}

export function NeedsYou({
  data, decisionResults, onDecide, onDismissIncident, onOpenBoard, onPreviewDecide, onRollback,
}: NeedsYouProps): JSX.Element {
  return (
    <section className="cr2-needs" data-testid="cr.needsyou.root">
      <div className="cr2-needs-bar">
        <span className="cr2-goals-count" data-testid="cr.needsyou.count">{data.countLabel}</span>
      </div>
      {data.note === null ? null : (
        <p className="cr2-needs-note" data-testid="cr.needsyou.note" role="status">{data.note}</p>
      )}
      {data.items.length === 0 ? (
        <div className="cr2-goals-empty" data-testid="cr.needsyou.empty">
          <p className="cr2-goals-empty-title">Nothing needs you right now.</p>
          <p className="cr2-goals-empty-body">
            Agents keep working on their own. A plan to approve, a Product Contract to approve,
            or a goal whose contract is fully verified will appear here.
          </p>
        </div>
      ) : (
        <ul className="cr2-needs-list" data-testid="cr.needsyou.list">
          {data.items.map((item) => (
            <DecisionCard
              item={item}
              key={`${item.kind}:${decisionKeyOf(item)}`}
              onDecide={onDecide}
              onDismissIncident={onDismissIncident}
              onOpenBoard={onOpenBoard}
              onPreviewDecide={onPreviewDecide}
              onRollback={onRollback}
              result={decisionResults?.get(decisionKeyOf(item))}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
