import { activateEffect } from "./effect-activation.js";
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
const RELEASE = disposition("WORK_RELEASE_OR_PAUSE");

/** The lock and its registration are both gone — the post-exit reading. */
const GONE = { registration: null, lockState: "RELEASED" } as const;

/** A settled effect with no attempt left behind it. */
const SETTLED = { intent: makeIntent({ state: "SUCCEEDED" }), attempt: null, grant: null } as const;

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
