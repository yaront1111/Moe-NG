/**
 * The typed `SOFT_POLICY_WAIVER` arm of `approval.decide`.
 *
 * This file owns the arm's EXACT SHAPE, its DENOMINATORS and its durable behaviour.
 * Every expectation is written independently of the production rosters and of the
 * production derivations — the literal key sets, the literal member counts and the
 * 64-hex digest exemplars appear on BOTH sides, so no single edit can move an
 * assertion and the thing it measures at once.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import type { CommandDecisionKey, CommitExpectedVersionDecisionLegsInput,
  ExpectedVersionDecisionLeg } from "@moe/store";
import { afterAll, describe, expect, it } from "vitest";

import { DomainRefusal } from "../daemon-command-dispatch.js";
import { observeReplayMarker } from "../identity/session-authority-replay-marker.js";
import {
  POLICY_WAIVER_BRANCH_CODES, POLICY_WAIVER_DECISION_KIND, POLICY_WAIVER_GRANT_KEYS,
  POLICY_WAIVER_OPERATIONS, POLICY_WAIVER_OUTER_KEYS, POLICY_WAIVER_REVOKE_KEYS,
  isPolicyWaiverDecideCandidate, runPolicyWaiverDecideCommand,
  type PolicyWaiverCommandInput,
} from "./policy-waiver-command.js";

const PROJECT = "proj-policy-waiver-command";
const OPERATOR = "operator-policy-waiver";
const DECIDED_AT = "2026-08-30T12:00:00.000Z";
const ADMIN = "project.admin";
const decoder = new TextDecoder();

/**
 * Recomputed OUT OF BAND with `node --experimental-strip-types` against the landed
 * contract and written here as literals. The production module derives them again; a
 * derivation that drifts reddens against these constants rather than against itself.
 */
const GRANT_AGGREGATE_ID =
  "policy-waiver:aggregate:v1:sha256:833237f1afc51d29d02f082daa3b47db61a493d76d108e5df07b16a663999acc";
const GRANT_STEP_UP_REF =
  "59f3f929fd55a4e51cfeb67b64f3a1d29d6a6fa0aea9874ddf09a3f83a5c7299";
const GRANT_MARKER_AGGREGATE_ID = `moe.session-authority.v1/replay/${GRANT_STEP_UP_REF}`;
const SUPERSEDING_STEP_UP_REF =
  "ed52af6146474f373f3c3586d4f5e740b132119472ab8e4d3fa941a25bbca2e8";
const REVOKE_STEP_UP_REF =
  "72f14225ad3e35744a651ea85cd8022b2b50b4c1e15e39407665642ab716834c";
const MARKER_FIXTURE_STEP_UP_REF =
  "c16323ac92d392d41596e4caedcd91ff0a3b1a0ef8db64b7e65cb3021536861b";
const GRANT_HUMAN_APPROVAL_REF =
  "approval:policy-waiver:sha256:b084348d0ac16cf75c5ee49e64639a0357252f2b29ca807a7fb685e0540c1a8b";
const GRANT_WAIVER_REF =
  "policy-waiver:sha256:8b54c5b02f0644245be2a59ce41326c848bec551647d8bea5b9e15476d8d2a0e";
const EXPIRES_AT = "2026-08-30T18:00:00.000Z";
const EXPIRES_AT_EPOCH_MS = 1_788_112_800_000;
const REASON = "operator accepts the residual risk for one shift";

const stores: SqliteEventStore[] = [];
const directories: string[] = [];

function newStore(): SqliteEventStore {
  const directory = mkdtempSync(join(tmpdir(), "moe-policy-waiver-command-"));
  const store = SqliteEventStore.openForProject(join(directory, "store.db"), PROJECT);
  directories.push(directory);
  stores.push(store);
  return store;
}

afterAll(() => {
  for (const store of stores) store.close();
  for (const directory of directories) rmSync(directory, { force: true, recursive: true });
});

/**
 * Written out rather than imported from the module under test. A roster the test
 * reads back from its own subject cannot detect a member being removed from it.
 */
const EXPECTED_OUTER_KEYS: readonly string[] = Object.freeze(["command"]);
const EXPECTED_GRANT_KEYS: readonly string[] = Object.freeze([
  "actionKind", "decisionKind", "decisionReason", "expiresAt",
  "namedObligationId", "operation", "policyRevisionRef", "scope",
]);
const EXPECTED_REVOKE_KEYS: readonly string[] = Object.freeze([
  "actionKind", "decisionKind", "decisionReason",
  "namedObligationId", "operation", "policyRevisionRef", "scope",
]);
const EXPECTED_OPERATIONS: readonly string[] = Object.freeze(["GRANT", "REVOKE"]);
const EXPECTED_BRANCH_CODES: readonly string[] = Object.freeze([
  "POLICY_WAIVER_ADMIN_REQUIRED", "POLICY_WAIVER_HUMAN_REQUIRED",
  "POLICY_WAIVER_PAYLOAD_INVALID",
]);

const GRANT_COMMAND: Readonly<Record<string, unknown>> = Object.freeze({
  actionKind: "plan.apply",
  decisionKind: "SOFT_POLICY_WAIVER",
  decisionReason: REASON,
  expiresAt: EXPIRES_AT,
  namedObligationId: "obligation-secondary-review",
  operation: "GRANT",
  policyRevisionRef: "policy-revision-2026-08-30",
  scope: Object.freeze(["repo:moe-next", "task:task-4704a298"]),
});

const REVOKE_COMMAND: Readonly<Record<string, unknown>> = Object.freeze({
  actionKind: "plan.apply",
  decisionKind: "SOFT_POLICY_WAIVER",
  decisionReason: REASON,
  namedObligationId: "obligation-secondary-review",
  operation: "REVOKE",
  policyRevisionRef: "policy-revision-2026-08-30",
  scope: Object.freeze(["repo:moe-next", "task:task-4704a298"]),
});

/** The exact ledger bytes, in the exact key order the landed record builder freezes. */
const EXPECTED_GRANT_RECORD = Object.freeze({
  actionKind: "plan.apply",
  approvedAt: DECIDED_AT,
  approvedBy: OPERATOR,
  commandId: "cmd-policy-waiver-grant",
  decisionReason: REASON,
  expiresAtEpochMs: EXPIRES_AT_EPOCH_MS,
  humanApprovalRef: GRANT_HUMAN_APPROVAL_REF,
  namedObligationId: "obligation-secondary-review",
  policyRevisionRef: "policy-revision-2026-08-30",
  projectId: PROJECT,
  scope: ["repo:moe-next", "task:task-4704a298"],
  stepUpAuthRef: GRANT_STEP_UP_REF,
  supersedesWaiverRef: null,
  waiverRef: GRANT_WAIVER_REF,
});

function grantPayload(): Record<string, unknown> {
  return { command: { ...GRANT_COMMAND } };
}

function revokePayload(): Record<string, unknown> {
  return { command: { ...REVOKE_COMMAND } };
}

/** A GRANT command carrying one extra nested key, all else canonical. */
function grantWith(extra: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return { command: { ...GRANT_COMMAND, ...extra } };
}

/** A canonical GRANT payload carrying one extra OUTER key the ingress allow-list admits. */
function outerWith(extra: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return { command: { ...GRANT_COMMAND }, ...extra };
}

interface HostileCase {
  readonly payload: Record<string, unknown>;
  readonly title: string;
}

/**
 * The refusal matrix. Every member keeps `command.decisionKind === "SOFT_POLICY_WAIVER"`
 * so the registry's candidate test still routes it HERE — the point is that reaching this
 * branch is not the same as being admitted by it.
 */
const HOSTILE_PAYLOADS: readonly HostileCase[] = Object.freeze([
  { payload: grantWith({ humanApprovalRef: GRANT_HUMAN_APPROVAL_REF }),
    title: "nested humanApprovalRef" },
  { payload: grantWith({ waiverRef: GRANT_WAIVER_REF }), title: "nested waiverRef" },
  { payload: grantWith({ projectId: PROJECT }), title: "nested projectId" },
  { payload: grantWith({ principalId: OPERATOR }), title: "nested principalId" },
  { payload: grantWith({ approvedAt: DECIDED_AT }), title: "nested approvedAt" },
  { payload: grantWith({ stepUpAuthRef: GRANT_STEP_UP_REF }), title: "nested stepUpAuthRef" },
  { payload: grantWith({ decision: "APPROVE" }), title: "nested legacy decision" },
  { payload: grantWith({ kind: "SOFT_POLICY_WAIVER" }), title: "nested legacy kind" },
  { payload: outerWith({ activation: { mode: "IMMEDIATE" } }), title: "outer legacy activation" },
  { payload: outerWith({ graphRevisionRef: "graph-revision-7" }),
    title: "outer legacy graphRevisionRef" },
  { payload: outerWith({ record: { decision: "APPROVE" } }), title: "outer legacy record" },
  { payload: outerWith({ runId: "run-4704a298" }), title: "outer legacy runId" },
]);

interface ExpiryCase {
  readonly expiresAt: unknown;
  readonly title: string;
}

/** Non-canonical or out-of-bound expiries. All payload-stage, so all refuse before a read. */
const EXPIRY_REJECTIONS: readonly ExpiryCase[] = Object.freeze([
  { expiresAt: "2026-08-30T18:00:00.000+00:00", title: "zero-offset spelling instead of Z" },
  { expiresAt: "2026-08-30T18:00:00Z", title: "second precision without milliseconds" },
  { expiresAt: "2026-08-30T18:00:00.000z", title: "lowercase zulu designator" },
  { expiresAt: DECIDED_AT, title: "equal to decidedAt rather than strictly after" },
  { expiresAt: "2026-08-30T11:59:59.999Z", title: "one millisecond before decidedAt" },
  { expiresAt: "2026-08-31T12:00:00.001Z", title: "one millisecond past the 24 hour bound" },
  { expiresAt: "2026-09-06T12:00:00.000Z", title: "a week past the 24 hour bound" },
  { expiresAt: EXPIRES_AT_EPOCH_MS, title: "epoch milliseconds instead of a canonical string" },
  { expiresAt: "not-a-time", title: "unparseable text" },
  { expiresAt: null, title: "null" },
]);

interface StoreProbe {
  readonly commits: () => number;
  readonly decisions: () => number;
  readonly legs: () => readonly (readonly ExpectedVersionDecisionLeg[])[];
  readonly reads: () => number;
  readonly requests: () => readonly string[];
  /** The counting view handed to production. Assertions read the RAW store. */
  readonly store: SqliteEventStore;
}

/** Every other member reaches the REAL store, bound, so its private fields resolve. */
function passThrough(target: SqliteEventStore, property: string | symbol): unknown {
  const value = Reflect.get(target, property, target) as unknown;
  return typeof value === "function" ? (value as (...args: never[]) => unknown).bind(target) : value;
}

/**
 * Counts every seam this module may touch. `SqliteEventStore` freezes both its instances
 * and its prototype, so a spy cannot be installed on either; a delegating Proxy is the
 * only way to observe the real object's own calls without replacing it with a fake.
 */
function probeStore(store: SqliteEventStore): StoreProbe {
  const legs: (readonly ExpectedVersionDecisionLeg[])[] = [];
  const requests: string[] = [];
  const counts = { commits: 0, decisions: 0, reads: 0 };
  const proxy = new Proxy(store, {
    get(target, property) {
      if (property === "commitExpectedVersionDecisionLegs") {
        return (input: CommitExpectedVersionDecisionLegsInput) => {
          counts.commits += 1;
          legs.push(input.legs);
          requests.push(decoder.decode(input.requestBytes));
          return target.commitExpectedVersionDecisionLegs(input);
        };
      }
      if (property === "getCommandDecision") {
        return (key: CommandDecisionKey) => {
          counts.decisions += 1;
          return target.getCommandDecision(key);
        };
      }
      if (property === "readEvents") {
        return (aggregateId: string) => {
          counts.reads += 1;
          return target.readEvents(aggregateId);
        };
      }
      return passThrough(target, property);
    },
  });
  return {
    commits: () => counts.commits,
    decisions: () => counts.decisions,
    legs: () => legs,
    reads: () => counts.reads,
    requests: () => requests,
    store: proxy,
  };
}

function inputOf(
  store: SqliteEventStore,
  payload: unknown,
  overrides: Partial<PolicyWaiverCommandInput> = {},
): PolicyWaiverCommandInput {
  return {
    capabilities: [ADMIN, "planning.write"],
    commandId: "cmd-policy-waiver-grant",
    correlationId: "corr-policy-waiver",
    decidedAt: DECIDED_AT,
    expectedVersion: 0,
    operatorPrincipalId: OPERATOR,
    payload,
    principalId: OPERATOR,
    projectId: PROJECT,
    store,
    ...overrides,
  };
}

/** The refusal's own code and layer, never merely "it threw". */
function refusalOf(run: () => unknown): { code: string; layer: string } {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainRefusal) return { code: error.code, layer: error.layer };
    throw error;
  }
  throw new Error("expected a DomainRefusal; the call returned normally");
}

function recordTextAt(store: SqliteEventStore, index: number): string {
  const events = store.readEvents(GRANT_AGGREGATE_ID);
  const event = events[index];
  if (event === undefined) throw new Error(`no waiver event at index ${index}`);
  return decoder.decode(event.payload);
}

describe("SOFT_POLICY_WAIVER command shape", () => {
  it("names the arm with the exact discriminator the registry branches on", () => {
    expect(POLICY_WAIVER_DECISION_KIND).toBe("SOFT_POLICY_WAIVER");
  });

  it("freezes an outer roster of exactly 1 key", () => {
    expect(EXPECTED_OUTER_KEYS).toHaveLength(1);
    expect(POLICY_WAIVER_OUTER_KEYS).toHaveLength(1);
    expect(Object.isFrozen(POLICY_WAIVER_OUTER_KEYS)).toBe(true);
    expect([...POLICY_WAIVER_OUTER_KEYS].sort()).toEqual([...EXPECTED_OUTER_KEYS].sort());
  });

  it("freezes a GRANT roster of exactly 8 keys", () => {
    expect(EXPECTED_GRANT_KEYS).toHaveLength(8);
    expect(POLICY_WAIVER_GRANT_KEYS).toHaveLength(8);
    expect(Object.isFrozen(POLICY_WAIVER_GRANT_KEYS)).toBe(true);
    expect([...POLICY_WAIVER_GRANT_KEYS].sort()).toEqual([...EXPECTED_GRANT_KEYS].sort());
  });

  it("freezes a REVOKE roster of exactly 7 keys, the GRANT roster minus expiresAt", () => {
    expect(EXPECTED_REVOKE_KEYS).toHaveLength(7);
    expect(POLICY_WAIVER_REVOKE_KEYS).toHaveLength(7);
    expect(Object.isFrozen(POLICY_WAIVER_REVOKE_KEYS)).toBe(true);
    expect([...POLICY_WAIVER_REVOKE_KEYS].sort()).toEqual([...EXPECTED_REVOKE_KEYS].sort());
    expect([...POLICY_WAIVER_GRANT_KEYS].filter((key) => key !== "expiresAt").sort())
      .toEqual([...EXPECTED_REVOKE_KEYS].sort());
  });

  it("freezes exactly 2 operations", () => {
    expect(EXPECTED_OPERATIONS).toHaveLength(2);
    expect(POLICY_WAIVER_OPERATIONS).toHaveLength(2);
    expect(Object.isFrozen(POLICY_WAIVER_OPERATIONS)).toBe(true);
    expect([...POLICY_WAIVER_OPERATIONS].sort()).toEqual([...EXPECTED_OPERATIONS].sort());
  });

  it("freezes exactly 3 branch refusal codes", () => {
    expect(EXPECTED_BRANCH_CODES).toHaveLength(3);
    expect(POLICY_WAIVER_BRANCH_CODES).toHaveLength(3);
    expect(Object.isFrozen(POLICY_WAIVER_BRANCH_CODES)).toBe(true);
    expect([...POLICY_WAIVER_BRANCH_CODES].sort()).toEqual([...EXPECTED_BRANCH_CODES].sort());
  });
});

describe("SOFT_POLICY_WAIVER candidate classification", () => {
  it("claims the exact nested discriminator", () => {
    expect(isPolicyWaiverDecideCandidate(grantPayload())).toBe(true);
  });

  it("claims a malformed payload that still spells the discriminator", () => {
    // Claiming it is what lets the branch answer POLICY_WAIVER_PAYLOAD_INVALID instead of
    // letting the legacy operator fence answer for bytes that were never legacy.
    expect(isPolicyWaiverDecideCandidate({ command: { decisionKind: "SOFT_POLICY_WAIVER" } }))
      .toBe(true);
  });

  it("leaves every legacy approval.decide payload to the operator-only flow", () => {
    const legacy: readonly unknown[] = Object.freeze([
      { command: { decision: "APPROVE", kind: "PLAN" }, runId: "run-1" },
      { command: { decisionKind: "HARD_POLICY_WAIVER" } },
      { command: "SOFT_POLICY_WAIVER" },
      { command: null },
      { record: { decisionKind: "SOFT_POLICY_WAIVER" } },
      {},
      null,
      "SOFT_POLICY_WAIVER",
    ]);
    expect(legacy).toHaveLength(8);
    for (const payload of legacy) expect(isPolicyWaiverDecideCandidate(payload)).toBe(false);
  });
});

describe("SOFT_POLICY_WAIVER hostile payloads", () => {
  it("holds exactly 12 hostile cases", () => {
    expect(HOSTILE_PAYLOADS).toHaveLength(12);
    expect(new Set(HOSTILE_PAYLOADS.map((entry) => entry.title)).size).toBe(12);
  });

  it.each(HOSTILE_PAYLOADS)(
    "refuses $title as POLICY_WAIVER_PAYLOAD_INVALID before any store read",
    ({ payload }) => {
      // Every case must first REACH this branch; a case the classifier declined would
      // pass the refusal assertion below while testing the legacy fence instead.
      expect(isPolicyWaiverDecideCandidate(payload)).toBe(true);
      const probe = probeStore(newStore());
      expect(refusalOf(() => runPolicyWaiverDecideCommand(inputOf(probe.store, payload))))
        .toEqual({ code: "POLICY_WAIVER_PAYLOAD_INVALID", layer: "DAEMON_POLICY_WAIVER" });
      expect([probe.reads(), probe.decisions(), probe.commits()]).toEqual([0, 0, 0]);
    },
  );

  it("answers the payload BEFORE the fences, for a principal the human fence rejects", () => {
    // The zero-read arms above run as the configured operator, which short-circuits the
    // durable-human read; only a principal that WOULD be read can prove the decode runs
    // first. This one is neither the operator nor a durable HUMAN, and it holds ADMIN, so
    // a decode moved below the fences would answer POLICY_WAIVER_HUMAN_REQUIRED instead.
    const probe = probeStore(newStore());
    expect(refusalOf(() => runPolicyWaiverDecideCommand(
      inputOf(probe.store, grantWith({ stepUpAuthRef: GRANT_STEP_UP_REF }),
        { principalId: "principal-that-never-was" }),
    ))).toEqual({ code: "POLICY_WAIVER_PAYLOAD_INVALID", layer: "DAEMON_POLICY_WAIVER" });
    expect([probe.reads(), probe.decisions(), probe.commits()]).toEqual([0, 0, 0]);
  });
});

describe("SOFT_POLICY_WAIVER expiry canonicalisation", () => {
  it("holds exactly 10 expiry rejections", () => {
    expect(EXPIRY_REJECTIONS).toHaveLength(10);
    expect(new Set(EXPIRY_REJECTIONS.map((entry) => entry.title)).size).toBe(10);
  });

  it.each(EXPIRY_REJECTIONS)(
    "refuses $title as POLICY_WAIVER_PAYLOAD_INVALID before any store read",
    ({ expiresAt }) => {
      const payload = grantWith({ expiresAt });
      expect(isPolicyWaiverDecideCandidate(payload)).toBe(true);
      const probe = probeStore(newStore());
      expect(refusalOf(() => runPolicyWaiverDecideCommand(inputOf(probe.store, payload))))
        .toEqual({ code: "POLICY_WAIVER_PAYLOAD_INVALID", layer: "DAEMON_POLICY_WAIVER" });
      expect([probe.reads(), probe.decisions(), probe.commits()]).toEqual([0, 0, 0]);
    },
  );

  it("admits one millisecond after decidedAt", () => {
    const store = newStore();
    const decision = runPolicyWaiverDecideCommand(
      inputOf(store, grantWith({ expiresAt: "2026-08-30T12:00:00.001Z" })),
    );
    expect(decision.resultCode).toBe("EFFECTS_COMMITTED");
    expect(JSON.parse(recordTextAt(store, 0)) as { expiresAtEpochMs: number })
      .toMatchObject({ expiresAtEpochMs: Date.parse("2026-08-30T12:00:00.001Z") });
  });

  it("admits exactly 24 hours after decidedAt (the bound is inclusive)", () => {
    const store = newStore();
    const decision = runPolicyWaiverDecideCommand(
      inputOf(store, grantWith({ expiresAt: "2026-08-31T12:00:00.000Z" })),
    );
    expect(decision.resultCode).toBe("EFFECTS_COMMITTED");
    expect(JSON.parse(recordTextAt(store, 0)) as { expiresAtEpochMs: number })
      .toMatchObject({ expiresAtEpochMs: Date.parse("2026-08-31T12:00:00.000Z") });
  });
});

describe("SOFT_POLICY_WAIVER durable GRANT", () => {
  it("commits the waiver and its one-use marker as ONE decision of exactly two legs", () => {
    const store = newStore();
    const probe = probeStore(store);
    {
      const decision = runPolicyWaiverDecideCommand(inputOf(probe.store, grantPayload()));
      expect(decision).toMatchObject({
        commandId: "cmd-policy-waiver-grant",
        disposition: "DECIDED",
        resultCode: "EFFECTS_COMMITTED",
      });
      expect(typeof decision.effectId).toBe("string");
      expect(probe.commits()).toBe(1);

      const [legs] = probe.legs();
      expect(legs).toHaveLength(2);
      // Waiver FIRST: legs[0] is the primary leg the durable decision record describes.
      expect(legs?.[0]).toMatchObject({
        aggregateId: GRANT_AGGREGATE_ID,
        expectedVersion: 0,
      });
      expect(legs?.[0]?.events).toHaveLength(1);
      expect(legs?.[0]?.events[0]).toMatchObject({
        eventId: "cmd-policy-waiver-grant-PolicyWaiverGranted.v1",
        eventType: "PolicyWaiverGranted.v1",
      });
      // Marker LAST, at expected version 0: the burn that makes the step-up one-use.
      expect(legs?.[1]).toMatchObject({
        aggregateId: GRANT_MARKER_AGGREGATE_ID,
        expectedVersion: 0,
      });
      expect(legs?.[1]?.events).toHaveLength(1);
      expect(legs?.[1]?.events[0]).toMatchObject({
        eventId: `${GRANT_MARKER_AGGREGATE_ID}/SessionAuthorityReplayObserved`,
        eventType: "SessionAuthorityReplayObserved",
      });
      expect(decoder.decode(legs?.[1]?.events[0]?.payload))
        .toBe(`{"replayDigest":"${GRANT_STEP_UP_REF}"}`);
    }
  });

  it("writes the exact ledger bytes, with every authority fact server-owned", () => {
    const store = newStore();
    runPolicyWaiverDecideCommand(inputOf(store, grantPayload()));
    // Byte equality against an independently written literal, in the record builder's
    // own key order. A drifted digest, a leaked caller field or a reordered key reddens.
    expect(recordTextAt(store, 0)).toBe(JSON.stringify(EXPECTED_GRANT_RECORD));
    expect(store.readEvents(GRANT_MARKER_AGGREGATE_ID)).toHaveLength(1);
  });

  it("binds the step-up reference to the AUTHENTICATED principal, not the payload", () => {
    const store = newStore();
    runPolicyWaiverDecideCommand(inputOf(store, grantWith({}), {
      // A caller-supplied step-up is not merely ignored — it cannot be expressed at all,
      // so this arm instead proves the derived reference tracks the authenticated identity.
      commandId: "cmd-policy-waiver-grant",
    }));
    const record = JSON.parse(recordTextAt(store, 0)) as { stepUpAuthRef: string };
    expect(record.stepUpAuthRef).toBe(GRANT_STEP_UP_REF);
    expect(record.stepUpAuthRef).toHaveLength(64);
  });

  it("puts expectedVersion in the request bytes so a stale retry cannot pass as a replay", () => {
    const probe = probeStore(newStore());
    runPolicyWaiverDecideCommand(inputOf(probe.store, grantPayload()));
    const [request] = probe.requests();
    expect(request).toContain("\"expectedVersion\":0");
    expect(request).toContain(`"stepUpAuthRef":"${GRANT_STEP_UP_REF}"`);
    expect(request).toContain(`"approvedBy":"${OPERATOR}"`);
  });
});

describe("SOFT_POLICY_WAIVER grant lineage", () => {
  it("supersedes the current grant and then revokes the superseding one", () => {
    const store = newStore();
    runPolicyWaiverDecideCommand(inputOf(store, grantPayload()));

    const superseding = runPolicyWaiverDecideCommand(inputOf(store, grantPayload(), {
      commandId: "cmd-policy-waiver-grant-2", expectedVersion: 1,
    }));
    expect(superseding.resultCode).toBe("EFFECTS_COMMITTED");
    const second = JSON.parse(recordTextAt(store, 1)) as {
      stepUpAuthRef: string; supersedesWaiverRef: string | null; waiverRef: string;
    };
    expect(second.supersedesWaiverRef).toBe(GRANT_WAIVER_REF);
    expect(second.stepUpAuthRef).toBe(SUPERSEDING_STEP_UP_REF);
    expect(second.waiverRef).not.toBe(GRANT_WAIVER_REF);

    const revoked = runPolicyWaiverDecideCommand(inputOf(store, revokePayload(), {
      commandId: "cmd-policy-waiver-revoke", expectedVersion: 2,
    }));
    expect(revoked.resultCode).toBe("EFFECTS_COMMITTED");
    const third = JSON.parse(recordTextAt(store, 2)) as {
      revokedWaiverRef: string; stepUpAuthRef: string;
    };
    // The exact-tuple current grant is the SUPERSEDING one, not the original.
    expect(third.revokedWaiverRef).toBe(second.waiverRef);
    expect(third.stepUpAuthRef).toBe(REVOKE_STEP_UP_REF);
    expect(store.readEvents(GRANT_AGGREGATE_ID)).toHaveLength(3);
  });

  it("refuses a REVOKE with no current grant as POLICY_WAIVER_RECORD_MISSING", () => {
    const probe = probeStore(newStore());
    expect(refusalOf(() => runPolicyWaiverDecideCommand(
      inputOf(probe.store, revokePayload(), { commandId: "cmd-policy-waiver-revoke" }),
    ))).toEqual({ code: "POLICY_WAIVER_RECORD_MISSING", layer: "DAEMON_POLICY_WAIVER" });
    expect(probe.commits()).toBe(0);
  });

  it("refuses a stale expectedVersion as POLICY_WAIVER_EXPECTED_VERSION_CONFLICT", () => {
    const store = newStore();
    runPolicyWaiverDecideCommand(inputOf(store, grantPayload()));
    const probe = probeStore(store);
    expect(refusalOf(() => runPolicyWaiverDecideCommand(inputOf(probe.store, grantPayload(), {
      commandId: "cmd-policy-waiver-grant-2", expectedVersion: 0,
    })))).toEqual({
      code: "POLICY_WAIVER_EXPECTED_VERSION_CONFLICT", layer: "DAEMON_POLICY_WAIVER",
    });
    expect(probe.commits()).toBe(0);
    expect(store.readEvents(GRANT_AGGREGATE_ID)).toHaveLength(1);
  });
});

describe("SOFT_POLICY_WAIVER command identity", () => {
  it("replays byte-identical bytes from the durable decision without a second commit", () => {
    const store = newStore();
    const first = runPolicyWaiverDecideCommand(inputOf(store, grantPayload()));
    const probe = probeStore(store);
    const second = runPolicyWaiverDecideCommand(inputOf(probe.store, grantPayload()));
    expect(second).toEqual({
      commandId: "cmd-policy-waiver-grant",
      disposition: "REPLAYED",
      effectId: first.effectId,
      resultCode: "EFFECTS_COMMITTED",
    });
    expect(probe.commits()).toBe(0);
    expect(store.readEvents(GRANT_AGGREGATE_ID)).toHaveLength(1);
  });

  it("refuses the same command id with changed bytes as IDEMPOTENCY_CONFLICT", () => {
    const store = newStore();
    runPolicyWaiverDecideCommand(inputOf(store, grantPayload()));
    const probe = probeStore(store);
    expect(refusalOf(() => runPolicyWaiverDecideCommand(
      inputOf(probe.store, grantWith({ decisionReason: "a different reason entirely" })),
    ))).toEqual({ code: "IDEMPOTENCY_CONFLICT", layer: "DURABLE_STORE" });
    expect(probe.commits()).toBe(0);
    expect(store.readEvents(GRANT_AGGREGATE_ID)).toHaveLength(1);
  });
});

describe("SOFT_POLICY_WAIVER concurrency", () => {
  it("loses a REAL waiver-version race with no partial write", () => {
    const store = newStore();
    let raced = false;
    const racing = new Proxy(store, {
      get(target, property) {
        if (property !== "readEvents") return passThrough(target, property);
        return (aggregateId: string) => {
          const events = target.readEvents(aggregateId);
          if (!raced && aggregateId === GRANT_AGGREGATE_ID) {
            raced = true;
            // A genuine competitor lands between this fold's snapshot and this commit.
            runPolicyWaiverDecideCommand(inputOf(store, grantPayload(), {
              commandId: "cmd-policy-waiver-race-winner",
            }));
          }
          return events;
        };
      },
    });
    expect(refusalOf(() => runPolicyWaiverDecideCommand(inputOf(racing, grantPayload(), {
      commandId: "cmd-policy-waiver-race",
    })))).toEqual({
      code: "POLICY_WAIVER_EXPECTED_VERSION_CONFLICT", layer: "DAEMON_POLICY_WAIVER",
    });
    expect(raced).toBe(true);
    // Exactly the winner's event; the loser wrote neither a waiver nor its marker.
    expect(store.readEvents(GRANT_AGGREGATE_ID)).toHaveLength(1);
    expect(store.readEvents(
      "moe.session-authority.v1/replay/e0fa065e42c65c4d5511a3dda02746da49f7f3851d2b5b6deb5fec06c4b2662e",
    )).toHaveLength(0);
  });

  it("refuses a preseeded step-up marker as SESSION_REPLAYED @ REPLAY, writing no waiver", () => {
    const store = newStore();
    // Everything else about this request is VALID — canonical payload, ADMIN + operator
    // identity, current expectedVersion — so the marker leg is the only layer that can
    // answer. Burned through the production replay seam, not a hand-written event.
    const observed = observeReplayMarker(store, {
      decidedAt: DECIDED_AT, principalId: OPERATOR, projectId: PROJECT,
      replayDigest: MARKER_FIXTURE_STEP_UP_REF,
    });
    expect(observed.outcome).toBe("FRESH");
    const probe = probeStore(store);
    expect(refusalOf(() => runPolicyWaiverDecideCommand(inputOf(probe.store, grantPayload(), {
      commandId: "cmd-policy-waiver-marker",
    })))).toEqual({ code: "SESSION_REPLAYED", layer: "REPLAY" });
    expect(probe.commits()).toBe(1);
    expect(store.readEvents(GRANT_AGGREGATE_ID)).toHaveLength(0);
  });
});
