import { useState } from "react";
import type { JSX } from "react";

import type { CaptureLoader } from "../../live/live-preview-capture.js";
import { OutcomeNote } from "../components/outcome-note.js";
import { IncidentCard } from "./incident-card.js";
import { incidentKeyOf } from "./needs-you-incident.js";
import { ActionButton } from "../components/primitives.js";
import { MIDDOT } from "../glyphs.js";
import { writeFailedSaid } from "../outcome-words.js";
import type { NeedsYouData, NeedsYouItem, NeedsYouKind } from "./needs-you-model.js";
import { PreviewCard } from "./preview-card.js";
import { EscalationFindings } from "./needs-you-escalation-findings.js";
import { EscalationGuidanceInput } from "./escalation-guidance-input.js";
import { EscalationOptions } from "./escalation-options.js";
import { listedFindingsBlockNothing } from "./needs-you-escalation.js";
import { supportsEscalationGuidance, validEscalationGuidance } from "./escalation-port.js";
import type { PreviewDecision, PreviewFinding } from "./preview-port.js";
import type { OfferOutcome } from "./offer-wire.js";

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
  readonly guidanceSubmitted?: boolean;
  /** REPLAN committed; the retained card may retry successor creation only. */
  readonly replanCommitted?: boolean;
  readonly replanPending?: boolean;
  readonly outcome: OfferOutcome | null;
}

const REPLAN_DONE_LINE = "Replanned. A successor goal now carries the findings; the planning agent takes it next.";

/** The second answer an exhausted review takes: re-plan the work instead of retrying it. */
export type NeedsYouChoice = "REPLAN";

export interface NeedsYouProps {
  readonly data: NeedsYouData;
  /** Keyed by `resultKeyOf(item)`, including the offered review version for escalations. */
  readonly decisionResults?: ReadonlyMap<string, DecisionResult> | undefined;
  /** Fetches a PREVIEW item's captures with the session headers; absent shows none. */
  readonly loadCapture?: CaptureLoader | undefined;
  /** Spends the daemon's offer this item carries; absent means no inline decision. */
  readonly onDecide?: ((item: NeedsYouItem, choice?: NeedsYouChoice, implementationGuidance?: string) => void) | undefined;
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
  ABANDON: "Stuck product",
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

/** The identity a card's controls carry: the node for an escalation, else the goal. */
export function decisionKeyOf(item: NeedsYouItem): string {
  const incident = item.incident;
  if (incident !== undefined) return incidentKeyOf(incident.environment, incident.incidentId);
  const escalation = item.escalation;
  if (escalation === undefined) return item.goalId;
  const nodeRef = escalation.affordance["targetAggregateId"];
  return typeof nodeRef === "string" && nodeRef.length > 0
    ? nodeRef : JSON.stringify([item.goalId, escalation.nodeKey]);
}

/** Separate decision kinds and review versions keep earlier responses off a later card. */
export function resultKeyOf(item: NeedsYouItem): string {
  const key = `${item.kind}:${decisionKeyOf(item)}`;
  if (item.escalation === undefined) return key;
  const version = item.escalation.affordance["expectedVersion"];
  return `${key}:v${typeof version === "number" && Number.isSafeInteger(version) && version >= 0 ? version : "unknown"}`;
}

function decisionOf(item: NeedsYouItem): InlineDecision | null {
  if (item.escalation !== undefined) {
    return {
      ariaLabel: `Allow one more attempt on ${item.escalation.nodeKey}`,
      armLabel: null,
      buttonLabel: "Allow one more attempt",
      doneLabel: "Allowed",
      doneLine: "Allowed. One more review attempt is approved for this node.",
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
  if (item.cancel !== undefined) {
    return {
      ariaLabel: `Abandon the product ${item.title}`,
      armLabel: "Confirm: abandon this product",
      buttonLabel: "Abandon the product",
      doneLabel: "Abandoned",
      doneLine: "Abandoned. The product is cancelled; its unverified work is left where it is.",
      testId: `cr.needsyou.cancel.${item.goalId}`,
    };
  }
  return null;
}

function resultLine(decision: InlineDecision, result: DecisionResult | undefined): string | null {
  if (result === undefined) return null;
  if (result.busy) return "Recording your decision...";
  if (result.outcome === null) return null;
  if (!result.outcome.ok) return null;
  if (result.guidanceSubmitted === true && result.choice !== "REPLAN") {
    return "Guidance recorded. One more attempt is approved for this node.";
  }
  return result.choice === "REPLAN" ? REPLAN_DONE_LINE : decision.doneLine;
}

function DecisionCard({
  item, loadCapture, onDecide, onDismissIncident, onOpenBoard, onPreviewDecide, onRollback,
  result,
}: {
  readonly item: NeedsYouItem;
  readonly loadCapture: NeedsYouProps["loadCapture"];
  readonly onDecide: NeedsYouProps["onDecide"];
  readonly onDismissIncident: NeedsYouProps["onDismissIncident"];
  readonly onRollback: NeedsYouProps["onRollback"];
  readonly onOpenBoard: NeedsYouProps["onOpenBoard"];
  readonly onPreviewDecide: NeedsYouProps["onPreviewDecide"];
  readonly result: DecisionResult | undefined;
}): JSX.Element {
  const [armed, setArmed] = useState(false);
  const [guidance, setGuidance] = useState("");
  const key = decisionKeyOf(item);
  const slug = `${item.kind.toLowerCase().replace(/_/gu, "-")}.${key}`;
  const decision = decisionOf(item);
  const line = decision === null ? null : resultLine(decision, result);
  const done = result?.outcome?.ok === true;
  const replanCommitted = result?.replanCommitted === true;
  const replanPending = replanCommitted || result?.replanPending === true;
  const replan = item.escalation === undefined ? null : item.escalation;
  const reviewUnavailable = replan !== null && replan.findingsState !== "CURRENT";
  const guidanceSupported = replan !== null && supportsEscalationGuidance(replan.affordance);
  const guided = replan !== null && guidance.length > 0;
  const guidanceBlocked = guided && (!guidanceSupported || !validEscalationGuidance(guidance));
  // A stalled review repeats unless something changes: where the node takes instructions, the
  // bare retry waits for them and replanning becomes the primary answer. A stall on findings
  // that block nothing (all MINOR, or owned by other nodes) cannot repeat: the kernel accepts
  // the next such round, so the plain retry stays primary (UnAI 2026-09-17/18). A list at the
  // daemon's cap proves nothing (a blocking finding may be unlisted), so it keeps the gate.
  const stalled = (replan?.stalledRounds?.length ?? 0) > 0 && !listedFindingsBlockNothing(replan?.findings ?? []);
  const allowNeedsGuidance = stalled && guidanceSupported && !guided;
  // The guidance textbox renders only where a decision port exists; the option copy that says
  // "whatever you write below" must not outlive it on a read-only card.
  const guidanceEntry = guidanceSupported && onDecide !== undefined;
  return (
    <li className="cr2-needs-card" data-kind={item.kind} data-testid={`cr.needsyou.item.${slug}`}>
      <div className="cr2-needs-main">
        <p className="cr2-slot-kicker">{`${KIND_EYEBROW[item.kind]} ${MIDDOT} ${item.title}`}</p>
        <h2 className="cr2-needs-headline">{replanCommitted ? "Replan recorded" : replanPending ? "Replan outcome needs checking" : item.headline}</h2>
        <p className="cr2-needs-detail">{replanCommitted
          ? result.busy ? "The replacement goal is being created." : "Replacement creation needs retry. The original node is already retired."
          : replanPending ? "Resume to check the saved request against the daemon and finish creating its replacement." : item.detail}</p>
        {item.escalation === undefined ? null : <EscalationFindings facts={item.escalation} />}
        {replan === null || replanPending ? null : <EscalationOptions guidanceEntry={guidanceEntry} />}
        {replan === null || onDecide === undefined || replanPending ? null : <EscalationGuidanceInput
          disabled={result?.busy === true || done || reviewUnavailable} onChange={setGuidance}
          supported={guidanceSupported} value={guidance} />}
        {!allowNeedsGuidance || replanPending || done ? null : (
          <p className="cr2-needs-note" data-testid={`cr.needsyou.stall-guidance.${key}`}>
            One more attempt needs new instructions, because nothing changed since the last rounds. Write guidance above, or replan.
          </p>
        )}
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
            loadCapture={loadCapture}
            onDecide={(decision, findings): void => onPreviewDecide(item, decision, findings)}
          />
        )}
      </div>
      <div className="cr2-needs-action">
        {decision === null || onDecide === undefined ? null : (
          <ActionButton
            ariaLabel={guided ? `Retry with guidance on ${replan!.nodeKey}` : decision.ariaLabel}
            disabled={replanPending || result?.busy === true || done || reviewUnavailable || guidanceBlocked || allowNeedsGuidance}
            onClick={(): void => {
              if (guidanceBlocked || replanPending || allowNeedsGuidance) return;
              if (decision.armLabel !== null && !armed) { setArmed(true); return; }
              setArmed(false);
              if (guided) onDecide(item, undefined, guidance);
              else onDecide(item);
            }}
            testId={decision.testId}
            variant={stalled ? "secondary" : "primary"}
          >
            {done ? decision.doneLabel : guided ? "Retry with guidance" : armed && decision.armLabel !== null ? decision.armLabel : decision.buttonLabel}
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
            ariaLabel={replanCommitted ? `Retry creating the successor for ${replan.nodeKey}` : `Replan ${replan.nodeKey} from its findings`}
            disabled={result?.busy === true || done || (reviewUnavailable && !replanPending)}
            onClick={(): void => { setArmed(false); onDecide(item, "REPLAN"); }}
            testId={`cr.needsyou.replan.${key}`}
            variant={stalled ? "primary" : "secondary"}
          >
            {replanCommitted ? "Retry creating successor" : replanPending ? "Resume replacement creation" : "Replan from the findings"}
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
        {line === null ? null : (
          <p aria-live="polite" className="cr2-needs-note" data-testid={`cr.needsyou.result.${key}`} role="status">{line}</p>
        )}
        {result?.outcome !== undefined && result.outcome !== null && !result.outcome.ok ? (
          <OutcomeNote
            code={result.outcome.code}
            layer={result.outcome.layer}
            said={writeFailedSaid()}
            testId={`cr.needsyou.result.${key}`}
          />
        ) : null}
      </div>
    </li>
  );
}

export function NeedsYou({
  data, decisionResults, loadCapture, onDecide, onDismissIncident, onOpenBoard, onPreviewDecide,
  onRollback,
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
            Agents keep working on their own. A plan to approve, a Product Contract at Gate 1,
            or a goal whose contract is fully verified will appear here.
          </p>
        </div>
      ) : (
        <ul className="cr2-needs-list" data-testid="cr.needsyou.list">
          {data.items.map((item) => (
            <DecisionCard
              item={item}
              key={resultKeyOf(item)}
              loadCapture={loadCapture}
              onDecide={onDecide}
              onDismissIncident={onDismissIncident}
              onOpenBoard={onOpenBoard}
              onPreviewDecide={onPreviewDecide}
              onRollback={onRollback}
              result={decisionResults?.get(resultKeyOf(item))}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
