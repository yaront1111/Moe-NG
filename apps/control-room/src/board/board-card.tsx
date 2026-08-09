import type { JSX } from "react";

import { FactRow, readIdentity } from "../nodes/node-authority.js";
import type { SuppliedFact } from "../nodes/node-authority.js";
import { SuppliedActions } from "../goals/supplied-actions.js";
import type { BoardCardProjection, BoardCardProps } from "./board-contract.js";

/**
 * One board card (spec §2.2, §4.3, §5.2).
 *
 * Every claim on the card is a named property of the projection rendered through
 * `FactRow`, so an extra field a hostile or careless payload carries cannot reach the
 * DOM. Renewal silence and activity silence stay two facts: the J5 case is a healthy
 * renewal beside a 41-minute quiet build, and merging them hides exactly that. Overlays
 * stay orthogonal for the same reason — SUSPECT, held, disposition, and qualification
 * compose rather than collapsing into one badge.
 */
type CardFactSpec = readonly [
  suffix: string, label: string, pick: (card: BoardCardProjection) => SuppliedFact,
];

const ACTIVITY_SILENCE = "lease.activitysilence";

/** The declared card fact kinds, in rendered order. */
const CARD_FACTS: readonly CardFactSpec[] = [
  ["phase", "Phase", (card) => card.phase],
  ["owner", "Owner", (card) => card.owner],
  ["lease.state", "Lease state", (card) => card.leaseState],
  ["lease.epoch", "Lease epoch", (card) => card.leaseEpoch],
  ["lease.expiry", "Lease expiry", (card) => card.leaseExpiry],
  ["lease.renewalsilence", "Renewal silence", (card) => card.renewalSilence],
  [ACTIVITY_SILENCE, "Activity silence", (card) => card.activitySilence],
  ["progress", "Progress", (card) => card.progress],
  ["latestclaim", "Latest claim", (card) => card.latestClaim],
  ["blocker.type", "Blocker type", (card) => card.blockerType],
  ["blocker.owner", "Blocker owner", (card) => card.blockerOwner],
  ["blocker.reason", "Blocker reason", (card) => card.blockerReason],
  ["wait.owner", "Wait owner", (card) => card.waitOwner],
  ["wait.reason", "Wait reason", (card) => card.waitReason],
  ["wait.recheck", "Wait recheck", (card) => card.waitRecheck],
  ["budget.spent", "Budget spent", (card) => card.budgetSpent],
  ["budget.basis", "Budget basis", (card) => card.budgetBasis],
  ["criticalpath", "Critical path", (card) => card.criticalPath],
  ["slack", "Slack", (card) => card.slack],
  ["suspect", "SUSPECT", (card) => card.suspect],
  ["held", "Held", (card) => card.held],
  ["disposition", "Supersession disposition", (card) => card.disposition],
  ["qualification", "Acceptance qualification", (card) => card.qualification],
];

export function BoardCard(props: BoardCardProps): JSX.Element {
  const { card, onActivateCommand, onProvenance } = props;
  // A payload that omitted the identity still has to be visible: an unnamed record is a
  // record the operator must be able to see, not one the board may quietly discard.
  const identity = readIdentity(card.nodeId);
  return (
    <article
      data-board-card={identity}
      data-placement={card.placement ?? "unmapped"}
      data-source-aggregate={card.sourceAggregate}
      data-testid={`cr.board.card.${identity}`}
      tabIndex={-1}
    >
      <h3 data-testid="cr.board.cardtitle">{card.title}</h3>
      {CARD_FACTS.map(([suffix, label, pick]) => (
        <div
          data-testid={suffix === ACTIVITY_SILENCE ? `cr.board.card.silence.${identity}` : undefined}
          key={suffix}
        >
          <FactRow
            fact={pick(card)}
            factId={`node.${identity}.${suffix}`}
            label={label}
            onProvenance={onProvenance}
          />
        </div>
      ))}
      <SuppliedActions
        onActivate={onActivateCommand}
        targetAggregateId={card.actionTargetId}
        testId={`cr.board.actions.${identity}`}
      />
    </article>
  );
}
