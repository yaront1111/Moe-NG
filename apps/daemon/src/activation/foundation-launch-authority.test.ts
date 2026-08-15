/**
 * The Foundation activation bridge, driven through a REAL file-backed store.
 *
 * Every acceptance re-reads the aggregate after REOPENING the file, because the
 * question is what a restart can prove, not what a live handle remembers. The
 * activation half of every fixture is produced by `activateEffect` itself rather
 * than hand-written: a hand-written grant id would not derive from the digest,
 * so `validateActivationCommit` could never be COHERENT and every positive here
 * would be testing a record production can never produce.
 *
 * WINDOWS HANDLE DISCIPLINE: every handle is closed inside the `it` body, and in
 * the race worker's `finally` BEFORE it posts. A handle held across the
 * temp-directory cleanup throws EPERM, kills the vitest worker with no output,
 * and reads as a native crash rather than as a leak.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import { SUPERVISOR_ACTIVATION_VERSION, SUPERVISOR_EFFECT_PROTOCOL_VERSION, activateEffect } from "@moe/runner";
import type { ActivationCommit, ClaudeRegistrationCommit } from "@moe/runner";
import { SqliteEventStore } from "@moe/store";
import type {
  CommandDecisionResponse, CommitExpectedVersionDecisionInput, StoredEvent,
} from "@moe/store";
import { describe, expect, it } from "vitest";

import { commitActivationLedgerRecord } from "./activation-ledger-commit.js";
import {
  ACTIVATION_LEDGER_RECORD_VERSION, deriveActivationAggregateId,
} from "./activation-ledger-contracts.js";
import type { ActivationLedgerRecord } from "./activation-ledger-contracts.js";
import {
  readActivationLedgerRecord, readCurrentEffectSessionBinding, readFoundationActivationHistory,
} from "./activation-ledger-reader.js";
import {
  FOUNDATION_ACTIVATION_BINDING_LAYER, FOUNDATION_TRANSITION_EVENT_TYPES,
  decodeFoundationTransition, encodeFoundationTransition,
} from "./foundation-activation-transition.js";
import { createFoundationClaudeLauncher, createFoundationLauncherAuthority } from "./foundation-launch-authority.js";

const PROJECT_ID = "foundation-project";
const WRAPPER = "wrapper-1";
const LOCK = "lock-1";
const SESSION = "session-1";
const INTENT_ID = "intent-1";
const ATTEMPT_ID = "attempt-1";
const AGGREGATE = "effect-aggregate-1";
const IDEMPOTENCY = "idem-key-1";
const DEADLINE_SECONDS = 2_000;
const DERIVED = deriveActivationAggregateId(AGGREGATE, IDEMPOTENCY);

function digestOf(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const LEASE = Object.freeze({
  authorityHashRef: digestOf("authority"), bootId: "boot-1", epoch: 2, kind: "ASSIGNMENT" as const,
  leaseId: "lease-1", leaseToken: "token-1", monotonicObservation: 1_000, ownerSessionRef: SESSION,
  serverWallDeadline: DEADLINE_SECONDS, state: "ACTIVE" as const, version: 5,
});
const ARMED_INTENT = {
  aggregateId: AGGREGATE, desiredState: "ACTIVE", expectedGraphEpoch: 4,
  idempotencyKey: IDEMPOTENCY, inputBinding: digestOf("input"), intentId: INTENT_ID,
  leaseBinding: LEASE, predecessorCursor: "cursor-1",
  protocolVersion: SUPERVISOR_EFFECT_PROTOCOL_VERSION, runtimeObservationDigest: digestOf("runtime"),
  state: "ARMED", version: 6,
};
const ATTEMPT = {
  aggregateId: AGGREGATE, attemptId: ATTEMPT_ID, intentId: INTENT_ID,
  state: "LAUNCH_REQUESTED", version: 7,
};
const CLAIM = Object.freeze({
  claimedAt: "2026-08-15T00:00:00.000Z", claimId: "claim-1", intentId: INTENT_ID,
  lockIdentity: LOCK, wrapperIdentity: WRAPPER,
});
const LEASE_PROOF = {
  authorityHashRef: digestOf("authority"), epoch: 2, expectedVersion: 5,
  leaseToken: "token-1", ownerSessionRef: SESSION,
};

/** The activation half, produced by the production authority so it is coherent. */
function activationCommit(): ActivationCommit {
  const outcome = activateEffect({
    attempt: ATTEMPT, claim: CLAIM, dependencyWitnesses: [], desiredState: "ACTIVE",
    intent: ARMED_INTENT, leaseProof: LEASE_PROOF, lockIdentity: LOCK, observedGraphEpoch: 4,
    observedRuntimeDigest: digestOf("runtime"), tombstone: null, wrapperIdentity: WRAPPER,
  });
  if (outcome.kind !== "ACTIVATED") {
    throw new Error(`fixture activation refused: ${outcome.failure.code}`);
  }
  return outcome.commit;
}

const COMMIT = activationCommit();

function ledgerRecord(
  overrides: Partial<ActivationLedgerRecord> = {},
): ActivationLedgerRecord {
  return {
    activationDigest: COMMIT.activationDigest,
    activationVersion: SUPERVISOR_ACTIVATION_VERSION,
    attempt: COMMIT.attempt,
    budgetReservation: {
      accountId: "account-1", admissionRef: "admission-1", attemptRef: ATTEMPT_ID,
      lines: [{ meter: "tokens", purpose: "EXECUTION", quantity: 10 }],
      neverStartedProofRef: null, reservationId: "reservation-1", state: "ACTIVATED", version: 3,
    },
    budgetView: {
      accountId: "account-1",
      meters: [{ available: 90, committed: 0, meter: "tokens", quarantined: 0, reserved: 10 }],
      state: "OPEN", version: 3,
    },
    effectIntent: COMMIT.intent,
    grant: COMMIT.grant,
    lease: LEASE,
    predecessorAttemptVersion: 7,
    predecessorIntentVersion: 6,
    providerSlot: {
      attemptRef: ATTEMPT_ID, dimension: "provider:claude", requestId: "request-1",
      slotRef: "slot-1", state: "ACTIVE",
    },
    recordVersion: ACTIVATION_LEDGER_RECORD_VERSION,
    ...overrides,
  };
}

function preflightRegistration(credential = "cred-1"): ClaudeRegistrationCommit["registration"] {
  return {
    bootstrapCredentialDigest: digestOf(credential), lockIdentity: LOCK,
    processIdentity: `pending:${WRAPPER}`, registeredAt: "2026-08-15T00:00:02.000Z",
    wrapperIdentity: WRAPPER,
  };
}

function startedRegistration(credential = "cred-2"): ClaudeRegistrationCommit["registration"] {
  return {
    bootstrapCredentialDigest: digestOf(credential), lockIdentity: LOCK,
    processIdentity: "windows:4321", registeredAt: "2026-08-15T00:00:03.000Z",
    wrapperIdentity: WRAPPER,
  };
}

function withDirectory<T>(name: string, run: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), `moe-foundation-${name}-`));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function withStore<T>(databasePath: string, run: (store: SqliteEventStore) => T): T {
  const store = SqliteEventStore.openForProject(databasePath, PROJECT_ID);
  try {
    return run(store);
  } finally {
    store.close();
  }
}

/** Seeds sequence 1 through df298's own commit adapter. Never hand-written bytes. */
function seedActivation(
  store: SqliteEventStore, record: ActivationLedgerRecord = ledgerRecord(),
): void {
  const committed = commitActivationLedgerRecord(store, {
    correlationId: "activation-correlation",
    decidedAt: "2026-08-15T00:00:00.000Z",
    key: { commandId: "activation-command", principalId: "principal-1", projectId: PROJECT_ID },
    record,
    requestBytes: new TextEncoder().encode("activation-request"),
  });
  if (!committed.ok) throw new Error(`seed refused: ${committed.code}`);
}

interface AuthorityOverrides {
  readonly commandId?: string;
  readonly projectId?: string;
}

function authorityOver(
  store: SqliteEventStore, overrides: AuthorityOverrides = {},
): ReturnType<typeof createFoundationLauncherAuthority> {
  return createFoundationLauncherAuthority({
    aggregateId: DERIVED,
    correlationId: "launch-correlation",
    key: {
      commandId: overrides.commandId ?? "launch-command",
      principalId: "principal-1",
      projectId: overrides.projectId ?? PROJECT_ID,
    },
    projectId: overrides.projectId ?? PROJECT_ID,
    store,
  });
}

/** A delegate over the REAL store that can be made to throw on the Nth commit. */
function throwingAfter(store: SqliteEventStore, allowed: number, error: Error): SqliteEventStore {
  let seen = 0;
  const delegate = {
    commitExpectedVersionDecision(
      input: CommitExpectedVersionDecisionInput,
    ): CommandDecisionResponse {
      seen += 1;
      if (seen > allowed) throw error;
      return store.commitExpectedVersionDecision(input);
    },
    getHealth: () => store.getHealth(),
    readEvents: (aggregateId: string): readonly StoredEvent[] => store.readEvents(aggregateId),
    readEventsAfter: (after: bigint, limit?: number) => store.readEventsAfter(after, limit),
  };
  return delegate as unknown as SqliteEventStore;
}

function refusalOf(answer: unknown): { code: string; layer: string; leg: string | null; kind: string } {
  const record = answer as {
    kind: string;
    failure: { code: string; layer: string; detail: { leg: string | null } };
  };
  return {
    code: record.failure.code, kind: record.kind, layer: record.failure.layer,
    leg: record.failure.detail.leg,
  };
}

function consumedGrant(answer: unknown): { state: string; version: number; grantId: string } {
  return (answer as { grant: { state: string; version: number; grantId: string } }).grant;
}

function registrationOf(answer: unknown): ClaudeRegistrationCommit["registration"] {
  return (answer as { registration: ClaudeRegistrationCommit["registration"] }).registration;
}

function eventTypes(store: SqliteEventStore, aggregateId = DERIVED): readonly string[] {
  return store.readEvents(aggregateId).map((event) => event.eventType);
}

function decisionCount(store: SqliteEventStore): number {
  return store.readCommandDecisionsAfter(0n, 100).items.length;
}

/**
 * How many events of a type exist STORE-WIDE, not just on the activation
 * aggregate. A refused expected-version decision legitimately appends its own
 * audit event, so a raw global count is not the invariant; "exactly one grant
 * was consumed anywhere" is.
 */
function publicEventCount(store: SqliteEventStore, eventType: string): number {
  return store.readEventsAfter(0n, 100).items.filter((event) => event.eventType === eventType).length;
}

describe("foundation durable grant consumption", () => {
  it("consumes UNUSED to CONSUMED as sequence 2 and survives reopening", () => {
    withDirectory("grant", (directory) => {
      const databasePath = join(directory, "store.sqlite");
      const answer = withStore(databasePath, (store) => {
        seedActivation(store);
        return authorityOver(store).consumeGrantDurably(COMMIT.grant, WRAPPER);
      });
      expect((answer as { kind: string }).kind).toBe("CONSUMED");
      expect(consumedGrant(answer)).toStrictEqual({
        grantId: COMMIT.grant.grantId, intentId: INTENT_ID, state: "CONSUMED", version: 1,
        wrapperIdentity: WRAPPER,
      });

      withStore(databasePath, (reopened) => {
        expect(eventTypes(reopened)).toStrictEqual([
          "EffectActivationCommitted", FOUNDATION_TRANSITION_EVENT_TYPES.GRANT_CONSUMED,
        ]);
        expect(reopened.getAggregateVersion(DERIVED)).toBe(2);
        const transition = decodeFoundationTransition(reopened.readEvents(DERIVED)[1]?.payload);
        expect(transition.ok).toBe(true);
        if (!transition.ok) return;
        expect(transition.transition).toStrictEqual({
          activationDigest: COMMIT.activationDigest, attemptId: ATTEMPT_ID,
          bootstrapCredentialDigest: null, grantId: COMMIT.grant.grantId, intentId: INTENT_ID,
          lockIdentity: null, processIdentity: null, registeredAt: null,
          tag: "GRANT_CONSUMED", wrapperIdentity: WRAPPER,
        });
      });
    });
  });

  it("replays the SAME command byte-identically without writing a second event", () => {
    withDirectory("grant-replay", (directory) => {
      const databasePath = join(directory, "store.sqlite");
      withStore(databasePath, (store) => {
        seedActivation(store);
        const authority = authorityOver(store);
        const first = authority.consumeGrantDurably(COMMIT.grant, WRAPPER);
        const eventsAfterFirst = store.readEvents(DERIVED).length;
        const decisionsAfterFirst = decisionCount(store);
        const second = authority.consumeGrantDurably(COMMIT.grant, WRAPPER);
        expect(second).toStrictEqual(first);
        expect(store.readEvents(DERIVED)).toHaveLength(eventsAfterFirst);
        expect(decisionCount(store)).toBe(decisionsAfterFirst);
      });
    });
  });

  it("refuses a DIFFERENT command racing the same fence with GRANT_ALREADY_CONSUMED", () => {
    withDirectory("grant-duplicate", (directory) => {
      const databasePath = join(directory, "store.sqlite");
      withStore(databasePath, (store) => {
        seedActivation(store);
        expect(
          (authorityOver(store, { commandId: "launch-a" })
            .consumeGrantDurably(COMMIT.grant, WRAPPER) as { kind: string }).kind,
        ).toBe("CONSUMED");
        const refused = authorityOver(store, { commandId: "launch-b" })
          .consumeGrantDurably(COMMIT.grant, WRAPPER);
        expect(refusalOf(refused)).toStrictEqual({
          code: "GRANT_ALREADY_CONSUMED", kind: "REFUSED", layer: "GRANT", leg: "GRANT_CONSUME",
        });
        expect(store.readEvents(DERIVED)).toHaveLength(2);
      });
    });
  });

  it("maps a malformed grant and a wrapper mismatch to the pure kernel codes", () => {
    withDirectory("grant-pure", (directory) => {
      const databasePath = join(directory, "store.sqlite");
      withStore(databasePath, (store) => {
        seedActivation(store);
        const authority = authorityOver(store);
        expect(refusalOf(authority.consumeGrantDurably({ grantId: "not-a-digest" }, WRAPPER)))
          .toStrictEqual({
            code: "EFFECT_GRANT_MALFORMED", kind: "REFUSED", layer: "KERNEL", leg: "GRANT_CONSUME",
          });
        expect(refusalOf(authority.consumeGrantDurably(COMMIT.grant, "wrapper-other")))
          .toStrictEqual({
            code: "GRANT_WRAPPER_MISMATCH", kind: "REFUSED", layer: "GRANT", leg: "GRANT_CONSUME",
          });
        expect(store.readEvents(DERIVED)).toHaveLength(1);
      });
    });
  });

  it("refuses a grant that is not the DURABLE activation's grant", () => {
    withDirectory("grant-drift", (directory) => {
      const databasePath = join(directory, "store.sqlite");
      withStore(databasePath, (store) => {
        seedActivation(store);
        const foreign = { ...COMMIT.grant, grantId: digestOf("some-other-grant") };
        const refused = authorityOver(store).consumeGrantDurably(foreign, WRAPPER);
        expect(refusalOf(refused)).toStrictEqual({
          code: "ACTIVATION_COMMIT_INCOHERENT", kind: "REFUSED", layer: "ACTIVATION",
          leg: "GRANT_CONSUME",
        });
        expect(store.readEvents(DERIVED)).toHaveLength(1);
      });
    });
  });

  it("answers SUSPECT when the durable activation cannot be read at all", () => {
    withDirectory("grant-unreadable", (directory) => {
      const databasePath = join(directory, "store.sqlite");
      withStore(databasePath, (store) => {
        // No seeded activation: sequence 1 is absent, so nothing may be consumed.
        const refused = authorityOver(store).consumeGrantDurably(COMMIT.grant, WRAPPER);
        expect(refusalOf(refused)).toStrictEqual({
          code: "ACTIVATION_COMMIT_INCOHERENT", kind: "SUSPECT", layer: "ACTIVATION",
          leg: "GRANT_CONSUME",
        });
        expect(store.readEvents(DERIVED)).toHaveLength(0);
      });
    });
  });

  it("answers SUSPECT and writes nothing when the store throws at the commit", () => {
    withDirectory("grant-throw", (directory) => {
      const databasePath = join(directory, "store.sqlite");
      withStore(databasePath, (store) => {
        seedActivation(store);
        const injected = throwingAfter(store, 0, new Error("injected commit failure"));
        const refused = authorityOver(injected).consumeGrantDurably(COMMIT.grant, WRAPPER);
        expect(refusalOf(refused)).toStrictEqual({
          code: "ACTIVATION_COMMIT_INCOHERENT", kind: "SUSPECT", layer: "ACTIVATION",
          leg: "GRANT_CONSUME",
        });
        expect(store.readEvents(DERIVED)).toHaveLength(1);
      });
    });
  });
});

describe("foundation durable launch registration", () => {
  function consumed(store: SqliteEventStore): void {
    seedActivation(store);
    const answer = authorityOver(store).consumeGrantDurably(COMMIT.grant, WRAPPER);
    if ((answer as { kind: string }).kind !== "CONSUMED") throw new Error("grant fence failed");
  }

  it("registers PREFLIGHT then PROCESS_OBSERVED as sequences 3 and 4", () => {
    withDirectory("register", (directory) => {
      const databasePath = join(directory, "store.sqlite");
      withStore(databasePath, (store) => {
        consumed(store);
        const authority = authorityOver(store);
        const preflight = authority.commitProcessRegistration({
          claim: CLAIM, phase: "PREFLIGHT", prior: null, registration: preflightRegistration(),
        });
        expect((preflight as { kind: string }).kind).toBe("REGISTERED");
        expect(registrationOf(preflight)).toStrictEqual(preflightRegistration());
        const started = authority.commitProcessRegistration({
          claim: CLAIM, phase: "STARTED", prior: null, registration: startedRegistration(),
        });
        expect((started as { kind: string }).kind).toBe("REGISTERED");
        expect(registrationOf(started)).toStrictEqual(startedRegistration());
      });

      withStore(databasePath, (reopened) => {
        expect(eventTypes(reopened)).toStrictEqual([
          "EffectActivationCommitted",
          FOUNDATION_TRANSITION_EVENT_TYPES.GRANT_CONSUMED,
          FOUNDATION_TRANSITION_EVENT_TYPES.PREFLIGHT_REGISTERED,
          FOUNDATION_TRANSITION_EVENT_TYPES.PROCESS_OBSERVED,
        ]);
        expect(reopened.getAggregateVersion(DERIVED)).toBe(4);
        const observed = decodeFoundationTransition(reopened.readEvents(DERIVED)[3]?.payload);
        expect(observed.ok).toBe(true);
        if (!observed.ok) return;
        expect(observed.transition.processIdentity).toBe("windows:4321");
        expect(observed.transition.registeredAt).toBe("2026-08-15T00:00:03.000Z");
      });
    });
  });

  it("replays the same registration command byte-identically", () => {
    withDirectory("register-replay", (directory) => {
      const databasePath = join(directory, "store.sqlite");
      withStore(databasePath, (store) => {
        consumed(store);
        const authority = authorityOver(store);
        const commit: ClaudeRegistrationCommit = {
          claim: CLAIM, phase: "PREFLIGHT", prior: null, registration: preflightRegistration(),
        };
        const first = authority.commitProcessRegistration(commit);
        const events = store.readEvents(DERIVED).length;
        const decisions = decisionCount(store);
        expect(authority.commitProcessRegistration(commit)).toStrictEqual(first);
        expect(store.readEvents(DERIVED)).toHaveLength(events);
        expect(decisionCount(store)).toBe(decisions);
      });
    });
  });

  it("refuses a second, DIFFERENT preflight command with an identity conflict", () => {
    withDirectory("register-conflict", (directory) => {
      const databasePath = join(directory, "store.sqlite");
      withStore(databasePath, (store) => {
        consumed(store);
        authorityOver(store, { commandId: "register-a" }).commitProcessRegistration({
          claim: CLAIM, phase: "PREFLIGHT", prior: null, registration: preflightRegistration(),
        });
        const refused = authorityOver(store, { commandId: "register-b" })
          .commitProcessRegistration({
            claim: CLAIM, phase: "PREFLIGHT", prior: null,
            registration: preflightRegistration("cred-other"),
          });
        expect(refusalOf(refused)).toStrictEqual({
          code: "LAUNCH_LOCK_IDENTITY_CONFLICT", kind: "REFUSED", layer: "LAUNCH_LOCK",
          leg: "PREFLIGHT_REGISTER",
        });
        expect(store.readEvents(DERIVED)).toHaveLength(3);
      });
    });
  });

  it("refuses PROCESS_OBSERVED before its PREFLIGHT reservation exists, without deciding", () => {
    withDirectory("register-order", (directory) => {
      const databasePath = join(directory, "store.sqlite");
      withStore(databasePath, (store) => {
        consumed(store);
        const decisions = decisionCount(store);
        const refused = authorityOver(store).commitProcessRegistration({
          claim: CLAIM, phase: "STARTED", prior: null, registration: startedRegistration(),
        });
        expect(refusalOf(refused)).toStrictEqual({
          code: "LAUNCH_LOCK_IDENTITY_CONFLICT", kind: "REFUSED", layer: "LAUNCH_LOCK",
          leg: "PROCESS_OBSERVE",
        });
        expect(store.readEvents(DERIVED)).toHaveLength(2);
        // The ordering guard must refuse BEFORE the store is asked. The durable
        // CAS would refuse this too, with the same code, so the only thing that
        // separates the two is whether a command decision was spent at all.
        expect(decisionCount(store)).toBe(decisions);
      });
    });
  });

  it("refuses a malformed claim, a malformed registration, and a non-null prior", () => {
    withDirectory("register-malformed", (directory) => {
      const databasePath = join(directory, "store.sqlite");
      withStore(databasePath, (store) => {
        consumed(store);
        const authority = authorityOver(store);
        const bad = (commit: unknown): { code: string; layer: string; leg: string | null; kind: string } =>
          refusalOf(authority.commitProcessRegistration(commit as ClaudeRegistrationCommit));
        expect(bad({
          claim: { claimId: "claim-1" }, phase: "PREFLIGHT", prior: null,
          registration: preflightRegistration(),
        })).toStrictEqual({
          code: "LAUNCH_LOCK_MALFORMED", kind: "REFUSED", layer: "LAUNCH_LOCK",
          leg: "PREFLIGHT_REGISTER",
        });
        expect(bad({
          claim: CLAIM, phase: "PREFLIGHT", prior: null,
          registration: { ...preflightRegistration(), bootstrapCredentialDigest: "short" },
        })).toStrictEqual({
          code: "LAUNCH_LOCK_MALFORMED", kind: "REFUSED", layer: "LAUNCH_LOCK",
          leg: "PREFLIGHT_REGISTER",
        });
        expect(bad({
          claim: CLAIM, phase: "PREFLIGHT", prior: preflightRegistration(),
          registration: preflightRegistration("cred-3"),
        })).toStrictEqual({
          code: "LAUNCH_LOCK_IDENTITY_CONFLICT", kind: "REFUSED", layer: "LAUNCH_LOCK",
          leg: "PREFLIGHT_REGISTER",
        });
        expect(bad({ claim: CLAIM, phase: "ADOPTED", prior: null, registration: preflightRegistration() }))
          .toStrictEqual({
            code: "LAUNCH_LOCK_MALFORMED", kind: "REFUSED", layer: "LAUNCH_LOCK", leg: null,
          });
        expect(store.readEvents(DERIVED)).toHaveLength(2);
      });
    });
  });

  it("refuses a registration whose fields are accessors rather than data", () => {
    withDirectory("register-accessor", (directory) => {
      const databasePath = join(directory, "store.sqlite");
      withStore(databasePath, (store) => {
        consumed(store);
        // A getter would run the caller's code inside a guard whose whole job is
        // to refuse, and could answer differently on a second read.
        const hostile = Object.defineProperty({ ...preflightRegistration() }, "processIdentity", {
          configurable: true, enumerable: true, get: () => `pending:${WRAPPER}`,
        });
        expect(refusalOf(authorityOver(store).commitProcessRegistration({
          claim: CLAIM, phase: "PREFLIGHT", prior: null,
          registration: hostile as ClaudeRegistrationCommit["registration"],
        }))).toStrictEqual({
          code: "LAUNCH_LOCK_MALFORMED", kind: "REFUSED", layer: "LAUNCH_LOCK",
          leg: "PREFLIGHT_REGISTER",
        });
        expect(store.readEvents(DERIVED)).toHaveLength(2);
      });
    });
  });

  it("refuses a registration whose lock or wrapper is not the claim's", () => {
    withDirectory("register-relations", (directory) => {
      const databasePath = join(directory, "store.sqlite");
      withStore(databasePath, (store) => {
        consumed(store);
        const authority = authorityOver(store);
        expect(refusalOf(authority.commitProcessRegistration({
          claim: CLAIM, phase: "PREFLIGHT", prior: null,
          registration: { ...preflightRegistration(), lockIdentity: "lock-other" },
        }))).toStrictEqual({
          code: "LAUNCH_LOCK_IDENTITY_CONFLICT", kind: "REFUSED", layer: "LAUNCH_LOCK",
          leg: "PREFLIGHT_REGISTER",
        });
        expect(refusalOf(authority.commitProcessRegistration({
          claim: CLAIM, phase: "PREFLIGHT", prior: null,
          registration: { ...preflightRegistration(), wrapperIdentity: "wrapper-other" },
        }))).toStrictEqual({
          code: "LAUNCH_LOCK_IDENTITY_CONFLICT", kind: "REFUSED", layer: "LAUNCH_LOCK",
          leg: "PREFLIGHT_REGISTER",
        });
        expect(store.readEvents(DERIVED)).toHaveLength(2);
      });
    });
  });

  it("answers SUSPECT and writes nothing when the store throws at registration", () => {
    withDirectory("register-throw", (directory) => {
      const databasePath = join(directory, "store.sqlite");
      withStore(databasePath, (store) => {
        consumed(store);
        const injected = throwingAfter(store, 0, new Error("injected registration failure"));
        const refused = authorityOver(injected).commitProcessRegistration({
          claim: CLAIM, phase: "PREFLIGHT", prior: null, registration: preflightRegistration(),
        });
        expect(refusalOf(refused)).toStrictEqual({
          code: "LAUNCH_LOCK_SUSPECT", kind: "SUSPECT", layer: "LAUNCH_LOCK",
          leg: "PREFLIGHT_REGISTER",
        });
        expect(store.readEvents(DERIVED)).toHaveLength(2);
      });
    });
  });

  it("publishes a composed launcher rather than a bare port bag", () => {
    withDirectory("compose", (directory) => {
      const databasePath = join(directory, "store.sqlite");
      withStore(databasePath, (store) => {
        seedActivation(store);
        const launcher = createFoundationClaudeLauncher({
          aggregateId: DERIVED, correlationId: "launch-correlation",
          key: { commandId: "launch-command", principalId: "principal-1", projectId: PROJECT_ID },
          projectId: PROJECT_ID, store,
        });
        expect(typeof launcher).toBe("function");
        expect(Object.isFrozen(authorityOver(store))).toBe(true);
      });
    });
  });
});

describe("foundation activation history fold", () => {
  it("admits only the exact ordered prefix and rechecks every carried identity", () => {
    withDirectory("fold", (directory) => {
      const databasePath = join(directory, "store.sqlite");
      withStore(databasePath, (store) => {
        seedActivation(store);
        const authority = authorityOver(store);
        authority.consumeGrantDurably(COMMIT.grant, WRAPPER);
        authority.commitProcessRegistration({
          claim: CLAIM, phase: "PREFLIGHT", prior: null, registration: preflightRegistration(),
        });
        const history = readFoundationActivationHistory(
          DERIVED, store.readEvents(DERIVED), PROJECT_ID,
        );
        expect(history.ok).toBe(true);
        if (!history.ok) return;
        expect(history.history.transitions.map((entry) => entry.tag)).toStrictEqual([
          "GRANT_CONSUMED", "PREFLIGHT_REGISTERED",
        ]);
        expect(history.history.record.effectIntent.intentId).toBe(INTENT_ID);
      });
    });
  });

  it("refuses a history whose sequences are not contiguous", () => {
    withDirectory("fold-sequence", (directory) => {
      const databasePath = join(directory, "store.sqlite");
      withStore(databasePath, (store) => {
        seedActivation(store);
        authorityOver(store).consumeGrantDurably(COMMIT.grant, WRAPPER);
        const events = store.readEvents(DERIVED);
        const [initial, consumedEvent] = events;
        if (initial === undefined || consumedEvent === undefined) throw new Error("seed failed");
        // The TAG order is still exactly right; only the sequence numbering lies.
        // Without the contiguity check the tag walk alone would admit this.
        const drifted = [initial, { ...consumedEvent, aggregateSequence: 3 }];
        const refused = readFoundationActivationHistory(DERIVED, drifted, PROJECT_ID);
        expect(refused.ok).toBe(false);
        if (refused.ok) return;
        expect(refused.result.status).toBe("UNKNOWN");
        expect(refused.result.status === "BOUND" ? null : refused.result.code)
          .toBe("FOUNDATION_BINDING_EVIDENCE_MALFORMED");
        expect(refused.result.status === "BOUND" ? null : refused.result.layer)
          .toBe(FOUNDATION_ACTIVATION_BINDING_LAYER);
      });
    });
  });

  it("refuses a history whose middle event is missing", () => {
    withDirectory("fold-hole", (directory) => {
      const databasePath = join(directory, "store.sqlite");
      withStore(databasePath, (store) => {
        seedActivation(store);
        const authority = authorityOver(store);
        authority.consumeGrantDurably(COMMIT.grant, WRAPPER);
        authority.commitProcessRegistration({
          claim: CLAIM, phase: "PREFLIGHT", prior: null, registration: preflightRegistration(),
        });
        const events = store.readEvents(DERIVED);
        const holed = [events[0], events[2]].filter((event): event is StoredEvent => event !== undefined);
        const refused = readFoundationActivationHistory(DERIVED, holed, PROJECT_ID);
        expect(refused.ok).toBe(false);
        if (refused.ok) return;
        expect(refused.result.status).toBe("UNKNOWN");
        expect(refused.result.status === "BOUND" ? null : refused.result.code)
          .toBe("FOUNDATION_BINDING_EVIDENCE_MALFORMED");
        expect(refused.result.status === "BOUND" ? null : refused.result.layer)
          .toBe(FOUNDATION_ACTIVATION_BINDING_LAYER);
      });
    });
  });
});

describe("current effect/session binding", () => {
  const NOW_MILLISECONDS = DEADLINE_SECONDS * 1_000;

  function bindingOver(
    store: SqliteEventStore, effectId = INTENT_ID, sessionId = SESSION,
    now = NOW_MILLISECONDS, projectId = PROJECT_ID,
  ): ReturnType<typeof readCurrentEffectSessionBinding> {
    return readCurrentEffectSessionBinding(store, projectId, effectId, sessionId, now);
  }

  function codeOf(result: ReturnType<typeof readCurrentEffectSessionBinding>): string {
    return result.status === "BOUND" ? "BOUND" : `${result.status}:${result.code}`;
  }

  /**
   * THE NUMBER IS WRITTEN OUT ON PURPOSE.
   *
   * The scan used to stop after MAX_SCAN_PAGES(64) * SCAN_PAGE_SIZE(100) = 6,400
   * GLOBAL events and refuse SCAN_INCOMPLETE forever after. Deriving this count
   * from those constants would make the proof move with the bound it exists to
   * pin: halving the page size would silently halve the coverage while the test
   * stayed green. A literal breaks instead, which is the point.
   */
  const OLD_SCAN_CEILING = 6_400;
  const EVENTS_PAST_THE_OLD_SCAN_CEILING = 6_500;
  const NOISE_EVENT_TYPE = "FoundationScanNoiseObserved";
  /** Under MAX_EVENTS_PER_COMMIT (256) and under the 1,000-per-aggregate read cap. */
  const NOISE_PER_BATCH = 250;
  const SECOND_IDEMPOTENCY = "idem-key-2";
  const SECOND_GRANT_ID = "grant-second-activation";

  /**
   * Drives the GLOBAL stream past `count` cheap events.
   *
   * BATCHED: one transaction per 250 events rather than one per event. 6,500
   * individual commits under `PRAGMA synchronous = FULL` take long enough to
   * read as a hang, and a drill that hangs reads as a passing guard. The noise
   * type is deliberately NOT the ledger's event type, so the scan skips these
   * without decoding them - what is being proved is reach, not parsing.
   */
  function floodGlobalStream(store: SqliteEventStore, count: number): number {
    const payload = new TextEncoder().encode("noise");
    let written = 0;
    for (let batch = 0; written < count; batch += 1) {
      const size = Math.min(NOISE_PER_BATCH, count - written);
      store.commit({
        aggregateId: `noise-aggregate-${batch}`,
        commandBytes: new TextEncoder().encode(`noise-command-${batch}`),
        commandId: `noise-command-${batch}`,
        committedAt: "2026-08-15T00:00:04.000Z",
        events: Array.from({ length: size }, (_unused, index) => ({
          eventId: `noise-${batch}-${index}`, eventType: NOISE_EVENT_TYPE, payload,
        })),
        expectedVersion: 0,
      });
      written += size;
    }
    return written;
  }

  /** Walks the SAME public pager the scan walks, so the count is the one the
   *  scan has to get through rather than a private idea of the store's size. */
  function walkGlobalStream(store: SqliteEventStore): readonly StoredEvent[] {
    const seen: StoredEvent[] = [];
    let cursor = 0n;
    for (;;) {
      const page = store.readEventsAfter(cursor, 1_000);
      seen.push(...page.items);
      if (!page.hasMore) return seen;
      const next = page.nextCursor;
      if (next === null || next <= cursor) throw new Error("global cursor did not advance");
      cursor = next;
    }
  }

  /**
   * A SECOND, independently well-formed activation for the SAME effect, on its
   * own aggregate: a distinct idempotency key derives a distinct aggregate and a
   * distinct grantId is a distinct durable event id. This is the genuine
   * ambiguity the scan exists to detect, not a malformed record.
   */
  function seedSecondActivation(store: SqliteEventStore): void {
    const committed = commitActivationLedgerRecord(store, {
      correlationId: "second-activation-correlation",
      decidedAt: "2026-08-15T00:00:05.000Z",
      key: {
        commandId: "second-activation-command", principalId: "principal-1", projectId: PROJECT_ID,
      },
      record: ledgerRecord({
        effectIntent: { ...COMMIT.intent, idempotencyKey: SECOND_IDEMPOTENCY },
        grant: { ...COMMIT.grant, grantId: SECOND_GRANT_ID },
      }),
      requestBytes: new TextEncoder().encode("second-activation-request"),
    });
    if (!committed.ok) throw new Error(`second seed refused: ${committed.code}`);
  }

  it("answers BOUND from the committed intent and the lease owner session", () => {
    withDirectory("bound", (directory) => {
      const databasePath = join(directory, "store.sqlite");
      withStore(databasePath, (store) => {
        seedActivation(store);
        const bound = bindingOver(store);
        expect(bound).toStrictEqual({
          activationDigest: COMMIT.activationDigest, effectId: INTENT_ID, sessionId: SESSION,
          status: "BOUND",
        });
        expect(Object.isFrozen(bound)).toBe(true);
      });
    });
  });

  it("stays BOUND at the deadline millisecond and goes EXPIRED one second later", () => {
    withDirectory("clock", (directory) => {
      const databasePath = join(directory, "store.sqlite");
      withStore(databasePath, (store) => {
        seedActivation(store);
        expect(codeOf(bindingOver(store, INTENT_ID, SESSION, DEADLINE_SECONDS * 1_000))).toBe("BOUND");
        expect(codeOf(bindingOver(store, INTENT_ID, SESSION, DEADLINE_SECONDS * 1_000 + 999)))
          .toBe("BOUND");
        expect(codeOf(bindingOver(store, INTENT_ID, SESSION, DEADLINE_SECONDS * 1_000 + 1_000)))
          .toBe("ABSENT:FOUNDATION_BINDING_LEASE_EXPIRED");
      });
    });
  });

  it("maps every negative and unknown case to its own exact code", () => {
    withDirectory("negatives", (directory) => {
      const databasePath = join(directory, "store.sqlite");
      withStore(databasePath, (store) => {
        seedActivation(store);
        expect(codeOf(bindingOver(store, "intent-absent"))).toBe("ABSENT:FOUNDATION_BINDING_NOT_FOUND");
        expect(codeOf(bindingOver(store, INTENT_ID, "session-other")))
          .toBe("ABSENT:FOUNDATION_BINDING_QUERY_MISMATCH");
        expect(codeOf(bindingOver(store, "", SESSION))).toBe("UNKNOWN:FOUNDATION_BINDING_QUERY_INVALID");
        expect(codeOf(bindingOver(store, INTENT_ID, SESSION, -1)))
          .toBe("UNKNOWN:FOUNDATION_BINDING_QUERY_INVALID");
        expect(codeOf(bindingOver(store, INTENT_ID, SESSION, Number.NaN)))
          .toBe("UNKNOWN:FOUNDATION_BINDING_QUERY_INVALID");
        expect(codeOf(bindingOver(store, INTENT_ID, SESSION, NOW_MILLISECONDS, "other-project")))
          .toBe("UNKNOWN:FOUNDATION_BINDING_PROJECT_MISMATCH");
      });
    });
  });

  it("reports a terminal intent and an inactive lease as their own ABSENT codes", () => {
    withDirectory("terminal", (directory) => {
      const databasePath = join(directory, "store.sqlite");
      withStore(databasePath, (store) => {
        seedActivation(store, ledgerRecord({
          effectIntent: { ...COMMIT.intent, state: "SUCCEEDED" },
        }));
        expect(codeOf(bindingOver(store))).toBe("ABSENT:FOUNDATION_BINDING_TERMINAL");
      });
      const otherPath = join(directory, "other.sqlite");
      withStore(otherPath, (store) => {
        const released = { ...LEASE, state: "RELEASED" as const };
        seedActivation(store, ledgerRecord({
          effectIntent: { ...COMMIT.intent, leaseBinding: released }, lease: released,
        }));
        expect(codeOf(bindingOver(store))).toBe("ABSENT:FOUNDATION_BINDING_LEASE_INACTIVE");
      });
    });
  });

  it("reports an activation whose durable lease disagrees with the intent as INCOHERENT", () => {
    withDirectory("incoherent", (directory) => {
      const databasePath = join(directory, "store.sqlite");
      withStore(databasePath, (store) => {
        seedActivation(store, ledgerRecord({ lease: { ...LEASE, leaseId: "lease-other" } }));
        expect(codeOf(bindingOver(store)))
          .toBe("UNKNOWN:FOUNDATION_BINDING_ACTIVATION_INCOHERENT");
      });
    });
  });

  it("reports a scan it cannot finish as SCAN_INCOMPLETE and a throw as UNREADABLE", () => {
    withDirectory("scan", (directory) => {
      const databasePath = join(directory, "store.sqlite");
      withStore(databasePath, (store) => {
        seedActivation(store);
        const stuck = {
          getHealth: () => store.getHealth(),
          readEvents: (aggregateId: string) => store.readEvents(aggregateId),
          readEventsAfter: () => ({ hasMore: true, items: [], nextCursor: 0n }),
        } as unknown as SqliteEventStore;
        expect(codeOf(readCurrentEffectSessionBinding(stuck, PROJECT_ID, INTENT_ID, SESSION, 0)))
          .toBe("UNKNOWN:FOUNDATION_BINDING_SCAN_INCOMPLETE");
        // A page that DOES carry items but never advances its cursor is the
        // never-ending walk: it would spin forever, or worse, answer ABSENT.
        const stalled = {
          getHealth: () => store.getHealth(),
          readEvents: (aggregateId: string) => store.readEvents(aggregateId),
          readEventsAfter: (after: bigint) => ({
            hasMore: true, items: store.readEventsAfter(after, 100).items, nextCursor: after,
          }),
        } as unknown as SqliteEventStore;
        expect(codeOf(readCurrentEffectSessionBinding(stalled, PROJECT_ID, INTENT_ID, SESSION, 0)))
          .toBe("UNKNOWN:FOUNDATION_BINDING_SCAN_INCOMPLETE");
        const thrower = {
          getHealth: () => store.getHealth(),
          readEvents: (aggregateId: string) => store.readEvents(aggregateId),
          readEventsAfter: () => { throw new Error("injected read failure"); },
        } as unknown as SqliteEventStore;
        expect(codeOf(readCurrentEffectSessionBinding(thrower, PROJECT_ID, INTENT_ID, SESSION, 0)))
          .toBe("UNKNOWN:FOUNDATION_BINDING_EVIDENCE_UNREADABLE");
      });
    });
  });

  /**
   * DEFECT 2's reproduction, and the reason it is a time bomb rather than an
   * edge case: the bound was on TOTAL PROJECT EVENTS, not on anything about this
   * effect. Past it, `readCurrentEffectSessionBinding` stopped finding ANY
   * activation, permanently, for every effect - and it failed closed into a
   * refusal that reads exactly like a legitimate authority answer.
   */
  it("answers BOUND on a store holding more than 6,400 global events", () => {
    withDirectory("scan-scale", (directory) => {
      const databasePath = join(directory, "store.sqlite");
      withStore(databasePath, (store) => {
        seedActivation(store);
        expect(floodGlobalStream(store, EVENTS_PAST_THE_OLD_SCAN_CEILING))
          .toBe(EVENTS_PAST_THE_OLD_SCAN_CEILING);
        // THE CASE WAS ACTUALLY GENERATED. A store that quietly wrote fewer
        // events would satisfy the BOUND assertion below while proving nothing,
        // so the size is asserted against the literal ceiling first.
        const stream = walkGlobalStream(store);
        expect(stream.length).toBeGreaterThan(OLD_SCAN_CEILING);
        expect(stream).toHaveLength(EVENTS_PAST_THE_OLD_SCAN_CEILING + 1);

        expect(bindingOver(store)).toStrictEqual({
          activationDigest: COMMIT.activationDigest, effectId: INTENT_ID, sessionId: SESSION,
          status: "BOUND",
        });
      });
    });
  }, 180_000);

  /**
   * THE INVARIANT THAT MUST SURVIVE THE SCALE FIX.
   *
   * The scan cannot return on first match: it has to keep walking to prove the
   * match UNIQUE. Buying reach by returning early would make the case above pass
   * while turning this correct refusal into a confident wrong answer, so the
   * second activation is placed AFTER the noise - unreachable under the old
   * ceiling by construction, and asserted to be so.
   */
  it("still refuses a SECOND matching activation found past the old 6,400 ceiling", () => {
    withDirectory("scan-scale-ambiguous", (directory) => {
      const databasePath = join(directory, "store.sqlite");
      withStore(databasePath, (store) => {
        seedActivation(store);
        expect(floodGlobalStream(store, EVENTS_PAST_THE_OLD_SCAN_CEILING))
          .toBe(EVENTS_PAST_THE_OLD_SCAN_CEILING);
        seedSecondActivation(store);

        const stream = walkGlobalStream(store);
        expect(stream).toHaveLength(EVENTS_PAST_THE_OLD_SCAN_CEILING + 2);
        const second = stream.find((event) => event.eventId === SECOND_GRANT_ID);
        expect(second).toBeDefined();
        // The second match really does sit past the old ceiling: without this
        // the case could pass on a store where both activations were reachable
        // all along, proving nothing about scale.
        expect(Number(second?.globalPosition ?? 0n)).toBeGreaterThan(OLD_SCAN_CEILING);
        // Both are INDIVIDUALLY well-formed, so this is genuine ambiguity rather
        // than a malformed record the scan would have refused for another reason.
        const activations = stream.filter((event) => event.eventType === "EffectActivationCommitted");
        expect(activations).toHaveLength(2);
        for (const event of activations) {
          expect(readActivationLedgerRecord(event.aggregateId, [event]).ok).toBe(true);
        }

        const answer = bindingOver(store);
        expect(codeOf(answer)).toBe("UNKNOWN:FOUNDATION_BINDING_EVIDENCE_AMBIGUOUS");
        expect(answer.status === "BOUND" ? null : answer.layer)
          .toBe(FOUNDATION_ACTIVATION_BINDING_LAYER);
      });
    });
  }, 180_000);

  it("sweeps hostile query shapes and mutated context, and every case refuses", () => {
    withDirectory("sweep", (directory) => {
      const databasePath = join(directory, "store.sqlite");
      withStore(databasePath, (store) => {
        seedActivation(store);
        const hostile: readonly unknown[] = [
          null, undefined, 42, {}, [], Symbol.iterator, "x".repeat(4_097),
          Object.create({ toString: () => INTENT_ID }),
        ];
        let cases = 0;
        for (const effectId of hostile) {
          for (const sessionId of hostile) {
            cases += 1;
            const answer = readCurrentEffectSessionBinding(
              store, PROJECT_ID, effectId as string, sessionId as string, NOW_MILLISECONDS,
            );
            expect(answer.status).not.toBe("BOUND");
          }
        }
        // The sweep must actually have generated cases: a silently empty sweep
        // satisfies every assertion inside it.
        expect(cases).toBe(hostile.length * hostile.length);
        expect(cases).toBeGreaterThan(0);
      });
    });
  });

  it("refuses every single-byte truncation of a stored transition payload", () => {
    const sealed = encodeFoundationTransition({
      activationDigest: COMMIT.activationDigest, attemptId: ATTEMPT_ID,
      bootstrapCredentialDigest: null, grantId: COMMIT.grant.grantId, intentId: INTENT_ID,
      lockIdentity: null, processIdentity: null, registeredAt: null, tag: "GRANT_CONSUMED",
      wrapperIdentity: WRAPPER,
    });
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    let cases = 0;
    for (let cut = 1; cut <= sealed.bytes.byteLength; cut += 1) {
      cases += 1;
      const truncated = sealed.bytes.subarray(0, sealed.bytes.byteLength - cut);
      const decoded = decodeFoundationTransition(new Uint8Array(truncated));
      expect(decoded.ok).toBe(false);
      if (decoded.ok) continue;
      expect(decoded.code.startsWith("FOUNDATION_TRANSITION_")).toBe(true);
    }
    expect(cases).toBe(sealed.bytes.byteLength);
    expect(cases).toBeGreaterThan(0);
    // A flipped body byte must be caught by the seal, not by the framing.
    const flipped = new Uint8Array(sealed.bytes);
    const target = flipped[10];
    if (target !== undefined) flipped[10] = target ^ 0xff;
    const drifted = decodeFoundationTransition(flipped);
    expect(drifted.ok).toBe(false);
    if (drifted.ok) return;
    expect(drifted.code).toBe("FOUNDATION_TRANSITION_DIGEST_MISMATCH");
  });
});

interface RaceResult {
  readonly code?: string;
  readonly kind: string;
  readonly layer?: string;
}

interface RaceWorker {
  readonly preOpenReady: Promise<void>;
  readonly ready: Promise<void>;
  readonly result: Promise<RaceResult>;
  readonly worker: Worker;
}

function startRaceWorker(
  databasePath: string, gate: SharedArrayBuffer, commandId: string,
): RaceWorker {
  const authorityUrl = pathToFileURL(
    join(import.meta.dirname, "foundation-launch-authority.ts"),
  ).href;
  const storeUrl = import.meta.resolve("@moe/store");
  const script = `
    import { parentPort, workerData } from "node:worker_threads";
    import { createFoundationLauncherAuthority } from ${JSON.stringify(authorityUrl)};
    import { SqliteEventStore } from ${JSON.stringify(storeUrl)};
    const { aggregateId, commandId, databasePath, gate, grant, projectId, wrapperIdentity } = workerData;
    const flags = new Int32Array(gate);
    parentPort.postMessage({ kind: "PREOPEN_READY" });
    Atomics.wait(flags, 0, 0);
    const store = SqliteEventStore.openForProject(databasePath, projectId);
    let result;
    try {
      parentPort.postMessage({ kind: "READY" });
      Atomics.wait(flags, 1, 0);
      const answer = createFoundationLauncherAuthority({
        aggregateId, correlationId: commandId,
        key: { commandId, principalId: "principal-1", projectId },
        projectId, store,
      }).consumeGrantDurably(grant, wrapperIdentity);
      result = answer.kind === "CONSUMED"
        ? { kind: "CONSUMED" }
        : { code: answer.failure.code, kind: answer.kind, layer: answer.failure.layer };
    } catch (error) {
      result = { kind: "THREW", code: String(error) };
    } finally {
      store.close();
    }
    parentPort.postMessage({ kind: "RESULT", result });
  `;
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(script)}`), {
    execArgv: ["--experimental-strip-types"],
    workerData: {
      aggregateId: DERIVED, commandId, databasePath, gate, grant: { ...COMMIT.grant },
      projectId: PROJECT_ID, wrapperIdentity: WRAPPER,
    },
  });
  let resolvePreOpen!: () => void;
  let resolveReady!: () => void;
  let resolveResult!: (value: RaceResult) => void;
  const rejecters: ((error: Error) => void)[] = [];
  const preOpenReady = new Promise<void>((resolve, reject) => {
    resolvePreOpen = resolve;
    rejecters.push(reject);
  });
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejecters.push(reject);
  });
  const result = new Promise<RaceResult>((resolve, reject) => {
    resolveResult = resolve;
    rejecters.push(reject);
  });
  worker.on("message", (message: { kind: string; result?: RaceResult }) => {
    if (message.kind === "PREOPEN_READY") resolvePreOpen();
    else if (message.kind === "READY") resolveReady();
    else if (message.kind === "RESULT" && message.result !== undefined) resolveResult(message.result);
  });
  const fail = (error: Error): void => {
    for (const reject of rejecters) reject(error);
  };
  worker.on("error", fail);
  worker.on("exit", (code) => {
    if (code !== 0) fail(new Error(`race worker exited with code ${code}`));
  });
  return { preOpenReady, ready, result, worker };
}

async function releaseRace(
  gate: SharedArrayBuffer, workers: readonly RaceWorker[],
): Promise<readonly RaceResult[]> {
  const flags = new Int32Array(gate);
  try {
    await Promise.all(workers.map((worker) => worker.preOpenReady));
    Atomics.store(flags, 0, 1);
    Atomics.notify(flags, 0, workers.length);
    await Promise.all(workers.map((worker) => worker.ready));
    Atomics.store(flags, 1, 1);
    Atomics.notify(flags, 1, workers.length);
    return await Promise.all(workers.map((worker) => worker.result));
  } finally {
    await Promise.all(workers.map((worker) => worker.worker.terminate()));
  }
}

describe("foundation grant fence under a real two-connection race", () => {
  it(
    "lets exactly one connection consume the grant and refuses the other",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "moe-foundation-race-"));
      try {
        const databasePath = join(directory, "store.sqlite");
        withStore(databasePath, (store) => {
          seedActivation(store);
        });
        const gate = new SharedArrayBuffer(8);
        const results = await releaseRace(gate, [
          startRaceWorker(databasePath, gate, "race-left"),
          startRaceWorker(databasePath, gate, "race-right"),
        ]);
        // Positive cardinality: a race that produced zero results would satisfy
        // every assertion below vacuously.
        expect(results.length).toBe(2);
        const consumed = results.filter((result) => result.kind === "CONSUMED");
        const refused = results.filter((result) => result.kind !== "CONSUMED");
        expect(consumed).toHaveLength(1);
        expect(refused).toHaveLength(1);
        expect(refused[0]?.code).toBe("GRANT_ALREADY_CONSUMED");
        expect(refused[0]?.layer).toBe("GRANT");

        withStore(databasePath, (reopened) => {
          expect(eventTypes(reopened)).toStrictEqual([
            "EffectActivationCommitted", FOUNDATION_TRANSITION_EVENT_TYPES.GRANT_CONSUMED,
          ]);
          expect(publicEventCount(reopened, FOUNDATION_TRANSITION_EVENT_TYPES.GRANT_CONSUMED))
            .toBe(1);
          expect(publicEventCount(reopened, "EffectActivationCommitted")).toBe(1);
          expect(reopened.getAggregateVersion(DERIVED)).toBe(2);
        });
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
    },
    30_000,
  );
});
