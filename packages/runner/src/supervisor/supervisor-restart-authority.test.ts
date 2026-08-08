import { describe, expect, it } from "vitest";

import { activateEffect } from "./effect-activation.js";
import {
  DIGEST,
  makeActivationRequest,
  makeAttempt,
  makeIntent,
  makeLease,
  makeProof,
} from "./effect-test-fixtures.js";
import { RECONCILED } from "./race-scenarios.js";
import {
  COMMIT,
  failureOf,
  GONE,
  labelOf,
  RELEASE,
  restartInput,
  SETTLED,
} from "./race-restart-scenarios.js";
import { reconstructAfterRestart } from "./restart-reconstruction.js";

/**
 * A reconstruction that RESTORED authority instead of re-proving it is the
 * defect DoD 3 names, so the assertion is in two halves: the outcome carries no
 * authority material at all, and every fact the activation gate checks is still
 * checked when the rehydrated records ask to act again.
 *
 * Companion to `supervisor-restart.test.ts`, which owns the crash-point table.
 */
describe("a restart re-proves authority rather than restoring it", () => {
  const landings: readonly unknown[] = [
    restartInput(),
    restartInput({ lockState: "UNKNOWN" }),
    restartInput({ ...GONE, attempt: null, attemptState: "DRAINING", resourceFact: "UNKNOWN" }),
    restartInput({
      ...GONE,
      ...SETTLED,
      attemptState: "TERMINAL",
      resourceFact: "PROVEN_RELEASED",
      reconciliation: RECONCILED,
    }),
  ];

  it("hands back no token, no lease and no grant — only a post state", () => {
    let checked = 0;
    for (const input of landings) {
      const outcome = reconstructAfterRestart(input);
      expect(outcome.kind).toBe("RECONSTRUCTED");
      if (outcome.kind !== "RECONSTRUCTED") continue;
      checked += 1;
      expect(Object.keys(outcome).sort()).toEqual([
        "capacityHeld",
        "kind",
        "ok",
        "postState",
        "terminalTarget",
      ]);
    }
    expect(checked).toBe(landings.length);
  });

  const rehydrated = { intent: makeIntent(), attempt: makeAttempt() };
  const revalidated: readonly (readonly [string, Record<string, unknown>, string, string])[] = [
    [
      "the lease token is no longer current",
      { leaseProof: makeProof({ leaseToken: "token-stale" }) },
      "LEASE_MIRROR_STALE",
      "LEASE_MIRROR",
    ],
    [
      "the lease epoch is no longer current",
      { leaseProof: makeProof({ epoch: 6 }) },
      "LEASE_MIRROR_STALE_EPOCH",
      "LEASE_MIRROR",
    ],
    [
      "a revocation epoch superseded the authority",
      {
        intent: makeIntent({ leaseBinding: makeLease({ state: "REVOKED" }) }),
        leaseProof: makeProof({ epoch: 6 }),
      },
      "LEASE_MIRROR_SUPERSEDED_AUTHORITY",
      "LEASE_MIRROR",
    ],
    [
      "the runtime closure drifted from the quote",
      { observedRuntimeDigest: DIGEST.runtimeDrifted },
      "PROVIDER_CAPABILITY_CHANGED",
      "ACTIVATION",
    ],
    [
      "the graph epoch moved while the wrapper was down",
      { observedGraphEpoch: 99 },
      "ACTIVATION_GRAPH_EPOCH_MISMATCH",
      "ACTIVATION",
    ],
  ];

  it.each(revalidated)(
    "refuses a post-restart activation when %s",
    (_label, override, code, layer) => {
      const outcome = activateEffect(makeActivationRequest({ ...rehydrated, ...override }));
      const failure = failureOf(outcome);
      expect([failure.code, failure.layer]).toEqual([code, layer]);
    },
  );

  it("commits the same rehydrated records once every fact still holds", () => {
    // Without this control the five refusals above could all be a broken base
    // request refusing for a reason none of them names.
    expect(activateEffect(makeActivationRequest(rehydrated)).kind).toBe("ACTIVATED");
  });

  it("re-derives the grant id, so a rehydrated commit cannot be forged", () => {
    const forged = restartInput({ ...GONE, grant: { ...COMMIT.grant, grantId: DIGEST.witness } });
    const failure = failureOf(reconstructAfterRestart(forged));
    expect([failure.code, failure.layer]).toEqual(["RESTART_RECORDS_INCOHERENT", "RESTART"]);
  });
});

describe("no restart guesses a terminal it cannot prove", () => {
  const unproven: readonly (readonly [string, unknown])[] = [
    [
      "a settled label with no reconciliation",
      restartInput({ ...GONE, ...SETTLED, attemptState: "TERMINAL" }),
    ],
    [
      "a settled label whose resource is unverifiable",
      restartInput({
        ...GONE,
        ...SETTLED,
        attemptState: "TERMINAL",
        reconciliation: RECONCILED,
        resourceFact: "UNKNOWN",
      }),
    ],
    ["a lock nobody can read", restartInput({ lockState: "UNKNOWN" })],
    [
      "a cancelled label with nothing behind it",
      restartInput({
        ...GONE,
        intent: makeIntent({ state: "CANCELLED" }),
        attempt: null,
        attemptState: "TERMINAL",
        grant: null,
        resourceFact: "PROVEN_RELEASED",
      }),
    ],
  ];

  /**
   * The admitted set is written out in full rather than as "not TERMINAL_PROVEN".
   * A negative assertion would still pass if the reconstruction started answering
   * TOMBSTONED — also a terminal, also unproven — and the first draft of this
   * test mapped refusals onto `post:UNKNOWN` before comparing, which made it pass
   * for any refusal whatsoever.
   */
  const ADMITTED_WHEN_UNPROVEN: readonly string[] = [
    "post:UNKNOWN",
    "post:SUSPECT",
    "post:DRAINING",
    "refused:RESTART_PREMATURE_TERMINAL",
  ];

  it("sweeps a non-zero set of unproven-evidence cases", () => {
    expect(unproven.length).toBe(4);
  });

  it.each(unproven)("prefers UNKNOWN, SUSPECT or a refusal over guessing, given %s", (_l, input) => {
    expect(ADMITTED_WHEN_UNPROVEN).toContain(labelOf(reconstructAfterRestart(input)));
  });

  it("names RESTART_PREMATURE_TERMINAL at the RESTART layer, not generic incoherence", () => {
    const failure = failureOf(
      reconstructAfterRestart(restartInput({ ...GONE, ...SETTLED, attemptState: "TERMINAL" })),
    );
    expect([failure.code, failure.layer]).toEqual(["RESTART_PREMATURE_TERMINAL", "RESTART"]);
  });

  it("distinguishes the drain layer's safe-handoff refusal from the restart layer's", () => {
    const failure = failureOf(
      reconstructAfterRestart(
        restartInput({
          ...GONE,
          attempt: null,
          attemptState: "DRAINING",
          resourceFact: "PROVEN_RELEASED",
          reconciliation: RECONCILED,
          disposition: RELEASE,
        }),
      ),
    );
    expect([failure.code, failure.layer]).toEqual(["RESTART_SAFE_HANDOFF_ABSENT", "RESTART"]);
  });
});
