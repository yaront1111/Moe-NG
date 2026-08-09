import type { NextAllowedCommand } from "@moe/contracts";

import type { ProvenanceHandler, SuppliedFact } from "../nodes/node-authority.js";

/**
 * Presentation contract for the Runs/leases surface (spec section 4.11, section 5's lease
 * matrix, section 8.2). Like board/board-contract.ts this is NOT a wire DTO: nothing here
 * parses a daemon response, and every displayed datum arrives already projected and
 * already truth-classified.
 *
 * Two shapes in here are load-bearing rather than stylistic:
 *
 * `renewalSilence` and `activitySilence` are TWO fields and there is deliberately no
 * combined or computed silence datum. CR-J5-001 is a healthy renewal beside a long quiet
 * period on an ACTIVE lease, and a single folded value cannot express that — it would
 * make a normal build look like a stalled one.
 *
 * `leaseState` is supplied, never derived. This module exposes no helper that folds a
 * state, a suspicion or a health verdict out of the other fields, because the moment such
 * a helper exists the surface has become the authority on lease health instead of the
 * daemon. There is also no clock here: a duration is a supplied string, never a
 * subtraction of two timestamps.
 */
export interface RunLeaseProjection {
  /** Aggregate id the daemon's own commands target; never derived from `sessionId`. */
  readonly actionTargetId: string;
  /** How long the session has been quiet. Neutral on its own — see the header. */
  readonly activitySilence: SuppliedFact;
  readonly epoch: SuppliedFact;
  readonly expiry: SuppliedFact;
  readonly gracePolicy: SuppliedFact;
  /** Exactly what the daemon reported. Never inferred from a silence value. */
  readonly leaseState: SuppliedFact;
  readonly node: SuppliedFact;
  readonly owner: SuppliedFact;
  /** How long since the lease last renewed. Independent of `activitySilence`. */
  readonly renewalSilence: SuppliedFact;
  readonly role: SuppliedFact;
  /** Display identity for the row; opaque, shown and compared but never interpreted. */
  readonly sessionId: string;
  /**
   * The section 8.2 sentence, supplied whole by the daemon. It is not assembled here:
   * the surface has neither the duration nor the grace remainder as numbers, and
   * composing it client-side would let a rendering bug contradict policy.
   */
  readonly suspectSentence: SuppliedFact;
}

export type RunsCommandHandler = (command: NextAllowedCommand) => void;

export interface RunsSurfaceProps {
  readonly degraded?: boolean | undefined;
  readonly loading?: boolean | undefined;
  readonly onActivateCommand?: RunsCommandHandler | undefined;
  readonly onProvenance?: ProvenanceHandler | undefined;
  readonly rows: readonly RunLeaseProjection[];
}

/** Spec section 11.3, verbatim. The surface may not soften or shorten this. */
export const RUNS_EMPTY_COPY
  = "No active sessions. Agents appear here when they open a session.";

/**
 * Spec section 8.2, verbatim, exported so the test pins the same bytes the daemon is
 * expected to send. The surface renders whatever the payload supplied; this constant is
 * the reference text, not a template the client fills in.
 */
export const SUSPECT_SENTENCE
  = "{session} has not renewed its lease for {duration}. Policy is waiting "
  + "(grace: {remaining} left). Silence alone never revokes — choose an option or let "
  + "the grace elapse to escalation.";

/** The declared row facts, in rendered order. Adding a field here is a deliberate act. */
export const RUN_FACTS: readonly (readonly [
  suffix: string, label: string, pick: (run: RunLeaseProjection) => SuppliedFact,
])[] = [
  ["run.owner", "Owner", (run) => run.owner],
  ["run.role", "Role", (run) => run.role],
  ["run.node", "Node", (run) => run.node],
  ["run.leasestate", "Lease state", (run) => run.leaseState],
  ["run.epoch", "Lease epoch", (run) => run.epoch],
  ["run.expiry", "Lease expiry", (run) => run.expiry],
  ["run.renewalsilence", "Renewal silence", (run) => run.renewalSilence],
  ["run.activitysilence", "Activity silence", (run) => run.activitySilence],
  ["run.gracepolicy", "Grace policy", (run) => run.gracePolicy],
];
