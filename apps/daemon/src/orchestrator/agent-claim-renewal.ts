import { createHash } from "node:crypto";

import type { JsonObject } from "@moe/contracts";

import type { AffordancePort } from "../http/affordance-contract.js";
import { workItemIdFor } from "../http/affordance-read.js";

/**
 * THE LEASE FOLLOWS LIVENESS. While a seat process is alive, the wrapper renews the seat's
 * work claim on the seat's behalf, under the seat's OWN bearer (the secret `work.claim` was
 * dispatched with, so the ledger keeps naming the seat as the claimant). Live (UnAI
 * 2026-09-18, node 10, seat 87c543be): the wrapper claimed for `claimTtlMs` (30 min) and never
 * renewed; the operator had raised the seat's wall-clock cap to 60 min; the seat worked 35 min,
 * finished with 483 tests green, and every submit was refused REVIEW_SUBMISSION_CLAIM_REQUIRED.
 * A whole attempt was lost to a horizon nobody was tending.
 *
 * WHAT THIS IS NOT. It is not a new authority: `work.renew` is the holder's own keepalive, and
 * it can never CREATE a claim (`work-claim-services.ts` refuses a renew with no open claim as
 * WORK_CLAIM_NOT_FOUND), so a renew that races the seat's own release at the end is a named
 * no-op or a store conflict with zero business effect, never a re-created claim. It stops when
 * the seat exits, before the wrapper's own release path runs (`agent-wrapper-staffing.ts`), so
 * the claim TTL keeps its meaning as the reap horizon for a DEAD child.
 *
 * TWO CLOCKS, ONE AUTHORITY. The timer is only a wake-up; the wrapper's injected `clock` decides
 * whether a renewal is due and mints its `expiresAt`, exactly as it minted the original claim's.
 * A tick that wakes before the clock reaches the due instant re-arms and renews nothing, which is
 * what lets a test drive the cadence with a fake clock, and what keeps a suite whose clock is
 * frozen from ever mutating its claim ledger.
 */

export interface ClaimRenewalOutcome {
  readonly code: string;
  /** The refusing authority's own detail, when the dispatch surfaced one. */
  readonly detail?: string | undefined;
  readonly ok: boolean;
}

export type ClaimRenewalDispatch = (
  credential: string,
  kind: string,
  payload: JsonObject,
  target: string,
  expectedVersion: number,
  commandId?: string,
) => ClaimRenewalOutcome;

export interface ClaimRenewalConfig {
  readonly affordances: AffordancePort;
  /** The claim TTL the seat was staffed with; every renewal re-mints it from `clock()`. */
  readonly claimTtlMs: number;
  readonly clock: () => number;
  readonly dispatch: ClaimRenewalDispatch;
  readonly log: (line: string) => void;
  /** The seat's own bearer: the same secret the wrapper claimed under. */
  readonly secret: string;
  readonly sessionId: string;
  readonly workItemId: string;
}

/** What staffing drives: armed once the child exists, disarmed the instant it is gone. */
export interface ClaimKeepalive {
  readonly start: () => void;
  readonly stop: () => void;
}

export interface ClaimRenewal extends ClaimKeepalive {
  /** Renewals the daemon committed so far; a fact for tests and reports, never a decision. */
  readonly renewed: () => number;
}

/** Every `claimTtlMs / 3`, starting after the first third: two chances before the horizon. */
export function renewalCadenceMs(claimTtlMs: number): number {
  return Math.max(1, Math.floor(claimTtlMs / 3));
}

const COMMITTED = "EFFECTS_COMMITTED";

function unref(timer: unknown): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer
    && typeof (timer as { unref: unknown }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
}

export function createClaimRenewal(config: ClaimRenewalConfig): ClaimRenewal {
  const cadence = renewalCadenceMs(config.claimTtlMs);
  const target = `work/${config.workItemId}`;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let started = false;
  let stopped = false;
  let dueAt = 0;
  let attempts = 0;
  let renewed = 0;
  /** Once per code per seat: a refusal that repeats every tick is one fact, not a log storm. */
  const said = new Set<string>();
  const sayOnce = (verb: "refused" | "skipped", code: string, detail: string): void => {
    if (said.has(code)) return;
    said.add(code);
    config.log(`[wrapper] ${config.workItemId} claim renew ${verb} ${code}: ${detail}`);
  };

  const commandId = (attempt: number, version: number): string =>
    `wrap-${createHash("sha256").update(JSON.stringify([
      config.secret, config.sessionId, config.workItemId, "work.renew", attempt, version,
    ])).digest("hex").slice(0, 32)}`;

  const renewOnce = (now: number): void => {
    let surface: ReturnType<AffordancePort["readSurface"]>;
    try {
      surface = config.affordances.readSurface();
    } catch {
      sayOnce("skipped", "SURFACE_READ_FAILED", "the offer surface could not be read; the next tick reads again");
      return;
    }
    if (surface.outcome !== "SURFACE") {
      sayOnce("skipped", surface.code, "the offer surface answered no surface; the next tick reads again");
      return;
    }
    const step = surface.steps.find((candidate) =>
      workItemIdFor(candidate.kind, candidate.aggregateId) === config.workItemId);
    if (step === undefined) {
      sayOnce("skipped", "WORK_ITEM_NOT_VISIBLE",
        "the item is off the offer surface (an accepted submit moves it there); nothing to renew");
      return;
    }
    // A released or expired claim is NEVER re-created from here: `work.renew` cannot, and this
    // path does not dispatch `work.claim`. The seat that released is finishing; let it.
    if (step.claim === null) {
      sayOnce("skipped", "CLAIM_NOT_HELD", "no open claim on the item: the seat released it, or it expired");
      return;
    }
    if (step.claim.claimedBy !== config.sessionId) {
      sayOnce("skipped", "CLAIM_HELD_BY_OTHER", `the claim is held by ${step.claim.claimedBy}, not this seat`);
      return;
    }
    attempts += 1;
    const expiresAt = new Date(now + config.claimTtlMs).toISOString();
    let outcome: ClaimRenewalOutcome;
    try {
      outcome = config.dispatch(config.secret, "work.renew", { expiresAt, workItemId: config.workItemId },
        target, step.claim.version, commandId(attempts, step.claim.version));
    } catch {
      sayOnce("refused", "COMMAND_DISPATCH_FAILED", "the renew dispatch threw; the next tick tries again");
      return;
    }
    if (outcome.ok && outcome.code === COMMITTED) {
      renewed += 1;
      return;
    }
    sayOnce("refused", outcome.code, outcome.detail ?? outcome.code);
  };

  const arm = (): void => {
    if (stopped) return;
    timer = setTimeout(tick, Math.max(0, dueAt - config.clock()));
    unref(timer);
  };

  const tick = (): void => {
    timer = null;
    if (stopped) return;
    const now = config.clock();
    // Woke before the clock says so: the timer is a wake-up, the clock is the authority.
    if (now >= dueAt) {
      renewOnce(now);
      dueAt = now + cadence;
    }
    arm();
  };

  return Object.freeze({
    renewed: () => renewed,
    start: (): void => {
      // A start after a stop is a no-op: the exit handler can run before the staffing report
      // reaches its caller, and a renewal armed after that would tend a dead seat's claim.
      if (started || stopped) return;
      started = true;
      dueAt = config.clock() + cadence;
      arm();
    },
    stop: (): void => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  });
}
