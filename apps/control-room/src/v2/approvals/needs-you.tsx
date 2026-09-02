import type { JSX } from "react";

import { ActionButton } from "../components/primitives.js";
import { MIDDOT } from "../glyphs.js";
import type { EscalationOutcome } from "./escalation-port.js";
import type { NeedsYouData, NeedsYouItem, NeedsYouKind } from "./needs-you-model.js";

/** What the escalation port answered for one node, kept beside its card. */
export interface EscalationResult {
  readonly busy: boolean;
  readonly outcome: EscalationOutcome | null;
}

/**
 * The NEEDS YOU queue: one card per decision the daemon is waiting on, in the order a
 * person should take them (plans first, then contracts, then goals ready to close). Every
 * card carries the goal it belongs to and one action, and the action always opens that goal
 * where the evidence lives. Pure: no fetch, no dispatch, no clock.
 */

export interface NeedsYouProps {
  readonly data: NeedsYouData;
  readonly escalationResults?: ReadonlyMap<string, EscalationResult> | undefined;
  /** Spends the daemon's escalation.decide offer for this item; absent means no inline decision. */
  readonly onEscalate?: ((item: NeedsYouItem) => void) | undefined;
  readonly onOpenBoard: (goalId: string, planningRunRef: string, title: string) => void;
}

const KIND_EYEBROW: Readonly<Record<NeedsYouKind, string>> = Object.freeze({
  ESCALATION: "REVIEW EXHAUSTED",
  GATE_1: "PRODUCT CONTRACT",
  PLAN_APPROVAL: "PLAN",
  READY_TO_CLOSE: "READY TO CLOSE",
});

function escalationLine(result: EscalationResult | undefined): string | null {
  if (result === undefined) return null;
  if (result.busy) return "Recording your decision...";
  if (result.outcome === null) return null;
  return result.outcome.ok
    ? "Allowed. Agents may submit new review rounds for this node."
    : `REFUSED ${MIDDOT} ${result.outcome.code} ${MIDDOT} ${result.outcome.layer}`;
}

function DecisionCard({ item, onEscalate, onOpenBoard, result }: {
  readonly item: NeedsYouItem;
  readonly onEscalate: NeedsYouProps["onEscalate"];
  readonly onOpenBoard: NeedsYouProps["onOpenBoard"];
  readonly result: EscalationResult | undefined;
}): JSX.Element {
  const key = item.escalation?.nodeKey ?? item.goalId;
  const slug = `${item.kind.toLowerCase().replace(/_/gu, "-")}.${key}`;
  const line = escalationLine(result);
  return (
    <li className="cr2-needs-card" data-kind={item.kind} data-testid={`cr.needsyou.item.${slug}`}>
      <div className="cr2-needs-main">
        <p className="cr2-slot-kicker">{`${KIND_EYEBROW[item.kind]} ${MIDDOT} ${item.title}`}</p>
        <h2 className="cr2-needs-headline">{item.headline}</h2>
        <p className="cr2-needs-detail">{item.detail}</p>
      </div>
      <div className="cr2-needs-action">
        {item.escalation === undefined || onEscalate === undefined ? null : (
          <ActionButton
            ariaLabel={`Allow more attempts on ${item.escalation.nodeKey}`}
            disabled={result?.busy === true || result?.outcome?.ok === true}
            onClick={(): void => onEscalate(item)}
            testId={`cr.needsyou.escalate.${item.escalation.nodeKey}`}
          >
            {result?.outcome?.ok === true ? "Allowed" : "Allow more attempts"}
          </ActionButton>
        )}
        {item.planningRunRef === "" ? null : (
          <ActionButton
            ariaLabel={`${item.actionLabel} for ${item.title}`}
            onClick={(): void => onOpenBoard(item.goalId, item.planningRunRef, item.title)}
            testId={`cr.needsyou.open.${slug}`}
            {...(item.escalation === undefined ? {} : { variant: "secondary" as const })}
          >
            {`${item.actionLabel} →`}
          </ActionButton>
        )}
        {line === null ? null : (
          <p aria-live="polite" className="cr2-needs-note" data-testid={`cr.needsyou.result.${key}`} role="status">{line}</p>
        )}
      </div>
    </li>
  );
}

export function NeedsYou({ data, escalationResults, onEscalate, onOpenBoard }: NeedsYouProps): JSX.Element {
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
              key={`${item.kind}:${item.escalation?.nodeKey ?? item.goalId}`}
              onEscalate={onEscalate}
              onOpenBoard={onOpenBoard}
              result={escalationResults?.get(item.escalation?.nodeKey ?? "")}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
