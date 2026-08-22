import { activateEffect } from "./effect-activation.js";
import type { SupervisorFailure } from "./effect-kernel.js";
import {
  makeActivationRequest,
  makeClaim,
  makeIntent,
  makeTombstone,
  withExtraKey,
  type Overrides,
} from "./effect-test-fixtures.js";
import {
  disposition,
  FOREIGN_REGISTRATION,
  RECONCILED,
  REGISTRATION,
  type Scenario,
} from "./race-scenarios.js";

/**
 * Pre-crash durable record sets, one per declared restart post state and per
 * restart-layer refusal.
 *
 * The base is a REAL committed activation rather than a hand-typed record: a
 * reconstruction fed a fabricated commit would be answering a question no crash
 * can actually pose, and the grant-id derivation would not hold.
 */
const activated = activateEffect(makeActivationRequest());
if (activated.kind !== "ACTIVATED") {
  throw new Error("the restart pool base activation must commit or every seed is meaningless");
}
export const COMMIT = activated.commit;

const CANCEL = disposition("WORK_CANCEL");
export const RELEASE = disposition("WORK_RELEASE_OR_PAUSE");

/** The lock and its registration are both gone — the post-exit reading. */
export const GONE = { registration: null, lockState: "RELEASED" } as const;

/** A settled effect with no attempt left behind it. */
export const SETTLED = Object.freeze({
  intent: makeIntent({ state: "SUCCEEDED" }),
  attempt: null,
  grant: null,
});

export function failureOf(outcome: unknown): SupervisorFailure {
  const failure = (outcome as { failure?: SupervisorFailure }).failure;
  if (failure === undefined) {
    throw new Error(`expected a refusal, received ${JSON.stringify(outcome)}`);
  }
  return failure;
}

/**
 * `post:<state>` or `refused:<code>` — one label per legal answer. This only
 * FORMATS the production outcome; it decides nothing, so an expectation written
 * against it is still an expectation about `reconstructAfterRestart`.
 */
export function labelOf(outcome: unknown): string {
  const value = outcome as { kind?: string; postState?: string };
  return value.kind === "RECONSTRUCTED"
    ? `post:${String(value.postState)}`
    : `refused:${failureOf(outcome).code}`;
}

export function restartInput(overrides: Overrides = {}): unknown {
  return {
    intent: COMMIT.intent,
    attempt: COMMIT.attempt,
    attemptState: "RUNNING",
    claim: makeClaim(),
    grant: COMMIT.grant,
    tombstone: null,
    registration: REGISTRATION,
    lockState: "HELD",
    observation: null,
    reconciliation: null,
    resourceFact: "ACTIVE",
    disposition: CANCEL,
    safeHandoff: null,
    ...overrides,
  };
}

export const RESTART_SCENARIOS: readonly Scenario[] = Object.freeze([
  { id: "adopted-running", input: restartInput() },
  { id: "unreadable-lock", input: restartInput({ lockState: "UNKNOWN" }) },
  { id: "foreign-registration", input: restartInput({ registration: FOREIGN_REGISTRATION }) },
  {
    id: "claim-bound-elsewhere",
    input: restartInput({ claim: makeClaim({ intentId: "intent-other" }) }),
  },
  {
    id: "observation-without-registration",
    input: restartInput({ ...GONE, observation: { kind: "EXITED", code: 0 } }),
  },
  {
    id: "tombstone-dominates",
    input: restartInput({
      ...GONE,
      intent: makeIntent(),
      attempt: null,
      attemptState: "ABSENT",
      grant: null,
      tombstone: makeTombstone(),
    }),
  },
  { id: "running-unidentified", input: restartInput({ ...GONE, claim: null, grant: null }) },
  {
    id: "terminal-attempt-live-effect",
    input: restartInput({ ...GONE, attempt: null, attemptState: "TERMINAL", grant: null }),
  },
  {
    id: "terminal-label-without-proof",
    input: restartInput({
      ...GONE,
      ...SETTLED,
      attemptState: "TERMINAL",
      resourceFact: "PROVEN_RELEASED",
    }),
  },
  {
    id: "terminal-proven",
    input: restartInput({
      ...GONE,
      ...SETTLED,
      attemptState: "TERMINAL",
      resourceFact: "PROVEN_RELEASED",
      reconciliation: RECONCILED,
    }),
  },
  {
    id: "terminal-resource-unverifiable",
    input: restartInput({
      ...GONE,
      ...SETTLED,
      attemptState: "TERMINAL",
      resourceFact: "UNKNOWN",
      reconciliation: RECONCILED,
    }),
  },
  {
    id: "mid-drain",
    input: restartInput({
      ...GONE,
      attempt: null,
      attemptState: "DRAINING",
      resourceFact: "UNKNOWN",
    }),
  },
  {
    id: "drain-released-unreconciled",
    input: restartInput({
      ...GONE,
      attempt: null,
      attemptState: "DRAINING",
      resourceFact: "PROVEN_RELEASED",
    }),
  },
  {
    id: "drain-release-without-handoff",
    input: restartInput({
      ...GONE,
      attempt: null,
      attemptState: "DRAINING",
      resourceFact: "PROVEN_RELEASED",
      reconciliation: RECONCILED,
      disposition: RELEASE,
    }),
  },
  {
    id: "no-admitted-drain-row",
    input: restartInput({ ...GONE, ...SETTLED, attemptState: "ABSENT" }),
  },
  { id: "half-written-attempt", input: restartInput({ attemptState: "DRAINING" }) },
  { id: "extra-key", input: withExtraKey(restartInput() as object, "shadow", 1) },
]);
