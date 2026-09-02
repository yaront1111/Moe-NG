/**
 * Focused coverage for the two durable resolvers policy.validate consults.
 *
 * The waiver half is the CONSUMER EDGE of the landed strict reader (task-e91e505e). It mints no
 * refusal vocabulary of its own: every hostile case below asserts the reader's own exact stable
 * code at literal `DAEMON_POLICY_WAIVER` AND that the resolver collapses that same store/input to
 * `RESOLVED_EMPTY`. Asserting only the collapse would pass for a resolver that refused everything
 * for the wrong reason, or for no reason at all.
 */
import type { PolicyObligation, PolicyObligationKind, PolicySlice } from "@moe/core";
import { EVENT_RECORD_VERSION, OPAQUE_PAYLOAD_CODEC_VERSION } from "@moe/store";
import type { StoredEvent } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { closeStores, openStore } from "./bootstrap-test-fixtures.js";
import {
  resolvePolicyFact,
  resolvePolicyWaivers,
} from "./policy-fact-resolver.js";
import type {
  PolicyWaiverResolutionInput,
  PolicyWaiverResolutionStore,
} from "./policy-fact-resolver.js";
import {
  buildPolicyWaiverGrant,
  buildPolicyWaiverRevoke,
  policyWaiverAggregateIdFor,
} from "./policy-waiver-record.js";
import type { PolicyWaiverGrantRecord, PolicyWaiverRecord } from "./policy-waiver-record.js";
import { readPolicyWaiver } from "./policy-waiver-reader.js";

const HOSTILE_ACTIONS = Object.freeze([
  "effect.activate", "operator.override", "../policy/admin",
] as const);

describe("resolvePolicyFact", () => {
  afterEach(closeStores);

  it("returns the exact auditable unknown-risk fact", () => {
    const store = openStore();
    expect(resolvePolicyFact(store, "project-1", "principal-1", "effect.activate")).toEqual({
      factId: "policy-risk-unclassifiable:sha256:d1b00b797dc06790e122914a3255ba4130e9588d01146ab81311b2fa0c54fa42",
      tier: null,
      truthClass: "UNKNOWN",
    });
  });

  it("accepts the store, project, authenticated principal, and evaluated action", () => {
    expect(resolvePolicyFact).toHaveLength(4);
  });

  it("keeps hostile caller-requested actions non-authoritative", () => {
    const store = openStore();
    const facts = HOSTILE_ACTIONS.map((action) =>
      resolvePolicyFact(store, "project-1", "principal-1", action));

    expect(HOSTILE_ACTIONS).toHaveLength(3);
    expect(new Set(HOSTILE_ACTIONS).size).toBe(3);
    expect(facts).toHaveLength(HOSTILE_ACTIONS.length);
    expect(new Set(facts.map((fact) => fact.factId)).size).toBe(HOSTILE_ACTIONS.length);
    for (const fact of facts) {
      expect(Object.isFrozen(fact)).toBe(true);
      expect(fact.tier).toBeNull();
      expect(fact.truthClass).toBe("UNKNOWN");
      expect(Object.keys(fact)).toEqual(["factId", "tier", "truthClass"]);
    }
  });
});

const PROJECT_ID = "project.waiver-consumer";
const PRINCIPAL = "principal.waiver-consumer";
const ACTION = "policy.validate";
const POLICY_REVISION = "7".repeat(64);
const OTHER_POLICY_REVISION = "9".repeat(64);
const OBLIGATION = "obligation.soft.waivable";
const SCOPE = Object.freeze(["scope.alpha", "scope.beta"] as const);
const APPROVED_AT = "2026-09-01T00:00:00.000Z";
const APPROVED_MS = Date.parse(APPROVED_AT);
const EXPIRES_MS = APPROVED_MS + 3_600_000;
const EVALUATED_MS = EXPIRES_MS - 1;
const STEP_UP = "step-up:waiver-consumer";
const REASON = "human approved waiver for the consumer-edge suite";
const EXPECTED_LAYER = "DAEMON_POLICY_WAIVER";

interface Built {
  readonly bytes: Uint8Array;
  readonly eventType: string;
  readonly record: Readonly<PolicyWaiverRecord>;
}
interface GrantOver {
  readonly actionKind?: string;
  readonly approvedBy?: string;
  readonly commandId?: string;
  readonly expiresAtEpochMs?: number;
  readonly namedObligationId?: string;
  readonly policyRevisionRef?: string;
  readonly projectId?: string;
  readonly scope?: readonly string[];
}

function grant(over: GrantOver = {}): {
  readonly bytes: Uint8Array; readonly eventType: string;
  readonly record: PolicyWaiverGrantRecord;
} {
  const built = buildPolicyWaiverGrant({
    actionKind: over.actionKind ?? ACTION,
    approvedAt: APPROVED_AT,
    approvedBy: over.approvedBy ?? PRINCIPAL,
    commandId: over.commandId ?? "command.waiver-consumer-1",
    decisionReason: REASON,
    expiresAtEpochMs: over.expiresAtEpochMs ?? EXPIRES_MS,
    namedObligationId: over.namedObligationId ?? OBLIGATION,
    policyRevisionRef: over.policyRevisionRef ?? POLICY_REVISION,
    projectId: over.projectId ?? PROJECT_ID,
    scope: [...(over.scope ?? SCOPE)],
    stepUpAuthRef: STEP_UP,
    supersedesWaiverRef: null,
  });
  if (!built.ok) throw new Error(`grant fixture refused: ${built.code}`);
  return built;
}

function revoke(target: PolicyWaiverGrantRecord, commandId: string): Built {
  const built = buildPolicyWaiverRevoke({
    actionKind: target.actionKind,
    approvedAt: APPROVED_AT,
    approvedBy: target.approvedBy,
    commandId,
    decisionReason: REASON,
    namedObligationId: target.namedObligationId,
    policyRevisionRef: target.policyRevisionRef,
    projectId: target.projectId,
    revokedWaiverRef: target.waiverRef,
    scope: [...target.scope],
    stepUpAuthRef: STEP_UP,
  });
  if (!built.ok) throw new Error(`revoke fixture refused: ${built.code}`);
  return built;
}

function storedEvent(
  aggregateId: string, sequence: number, eventType: string, payload: Uint8Array,
): StoredEvent {
  return {
    aggregateId,
    aggregateSequence: sequence,
    commandId: `command-${aggregateId}-${sequence}`,
    committedAt: APPROVED_AT,
    domainSchemaVersion: "moe-domain/1",
    eventId: `${aggregateId}#${sequence}`,
    eventType,
    globalPosition: BigInt(sequence),
    metadata: new Uint8Array(),
    payload,
    payloadCodecVersion: OPAQUE_PAYLOAD_CODEC_VERSION,
    recordVersion: EVENT_RECORD_VERSION,
    requestSha256: "0".repeat(64),
  };
}

/**
 * `getAggregateVersion` answers the SAME number the fold reports as `observedVersion` — the
 * writer compares exactly those two (policy-waiver-leg.ts:183) — so the honest fake reports the
 * event count. `versionOverride` exists only to move that answer under the resolver's fence.
 */
function fakeStore(
  aggregates: ReadonlyMap<string, readonly StoredEvent[]>,
  versionOverride?: (aggregateId: string) => number,
): PolicyWaiverResolutionStore {
  return {
    enumerateAggregateIdsByPrefix: (prefix: string) =>
      [...aggregates.keys()].filter((id) => id.startsWith(prefix)).sort(),
    getAggregateVersion: (aggregateId: string) =>
      versionOverride?.(aggregateId) ?? (aggregates.get(aggregateId)?.length ?? 0),
    readEvents: (aggregateId: string) => aggregates.get(aggregateId) ?? [],
  };
}

function aggregatesOf(entries: readonly Built[]): Map<string, StoredEvent[]> {
  const byAggregate = new Map<string, StoredEvent[]>();
  for (const entry of entries) {
    const aggregateId = policyWaiverAggregateIdFor(entry.record);
    const events = byAggregate.get(aggregateId) ?? [];
    events.push(storedEvent(aggregateId, events.length + 1, entry.eventType, entry.bytes));
    byAggregate.set(aggregateId, events);
  }
  return byAggregate;
}

const storeOf = (...entries: readonly Built[]): PolicyWaiverResolutionStore =>
  fakeStore(aggregatesOf(entries));

const named = (kind: PolicyObligationKind, obligationId = OBLIGATION): PolicyObligation =>
  ({ kind, obligationId });

function obligationSlice(sliceRef: string, obligations: readonly PolicyObligation[]): PolicySlice {
  return {
    autoApprovalOptIns: [],
    rules: [{ effect: "ALLOW", obligations, requiredFactIds: [], ruleId: `${sliceRef}.rule` }],
    sliceRef,
  };
}
const softChain = (): readonly PolicySlice[] => [obligationSlice("slice.root", [named("SOFT")])];

function resolutionInput(
  over: Partial<PolicyWaiverResolutionInput> = {},
): PolicyWaiverResolutionInput {
  return {
    authenticatedPrincipal: PRINCIPAL,
    evaluatedAction: ACTION,
    evaluatedAtEpochMs: EVALUATED_MS,
    installedPolicyRevisionRef: POLICY_REVISION,
    installedSliceChain: softChain(),
    projectId: PROJECT_ID,
    scope: [...SCOPE],
    ...over,
  };
}

/**
 * A refusal case names the store, the resolver input, and the reader code that is the ONLY
 * mechanism able to refuse it. Both halves are asserted per case: the reader's exact code and
 * layer, and the resolver's collapse to the fail-closed default.
 */
interface RefusalCase {
  readonly code: string;
  readonly input: PolicyWaiverResolutionInput;
  readonly name: string;
  readonly store: PolicyWaiverResolutionStore;
}

const revokedGrant = grant({ commandId: "command.waiver-consumer-revoked" });
const corruptAggregateId = policyWaiverAggregateIdFor(grant().record);

/**
 * A grant that is well-formed in every way EXCEPT that its stored `humanApprovalRef` does not
 * bind to the record. Exact keys, exact types, a real derived-looking ref: the only thing wrong
 * is the binding, so nothing upstream of the record codec's re-derivation can refuse it.
 */
function forgedApprovalRefGrant(): Built {
  const authentic = grant();
  const raw = JSON.parse(new TextDecoder().decode(authentic.bytes)) as Record<string, unknown>;
  raw["humanApprovalRef"] = `approval:policy-waiver:sha256:${"c".repeat(64)}`;
  return {
    bytes: new TextEncoder().encode(JSON.stringify(raw)),
    eventType: authentic.eventType,
    record: authentic.record,
  };
}

/** Immutable roster; its EXACT size is asserted below so a silently shrunk sweep cannot pass. */
const REFUSAL_CASES: readonly RefusalCase[] = Object.freeze([
  {
    code: "POLICY_WAIVER_RECORD_MISSING",
    input: resolutionInput(),
    name: "no durable grant at all",
    store: storeOf(),
  },
  {
    code: "POLICY_WAIVER_RECORD_UNREADABLE",
    input: resolutionInput(),
    name: "tampered aggregate bytes",
    store: fakeStore(new Map([[
      corruptAggregateId,
      [storedEvent(corruptAggregateId, 1, "PolicyWaiverGranted.v1", new Uint8Array([0x7b, 0x7d]))],
    ]])),
  },
  {
    code: "POLICY_WAIVER_RECORD_UNREADABLE",
    input: resolutionInput(),
    name: "humanApprovalRef does not bind to the record",
    store: storeOf(forgedApprovalRefGrant()),
  },
  {
    code: "POLICY_WAIVER_EXPIRED",
    input: resolutionInput({ evaluatedAtEpochMs: EXPIRES_MS }),
    name: "expiry is exclusive at the evaluation instant",
    store: storeOf(grant()),
  },
  {
    code: "POLICY_WAIVER_REVOKED",
    input: resolutionInput(),
    name: "revoked grant",
    store: storeOf(revokedGrant, revoke(revokedGrant.record, "command.waiver-consumer-revoke")),
  },
  {
    code: "POLICY_WAIVER_PROJECT_FOREIGN",
    input: resolutionInput(),
    name: "grant belongs to another project",
    store: storeOf(grant({ projectId: "project.other" })),
  },
  {
    code: "POLICY_WAIVER_PRINCIPAL_FOREIGN",
    input: resolutionInput(),
    name: "grant approved for another principal",
    store: storeOf(grant({ approvedBy: "principal.other" })),
  },
  {
    code: "POLICY_WAIVER_ACTION_FOREIGN",
    input: resolutionInput(),
    name: "grant names another action",
    store: storeOf(grant({ actionKind: "goal.close" })),
  },
  {
    code: "POLICY_WAIVER_POLICY_STALE",
    input: resolutionInput(),
    name: "grant bound to a superseded policy revision",
    store: storeOf(grant({ policyRevisionRef: OTHER_POLICY_REVISION })),
  },
  {
    code: "POLICY_WAIVER_OBLIGATION_FOREIGN",
    input: resolutionInput(),
    name: "grant names an obligation the chain does not",
    store: storeOf(grant({ namedObligationId: "obligation.soft.elsewhere" })),
  },
  {
    code: "POLICY_WAIVER_SCOPE_FOREIGN",
    input: resolutionInput({ scope: ["scope.alpha"] }),
    name: "granted scope is WIDER than the evaluation scope",
    store: storeOf(grant()),
  },
  {
    // The other direction, and the one that actually grades set-equality. Core's own
    // `waiverCovers` accepts a granted scope that is a nonempty SUBSET of the evaluation scope
    // (policy-composition.ts:70); the reader is deliberately narrower and demands equality, so
    // this case is refused HERE and nowhere downstream. Without it, relaxing `sameScopeSet` to a
    // subset test leaves the whole suite green — measured, not assumed.
    code: "POLICY_WAIVER_SCOPE_FOREIGN",
    input: resolutionInput({ scope: ["scope.alpha", "scope.beta", "scope.gamma"] }),
    name: "granted scope is NARROWER than the evaluation scope",
    store: storeOf(grant()),
  },
  {
    code: "POLICY_WAIVER_NOT_SOFT",
    input: resolutionInput({
      installedSliceChain: [obligationSlice("slice.root", [named("HARD")])],
    }),
    name: "the named obligation is HARD in the installed chain",
    store: storeOf(grant()),
  },
  {
    // soft=1, hard=1. The guard is a CONJUNCTION (`soft === 1 && hard === 0`,
    // policy-waiver-reader.ts:175) and the hard-only case above satisfies the first conjunct's
    // refusal on its own, so without this case relaxing `hard === 0` leaves the suite green.
    code: "POLICY_WAIVER_NOT_SOFT",
    input: resolutionInput({
      installedSliceChain: [obligationSlice("slice.root", [named("SOFT"), named("HARD")])],
    }),
    name: "the named obligation is declared both SOFT and HARD",
    store: storeOf(grant()),
  },
  {
    // soft=2, hard=0. Ambiguity: two SOFT declarations leave no single obligation to relax. This
    // is the case that makes `soft === 1` load-bearing rather than `soft >= 1`.
    code: "POLICY_WAIVER_NOT_SOFT",
    input: resolutionInput({
      installedSliceChain: [
        obligationSlice("slice.root", [named("SOFT")]),
        obligationSlice("slice.second", [named("SOFT")]),
      ],
    }),
    name: "the named obligation is declared SOFT twice",
    store: storeOf(grant()),
  },
] as const);

describe("resolvePolicyWaivers - the consumer edge of the strict reader", () => {
  it("takes the durable store and the server-owned resolution operands", () => {
    expect(resolvePolicyWaivers).toHaveLength(2);
  });

  it("resolves empty - not absent - when no durable grant exists", () => {
    const resolved = resolvePolicyWaivers(storeOf(), resolutionInput());

    expect(resolved).toEqual({ consumed: [], status: "RESOLVED_EMPTY", waivers: [] });
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.waivers)).toBe(true);
  });

  it("yields the verified waiver, and only its five canonical fields, on a full join", () => {
    const accepted = grant();
    const resolved = resolvePolicyWaivers(storeOf(accepted), resolutionInput());

    expect(resolved.status).toBe("RESOLVED_VERIFIED");
    expect(resolved.waivers).toHaveLength(1);
    expect(resolved.waivers[0]).toEqual({
      expiresAtEpochMs: EXPIRES_MS,
      humanApprovalRef: accepted.record.humanApprovalRef,
      namedObligationId: OBLIGATION,
      scope: [...SCOPE],
      waiverRef: accepted.record.waiverRef,
    });
  });

  it("carries the read-only expected-version leg for each consumed aggregate", () => {
    const accepted = grant();
    const aggregateId = policyWaiverAggregateIdFor(accepted.record);
    const resolved = resolvePolicyWaivers(storeOf(accepted), resolutionInput());

    expect(resolved.consumed).toEqual([{ aggregateId, observedVersion: 1 }]);
  });

  it("refuses a grant whose aggregate moved between the read and the fence", () => {
    const accepted = grant();
    const moved = fakeStore(aggregatesOf([accepted]), () => 2);

    expect(resolvePolicyWaivers(moved, resolutionInput()))
      .toEqual({ consumed: [], status: "RESOLVED_EMPTY", waivers: [] });
  });

  it("asks the reader once per DISTINCT obligation named by the installed chain", () => {
    const asked: string[] = [];
    const accepted = grant();
    const aggregates = aggregatesOf([accepted]);
    const observed: PolicyWaiverResolutionStore = {
      enumerateAggregateIdsByPrefix: (prefix) => {
        asked.push(prefix);
        return [...aggregates.keys()].filter((id) => id.startsWith(prefix)).sort();
      },
      getAggregateVersion: (aggregateId) => aggregates.get(aggregateId)?.length ?? 0,
      readEvents: (aggregateId) => aggregates.get(aggregateId) ?? [],
    };
    // The SECOND id is named twice, across two rules. Two DISTINCT ids means two reads, not
    // three. It also makes that second id ambiguous, so only the singly-named OBLIGATION is
    // uniquely SOFT and therefore verifiable — the reader's judgement, not this edge's.
    const chain: readonly PolicySlice[] = [{
      autoApprovalOptIns: [],
      rules: [
        {
          effect: "ALLOW",
          obligations: [named("SOFT"), named("SOFT", "obligation.soft.second")],
          requiredFactIds: [], ruleId: "slice.root.rule-a",
        },
        {
          effect: "ALLOW", obligations: [named("SOFT", "obligation.soft.second")],
          requiredFactIds: [], ruleId: "slice.root.rule-b",
        },
      ],
      sliceRef: "slice.root",
    }];

    const resolved = resolvePolicyWaivers(observed, resolutionInput({ installedSliceChain: chain }));

    expect(asked).toHaveLength(2);
    expect(resolved.waivers).toHaveLength(1);
  });

  describe("every hostile record the reader distinguishes yields no authority", () => {
    it("pins the exact roster size so a silently emptied sweep cannot pass", () => {
      expect(REFUSAL_CASES).toHaveLength(15);
      expect(new Set(REFUSAL_CASES.map((entry) => entry.code)).size).toBe(11);
      // Three codes are reached more than one independent way, which is why 15 cases carry 11
      // codes. NOT_SOFT carries three because its guard is a conjunction over two counters, and
      // one case per way of failing it is what keeps each conjunct load-bearing.
      const multiplyReached = Object.freeze({
        POLICY_WAIVER_NOT_SOFT: 3,
        POLICY_WAIVER_RECORD_UNREADABLE: 2,
        POLICY_WAIVER_SCOPE_FOREIGN: 2,
      });
      for (const [code, reached] of Object.entries(multiplyReached)) {
        expect(REFUSAL_CASES.filter((entry) => entry.code === code)).toHaveLength(reached);
      }
    });

    it.each(REFUSAL_CASES)("$name -> $code", ({ code, input, store }) => {
      const read = readPolicyWaiver(store, { ...input, namedObligationId: OBLIGATION });
      if (read.ok) throw new Error(`expected reader refusal ${code}, got an accepted waiver`);
      expect(read.code).toBe(code);
      expect(read.layer).toBe(EXPECTED_LAYER);

      const resolved = resolvePolicyWaivers(store, input);
      expect(resolved.status).toBe("RESOLVED_EMPTY");
      expect(resolved.waivers).toHaveLength(0);
      expect(resolved.consumed).toHaveLength(0);
    });
  });
});
