import { describe, expect, it } from "vitest";

import type { SqliteEventStore } from "@moe/store";

import {
  FOUNDATION_ACTIVATION_UNREADABLE, readDurableFoundationObservation,
} from "./foundation-attempt-store.js";
import type { FoundationAttemptBound } from "./foundation-attempt-contracts.js";
import type { ActivationLedgerRecord } from "../activation/activation-ledger-contracts.js";

/**
 * "COULD NOT READ" IS NOT "THE RECORD DISAGREES".
 *
 * This read is reached only AFTER the provider process actually launched and its provider-run
 * row committed. A throw from `store.readEvents` answered the same `null` as a durable tail that
 * genuinely disagrees with the launcher's result, and the caller settles that null as UNPROVEN —
 * durably recording the run it just performed as never proven, and cancelling it.
 *
 * The DIRECTION is right and is left alone: an attempt whose tail cannot be read must not earn
 * the resumable release reason, and this module argues that at length. What was wrong is the
 * DIAGNOSIS. The unproven row carried FOUNDATION_ATTEMPT_LAUNCH_UNKNOWN — "the launch outcome is
 * unknown" — when the launch was fine and the ACTIVATION READ was what failed. Those are two
 * different repairs: one looks at the provider, the other at the store.
 */

const GRANT = {
  grantId: "grant-1", intentId: "intent-1", state: "CONSUMED", version: 1,
  wrapperIdentity: "wrapper-1",
};
const REGISTRATION = {
  bootstrapCredentialDigest: "b".repeat(64), lockIdentity: "lock-1",
  processIdentity: "process-1", registeredAt: "2026-09-17T00:00:00.000Z",
  wrapperIdentity: "wrapper-1",
};
const OBSERVATION = {
  activationDigest: "a".repeat(64), completedAt: "2026-09-17T00:01:00.000Z",
  consumedGrantDigest: "c".repeat(64), contextManifestDigest: "d".repeat(64),
  deliveredByteLength: 10, effectDigest: "e".repeat(64), exit: 0,
  freshRuntimeDigest: "f".repeat(64), grantId: "grant-1", launcherVersion: "1",
  lockIdentity: "lock-1", observationDigest: "o".repeat(64),
  pinnedClosureDigest: "p".repeat(64), processIdentity: "process-1",
  quotedRuntimeDigest: "q".repeat(64), reasonCode: null, reasonLayer: null,
  registrationDigest: "r".repeat(64), runtimeBindingDigest: "u".repeat(64),
  startedAt: "2026-09-17T00:00:30.000Z", stderr: "", stdout: "", truthClass: "PROVEN",
  wrapperIdentity: "wrapper-1",
};

/** A launcher answer that passes every shape gate, so the store read is actually reached. */
const PROVEN_RESULT = {
  code: null,
  consumedGrant: GRANT,
  kind: "OBSERVED",
  layer: null,
  observation: OBSERVATION,
  ok: true,
  registration: REGISTRATION,
  truthClass: "PROVEN",
};

const BOUND = {
  aggregateId: "activation-1", commandId: "cmd-1", correlationId: "corr-1",
  principalId: "operator-local", projectId: "project-1", target: "attempt-1",
} as unknown as FoundationAttemptBound;

const RECORD = {} as unknown as ActivationLedgerRecord;

const throwingStore = (): SqliteEventStore => ({
  readEvents: (): never => {
    throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
  },
}) as unknown as SqliteEventStore;

const emptyStore = (): SqliteEventStore =>
  ({ readEvents: () => [] }) as unknown as SqliteEventStore;

describe("readDurableFoundationObservation", () => {
  it("answers UNREADABLE, not null, when the activation stream cannot be read", () => {
    expect(readDurableFoundationObservation(throwingStore(), BOUND, RECORD, PROVEN_RESULT))
      .toBe(FOUNDATION_ACTIVATION_UNREADABLE);
  });

  it("still answers null when the activation stream was read and disagrees", () => {
    // Read fine, no transitions: the durable tail genuinely does not back the launcher's result.
    expect(readDurableFoundationObservation(emptyStore(), BOUND, RECORD, PROVEN_RESULT))
      .toBeNull();
  });

  it("still answers null for a launcher result that fails its own shape gates", () => {
    // These refusals precede the read entirely, so they must stay null however the store behaves.
    expect(readDurableFoundationObservation(throwingStore(), BOUND, RECORD, null)).toBeNull();
    expect(readDurableFoundationObservation(
      throwingStore(), BOUND, RECORD, { ...PROVEN_RESULT, truthClass: "SUSPECT" },
    )).toBeNull();
    expect(readDurableFoundationObservation(
      throwingStore(), BOUND, RECORD, { ...PROVEN_RESULT, ok: false },
    )).toBeNull();
  });

  it("keeps the sentinel distinguishable from every ordinary answer", () => {
    expect(typeof FOUNDATION_ACTIVATION_UNREADABLE).toBe("symbol");
    expect(FOUNDATION_ACTIVATION_UNREADABLE).not.toBeNull();
  });
});
