import type { JSX } from "react";

import { ActionButton } from "../components/primitives.js";
import { MIDDOT } from "../glyphs.js";
import type { NeedsYouData, NeedsYouItem, NeedsYouKind } from "./needs-you-model.js";

/**
 * The NEEDS YOU queue: one card per decision the daemon is waiting on, in the order a
 * person should take them (plans first, then contracts, then goals ready to close). Every
 * card carries the goal it belongs to and one action, and the action always opens that goal
 * where the evidence lives. Pure: no fetch, no dispatch, no clock.
 */

export interface NeedsYouProps {
  readonly data: NeedsYouData;
  readonly onOpenBoard: (goalId: string, planningRunRef: string, title: string) => void;
}

const KIND_EYEBROW: Readonly<Record<NeedsYouKind, string>> = Object.freeze({
  GATE_1: "PRODUCT CONTRACT",
  PLAN_APPROVAL: "PLAN",
  READY_TO_CLOSE: "READY TO CLOSE",
});

function DecisionCard({ item, onOpenBoard }: {
  readonly item: NeedsYouItem;
  readonly onOpenBoard: NeedsYouProps["onOpenBoard"];
}): JSX.Element {
  const slug = `${item.kind.toLowerCase().replace(/_/gu, "-")}.${item.goalId}`;
  return (
    <li className="cr2-needs-card" data-kind={item.kind} data-testid={`cr.needsyou.item.${slug}`}>
      <div className="cr2-needs-main">
        <p className="cr2-slot-kicker">{`${KIND_EYEBROW[item.kind]} ${MIDDOT} ${item.title}`}</p>
        <h2 className="cr2-needs-headline">{item.headline}</h2>
        <p className="cr2-needs-detail">{item.detail}</p>
      </div>
      <div className="cr2-needs-action">
        <ActionButton
          ariaLabel={`${item.actionLabel} for ${item.title}`}
          onClick={(): void => onOpenBoard(item.goalId, item.planningRunRef, item.title)}
          testId={`cr.needsyou.open.${slug}`}
        >
          {`${item.actionLabel} →`}
        </ActionButton>
      </div>
    </li>
  );
}

export function NeedsYou({ data, onOpenBoard }: NeedsYouProps): JSX.Element {
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
            <DecisionCard item={item} key={`${item.kind}:${item.goalId}`} onOpenBoard={onOpenBoard} />
          ))}
        </ul>
      )}
    </section>
  );
}
