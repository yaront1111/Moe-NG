/**
 * The durable half of the Foundation Claude launch, as the two ports c819's
 * published `createClaudeLauncher` asks a daemon for.
 *
 * It owns NO launch. The runtime pin, the Windows boundary, the OS-exclusive
 * lock, the duplicate resolver and the physical open all stay inside the runner;
 * this module answers exactly `consumeGrantDurably` and `commitProcessRegistration`
 * and appends the answer to df298's EXISTING activation aggregate at exact
 * versions 1, 2 and 3. Sequence 1 is still `EffectActivationCommitted`, written
 * by df298's commit adapter, and nothing here re-derives it.
 *
 * THE PURE LAYER DECIDES WHAT IS ADMISSIBLE; THE STORE DECIDES WHETHER IT HAPPENS.
 * `consumeActivationGrant` says what the one legal consumption of these exact
 * bytes would be, and the compare-and-set at expected version 1 says whether
 * this caller is the one who performed it. Neither alone is a fence: a pure
 * function has no memory of the first call, and a store has no opinion about
 * which wrapper a grant was bound to.
 *
 * A DURABLE PREFLIGHT IS A RESERVATION, NEVER A PRIOR REGISTRATION. The launcher
 * keeps passing its own `prior` (normally null) and this module refuses anything
 * else; handing the persisted preflight back as `prior` would make the launcher
 * refuse its own reservation as a re-presented credential.
 */

import {
  consumeActivationGrant, createClaudeLauncher, parseEffectClaim, supervisorFailure, withLeg,
} from "@moe/runner";
import type {
  ClaudeLaunchOptions, ClaudeLaunchResult, ClaudeLauncherAuthority, ClaudeRegistrationCommit,
  SupervisorErrorCode, SupervisorFailure, SupervisorLayer,
} from "@moe/runner";
import type {
  CommandDecisionKey, CommandDecisionResponse, CommitExpectedVersionDecisionInput, StoredEvent,
} from "@moe/store";

import { readFoundationActivationHistory } from "./activation-ledger-reader.js";
import type { ActivationLedgerRecord } from "./activation-ledger-contracts.js";
import {
  FOUNDATION_TRANSITION_EVENT_TYPES, decodeFoundationTransition, encodeFoundationTransition,
  snapshotFoundationRecord,
} from "./foundation-activation-transition.js";
import type { FoundationTransition, FoundationTransitionTag } from "./foundation-activation-transition.js";

const COMMAND = "foundation.launch";
const COMMIT_KEYS = Object.freeze(["phase", "registration", "claim", "prior"] as const);
const REGISTRATION_KEYS = Object.freeze([
  "lockIdentity", "wrapperIdentity", "processIdentity", "bootstrapCredentialDigest", "registeredAt",
] as const);

/** Version 1/2/3 and sequence 2/3/4 on the aggregate df298 opened at version 0. */
const PHASES = Object.freeze({
  GRANT_CONSUMED: { expectedVersion: 1, leg: "GRANT_CONSUME", sequence: 2 },
  PREFLIGHT_REGISTERED: { expectedVersion: 2, leg: "PREFLIGHT_REGISTER", sequence: 3 },
  PROCESS_OBSERVED: { expectedVersion: 3, leg: "PROCESS_OBSERVE", sequence: 4 },
} as const);

export interface FoundationLaunchStore {
  commitExpectedVersionDecision(input: CommitExpectedVersionDecisionInput): CommandDecisionResponse;
  readEvents(aggregateId: string): readonly StoredEvent[];
}

export interface FoundationLauncherOptions {
  /** df298's derived activation aggregate. This module never re-derives it. */
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly key: CommandDecisionKey;
  readonly projectId: string;
  readonly store: FoundationLaunchStore;
}

type Refusal = { readonly kind: "REFUSED" | "SUSPECT"; readonly failure: SupervisorFailure };

const refusal = (
  kind: "REFUSED" | "SUSPECT", code: SupervisorErrorCode, layer: SupervisorLayer,
  message: string, leg: string | null,
): Refusal => Object.freeze({
  failure: supervisorFailure(code, layer, message, { command: COMMAND, leg, state: null }), kind,
});

const lockRefused = (code: SupervisorErrorCode, message: string, leg: string | null): Refusal =>
  refusal("REFUSED", code, "LAUNCH_LOCK", message, leg);
const lockSuspect = (message: string, leg: string): Refusal =>
  refusal("SUSPECT", "LAUNCH_LOCK_SUSPECT", "LAUNCH_LOCK", message, leg);
const activationDrift = (kind: "REFUSED" | "SUSPECT", message: string, leg: string): Refusal =>
  refusal(kind, "ACTIVATION_COMMIT_INCOHERENT", "ACTIVATION", message, leg);

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => right[index] === byte);
}

type Persisted =
  | { readonly ok: true; readonly transition: FoundationTransition }
  | { readonly ok: false; readonly reason: "CONFLICT" | "DRIFT" | "MALFORMED" | "SUSPECT" };

const failed = (reason: "CONFLICT" | "DRIFT" | "MALFORMED" | "SUSPECT"): Persisted =>
  Object.freeze({ ok: false as const, reason });

export function createFoundationLauncherAuthority(
  options: FoundationLauncherOptions,
): ClaudeLauncherAuthority {
  const { aggregateId, correlationId, key, projectId, store } = options;

  interface Durable { readonly record: ActivationLedgerRecord;
    readonly transitions: readonly FoundationTransition[]; readonly decidedAt: string }

  /** The committed activation and its admitted tail, or nothing. Never partial. */
  function durable(): Durable | null {
    let events: readonly StoredEvent[];
    try {
      events = store.readEvents(aggregateId);
    } catch {
      return null;
    }
    const history = readFoundationActivationHistory(aggregateId, events, projectId);
    const initial = events[0];
    if (!history.ok || initial === undefined) return null;
    return {
      decidedAt: initial.committedAt, record: history.history.record,
      transitions: history.history.transitions,
    };
  }

  /**
   * One append, at this phase's exact version. A REPLAYED disposition is only
   * authoritative once BOTH the stored command result and the persisted event at
   * this phase's sequence byte-match what this call would have written: the
   * store's replay identity does not cover the events array, so a replay can
   * otherwise report success for bytes nobody committed.
   */
  function persist(tag: FoundationTransitionTag, value: unknown, decidedAt: string): Persisted {
    const encoded = encodeFoundationTransition(value);
    if (!encoded.ok) return failed("MALFORMED");
    const phase = PHASES[tag];
    let response: CommandDecisionResponse;
    try {
      response = store.commitExpectedVersionDecision({
        commandKind: COMMAND,
        committedResultBytes: encoded.bytes,
        correlationId: `${correlationId}:${tag}`,
        decidedAt,
        events: [{
          eventId: `${encoded.transition.grantId}:${tag}`,
          eventType: FOUNDATION_TRANSITION_EVENT_TYPES[tag], payload: encoded.bytes,
        }],
        expectedVersion: phase.expectedVersion,
        key: { ...key, commandId: `${key.commandId}:${tag}` },
        requestBytes: encoded.bytes,
        targetAggregateId: aggregateId,
      });
    } catch {
      return failed("SUSPECT");
    }
    if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") return failed("CONFLICT");
    if (response.disposition !== "REPLAYED") {
      return Object.freeze({ ok: true as const, transition: encoded.transition });
    }
    if (!sameBytes(response.decision.resultBytes, encoded.bytes)) return failed("DRIFT");
    let stored: readonly StoredEvent[];
    try {
      stored = store.readEvents(aggregateId);
    } catch {
      return failed("SUSPECT");
    }
    const event = stored[phase.sequence - 1];
    if (event === undefined || !sameBytes(event.payload, encoded.bytes)) return failed("DRIFT");
    const decoded = decodeFoundationTransition(event.payload);
    return decoded.ok ? Object.freeze({ ok: true as const, transition: decoded.transition })
      : failed("DRIFT");
  }

  /**
   * The durable grant CAS. The pure transition runs FIRST as the oracle of what
   * one legal consumption of these bytes looks like, then the caller's grant is
   * equality-checked against the committed activation, and only then does the
   * append decide whether this caller is the one who consumed it.
   */
  function consumeGrantDurably(grant: unknown, wrapperIdentity: unknown): unknown {
    const leg = PHASES.GRANT_CONSUMED.leg;
    const admissible = consumeActivationGrant(grant, wrapperIdentity);
    if (admissible.kind !== "CONSUMED") {
      return Object.freeze({ failure: withLeg(admissible.failure, leg), kind: "REFUSED" as const });
    }
    const evidence = durable();
    if (evidence === null) {
      return activationDrift("SUSPECT", "the committed activation cannot be read", leg);
    }
    const { record } = evidence;
    if (record.grant.grantId !== admissible.grant.grantId
      || record.grant.intentId !== admissible.grant.intentId
      || record.grant.wrapperIdentity !== admissible.grant.wrapperIdentity) {
      return activationDrift("REFUSED", "this grant is not the committed activation's grant", leg);
    }
    const written = persist("GRANT_CONSUMED", {
      activationDigest: record.activationDigest, attemptId: record.attempt.attemptId,
      bootstrapCredentialDigest: null, grantId: record.grant.grantId,
      intentId: record.effectIntent.intentId, lockIdentity: null, processIdentity: null,
      registeredAt: null, tag: "GRANT_CONSUMED", wrapperIdentity: record.grant.wrapperIdentity,
    }, evidence.decidedAt);
    if (!written.ok) {
      if (written.reason === "CONFLICT") {
        return refusal("REFUSED", "GRANT_ALREADY_CONSUMED", "GRANT",
          "this grant has already been consumed durably", leg);
      }
      if (written.reason === "SUSPECT") {
        return activationDrift("SUSPECT", "the durable grant fence did not answer", leg);
      }
      return activationDrift("REFUSED", "the durable grant answer is not this consumption", leg);
    }
    // The successor is derived from the COMMITTED grant, never from the caller's
    // copy: a replay must answer about the activation the store holds.
    return Object.freeze({
      grant: Object.freeze({
        grantId: written.transition.grantId, intentId: written.transition.intentId,
        state: "CONSUMED" as const, version: record.grant.version + 1,
        wrapperIdentity: written.transition.wrapperIdentity,
      }),
      kind: "CONSUMED" as const, ok: true as const, versionDelta: 1 as const,
    });
  }

  function commitProcessRegistration(commit: ClaudeRegistrationCommit): unknown {
    const raw = snapshotFoundationRecord(commit, COMMIT_KEYS);
    const phase = raw?.["phase"];
    const tag: FoundationTransitionTag | null = phase === "PREFLIGHT" ? "PREFLIGHT_REGISTERED"
      : phase === "STARTED" ? "PROCESS_OBSERVED" : null;
    if (raw === null || tag === null) {
      return lockRefused("LAUNCH_LOCK_MALFORMED", "the registration names no declared phase", null);
    }
    const leg = PHASES[tag].leg;
    const registration = snapshotFoundationRecord(raw["registration"], REGISTRATION_KEYS);
    const claim = parseEffectClaim(raw["claim"]);
    if (registration === null || claim === null) {
      return lockRefused("LAUNCH_LOCK_MALFORMED", "the launch registration does not parse", leg);
    }
    // A persisted PREFLIGHT is a reservation; the launcher's own prior stays null.
    if (raw["prior"] !== null) {
      return lockRefused("LAUNCH_LOCK_IDENTITY_CONFLICT",
        "this durable lock accepts no caller-supplied prior registration", leg);
    }
    const evidence = durable();
    if (evidence === null) return lockSuspect("the committed activation cannot be read", leg);
    const { record, transitions } = evidence;
    const required = tag === "PREFLIGHT_REGISTERED" ? "GRANT_CONSUMED" : "PREFLIGHT_REGISTERED";
    const index = tag === "PREFLIGHT_REGISTERED" ? 0 : 1;
    if (transitions[index]?.tag !== required
      || registration["wrapperIdentity"] !== claim.wrapperIdentity
      || registration["wrapperIdentity"] !== record.grant.wrapperIdentity
      || registration["lockIdentity"] !== claim.lockIdentity
      || claim.intentId !== record.effectIntent.intentId) {
      return lockRefused("LAUNCH_LOCK_IDENTITY_CONFLICT",
        "the registration does not bind this activation, wrapper and lock", leg);
    }
    const registeredAt = registration["registeredAt"];
    const written = persist(tag, {
      activationDigest: record.activationDigest, attemptId: record.attempt.attemptId,
      bootstrapCredentialDigest: registration["bootstrapCredentialDigest"],
      grantId: record.grant.grantId, intentId: record.effectIntent.intentId,
      lockIdentity: registration["lockIdentity"], processIdentity: registration["processIdentity"],
      registeredAt, tag, wrapperIdentity: record.grant.wrapperIdentity,
    }, typeof registeredAt === "string" ? registeredAt : evidence.decidedAt);
    if (!written.ok) {
      if (written.reason === "SUSPECT") return lockSuspect("the durable lock did not answer", leg);
      if (written.reason === "MALFORMED") {
        return lockRefused("LAUNCH_LOCK_MALFORMED", "the launch registration does not parse", leg);
      }
      return lockRefused("LAUNCH_LOCK_IDENTITY_CONFLICT",
        "this launch phase is already registered under another command", leg);
    }
    const stored = written.transition;
    return Object.freeze({
      kind: "REGISTERED" as const, ok: true as const,
      registration: Object.freeze({
        bootstrapCredentialDigest: stored.bootstrapCredentialDigest ?? "",
        lockIdentity: stored.lockIdentity ?? "", processIdentity: stored.processIdentity ?? "",
        registeredAt: stored.registeredAt ?? "", wrapperIdentity: stored.wrapperIdentity,
      }),
    });
  }

  return Object.freeze({ commitProcessRegistration, consumeGrantDurably });
}

/**
 * The composed launcher task-6cbff01023b14b26a78fc5e3eb1dd8a9 consumes.
 *
 * It exists so the downstream dispatcher takes c819's published seam WITH this
 * daemon's durable ports already bound, rather than reconstructing the overlay
 * and re-deciding which of the ten launcher dependencies it may replace.
 */
export function createFoundationClaudeLauncher(
  options: FoundationLauncherOptions,
): (value: unknown, launchOptions?: ClaudeLaunchOptions) => Promise<ClaudeLaunchResult> {
  return createClaudeLauncher(createFoundationLauncherAuthority(options));
}
