import type { JSX } from "react";

import { SuppliedActions } from "../goals/supplied-actions.js";
import type { SuppliedFact } from "../nodes/node-authority.js";

/**
 * The circuit-breaker banner (spec section 7.5, CR-S10-001).
 *
 * CR-S10-001's bar is that the banner NAMES THE CORRELATED CHECK. A banner reading only
 * "fan-out held" would be true and useless: the operator cannot act without knowing which
 * check correlated. So `command` and `locus` come from the daemon's payload and the
 * banner renders nothing at all when the payload is absent.
 *
 * It is a sibling module rather than a branch inside frame.tsx's `Banners` because that
 * function early-returns exactly one banner. A circuit breaker is orthogonal to connection
 * state — a lagging view can also be circuit-broken — so it composes ALONGSIDE.
 *
 * Politeness is not cosmetic here (spec 11.1): an assertive live region interrupts a
 * screen-reader user mid-sentence, and this is a status, not an alert.
 */
export interface CircuitBreakerFact {
  /** The failing check, named by the daemon. Never inferred from the children. */
  readonly command: SuppliedFact;
  readonly correlatedChildren: SuppliedFact;
  readonly locus: SuppliedFact;
  /** Aggregate the daemon's own hold/release commands target. */
  readonly targetAggregateId: string;
}

export interface CircuitBreakerBannerProps {
  /** Absent means the daemon reported no circuit breaker — render nothing. */
  readonly breaker?: CircuitBreakerFact | undefined;
}

function readValue(fact: SuppliedFact): string | null {
  if (fact === null || fact === undefined) return null;
  const { value } = fact;
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * Spec section 7.5 copy. Assembled from supplied values only: every interpolation below
 * is a daemon fact, and when any of them is missing the banner does not render a sentence
 * with a hole in it — see `CircuitBreakerBanner`.
 */
export function circuitBreakerSentence(
  children: string,
  command: string,
  locus: string,
): string {
  return `Correlated failures across ${children} children — same failing check: `
    + `\`${command}\` (${locus}). Fan-out held.`;
}

export function CircuitBreakerBanner(props: CircuitBreakerBannerProps): JSX.Element | null {
  const { breaker } = props;
  if (breaker === undefined) return null;
  const children = readValue(breaker.correlatedChildren);
  const command = readValue(breaker.command);
  const locus = readValue(breaker.locus);
  // A partially supplied breaker is not rendered as a sentence with UNKNOWN wedged into
  // it: CR-S10-001 requires the check to be NAMED, and a banner that cannot name it has
  // nothing to say. Failing closed here is the honest outcome.
  if (children === null || command === null || locus === null) return null;
  return (
    <div aria-live="polite" data-testid="cr.banner.circuitbreaker" role="status">
      <span data-testid="cr.banner.circuitbreaker.text">
        {circuitBreakerSentence(children, command, locus)}
      </span>
      <SuppliedActions
        targetAggregateId={breaker.targetAggregateId}
        testId="cr.banner.circuitbreaker.actions"
      />
    </div>
  );
}
