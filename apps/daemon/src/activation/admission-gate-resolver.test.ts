/**
 * THE DURABLE ADMISSION GATE, and the retirement of the last caller-supplied budget input on the
 * authenticated `effect.activate` route.
 *
 * WHAT THIS SUITE IS FOR. Until `resolveAdmissionGate` landed, the stage read the caller's
 * `payload.budget.gate` and checked ONE thing about it — that the witness field the node's own
 * durable policy names was present. Presence is not authenticity: a caller could assert
 * `{allowance: {decisionRef: "anything", outcome: "ALLOW"}}` and no durable record was ever
 * consulted. The resolver builds the witness FROM durable records instead, so the forgery is
 * unrepresentable rather than merely refused. The arm that proves it is the one that hands a
 * perfectly-formed forged gate to a world holding no durable witness at all.
 *
 * THE TWO SOURCES, AND THE BOUNDARY THAT SEPARATES THEM FROM `checkGate`.
 *   POLICY_ALLOWANCE  <- the newest strictly verified matching `PolicyEvaluated` on
 *                        `${projectId}-policy`.
 *   HUMAN_APPROVAL    <- the goal's single `GoalExecutionEnabled`, `eventPayload.approval`.
 * The resolver answers WHICH durable record witnesses this node. Whether that witness ALLOWS is
 * `checkGate`'s call in `@moe/scheduler` and is asserted here in the SCHEDULER's own vocabulary,
 * never restamped into a resolver code (task rail 1). Those are different questions with
 * different vocabularies, and a suite that only proved "it refused" would pass while the two
 * merged.
 *
 * EVERY WITNESS USES THE PRODUCTION DURABLE SHAPE. Non-allowing decisions and approvals remain
 * production-written. ALLOW reader arms use an explicitly historical event-seam fixture because
 * production cannot create that decision today; the fixture never claims otherwise.
 *
 * WINDOWS HANDLE DISCIPLINE: the store handle closes in a `finally` INSIDE the temp directory's
 * own `finally`. A handle held across `rmSync` throws EPERM and kills the vitest worker with no
 * output at all.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { decodeBoundedJsonBytes } from "@moe/contracts";
import { SqliteEventStore } from "@moe/store";

import type { JsonObject } from "@moe/contracts";

import { policyAggregateId } from "../bootstrap/bootstrap-sequence.js";
import {
  ACTIVATION_WITNESS, GOAL_ID, PROJECT_ID, driveThrough, envelope, send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { decodeBudgetLedgerRecord } from "../budget/budget-ledger-codec.js";
import {
  BUDGET_LEDGER_EVENT_TYPE, deriveBudgetAggregateId,
} from "../budget/budget-ledger-contracts.js";
import { reserveBudgetForAdmission } from "../budget/budget-ledger-holds.js";

import { deriveActivationBudget } from "./activation-budget-derivation.js";
import {
  ACTIVATION_BUDGET_STAGE_CODES, runActivationBudgetStage,
} from "./activation-budget-stage.js";
import { activationAdmissionRef } from "./activation-admission-identity.js";
import {
  ACTIVATION_INGRESS_LAYER, ACTIVATION_INGRESS_SCHEMA_VERSION, EFFECT_ACTIVATE_COMMAND_KIND,
} from "./activation-ingress-contracts.js";
import type { ActivationIngressRequest } from "./activation-ingress-contracts.js";
import {
  ACTIVATION_WORLD_NODE_KEY, ACTIVATION_WORLD_POLICY_SLICE_HASH, ACTIVATION_WORLD_REVISION_ID,
  seedActivationWorldWithGatePolicy,
  seedActivationWorldWithoutPolicyWitness,
} from "./activation-world-fixtures.js";
import { ADMISSION_GATE_RESOLVER_CODES, resolveAdmissionGate } from "./admission-gate-resolver.js";
import {
  seedAllowingPolicyDecision, seedApprovedNodeScope, seedNonAllowingPolicyDecision,
} from "./admission-witness-fixtures.js";
import {
  HISTORICAL_POLICY_ALLOWANCE_EVALUATED_AT_EPOCH_MS, historicalPolicySliceRef,
  plantHistoricalPolicyAllowance, plantHistoricalPolicyHold,
} from "./policy-allowance-fixtures.js";

const COMMAND_ID = "cmd-activate-resolver-1";
const DECIDED_AT = "2026-08-19T00:00:00.000Z";
const ACTIVATION_POLICY_SUBJECT = Object.freeze({
  action: "effect.activate" as const,
  graphRevisionRef: ACTIVATION_WORLD_REVISION_ID,
  nodeKey: ACTIVATION_WORLD_NODE_KEY,
  policySliceHash: ACTIVATION_WORLD_POLICY_SLICE_HASH,
  principalId: "principal-1",
});

/**
 * The forgery this row makes unrepresentable: structurally perfect, ALLOWING by `checkGate`'s
 * own rules, and backed by nothing durable whatsoever.
 */
const FORGED_GATE = Object.freeze({
  allowance: Object.freeze({ decisionRef: "anything", outcome: "ALLOW" }),
  approval: null,
});

function withStore<T>(name: string, run: (store: SqliteEventStore) => T): T {
  const directory = mkdtempSync(join(tmpdir(), `moe-adm-gate-${name}-`));
  try {
    const store = SqliteEventStore.openForProject(join(directory, "store.sqlite"), PROJECT_ID);
    try {
      return run(store);
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { force: true, maxRetries: 5, recursive: true });
  }
}

function withReopenedStore<T>(
  name: string,
  seed: (store: SqliteEventStore) => void,
  run: (store: SqliteEventStore) => T,
): T {
  const directory = mkdtempSync(join(tmpdir(), `moe-adm-reopen-${name}-`));
  const path = join(directory, "store.sqlite");
  try {
    const initial = SqliteEventStore.openForProject(path, PROJECT_ID);
    try {
      seed(initial);
    } finally {
      initial.close();
    }
    const reopened = SqliteEventStore.openForProject(path, PROJECT_ID);
    try {
      return run(reopened);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { force: true, maxRetries: 5, recursive: true });
  }
}

describe("server-resolved policy facts — the explicit negative world", () => {
  it("reaches the evaluator-owned non-allow reason without fabricating ALLOW", () => {
    withReopenedStore("resolved-explicit-policy-negative", (store) => {
      driveThrough(store, "goal.create");
      seedActivationWorldWithoutPolicyWitness(store, "POLICY_ALLOWANCE");
      seedAllowingPolicyDecision(store, ACTIVATION_POLICY_SUBJECT);
    }, (store) => {
      const decision = store.getCommandDecision({
        commandId: "cmd-witness-policy.validate-allow",
        principalId: "principal-1",
        projectId: PROJECT_ID,
      });
      if (decision === null || decision.effectDisposition !== "EFFECTS_COMMITTED") {
        throw new Error("policy.validate did not commit through the production writer");
      }
      const decoded = decodeBoundedJsonBytes(decision.resultBytes);
      if (!decoded.ok) throw new Error(`policy result undecodable: ${decoded.code}`);
      const record = (decoded.value as JsonObject)["record"] as JsonObject;

      expect(record["decision"]).toBe("HOLD_UNKNOWN");
      expect(record["reasonCodes"]).toStrictEqual(["RISK_TIER_UNCLASSIFIABLE"]);
      expect(JSON.stringify(record["inputFacts"])).toBe(
        "[{\"factId\":\"policy-risk-unclassifiable:sha256:d1b00b797dc06790e122914a3255ba4130e9588d01146ab81311b2fa0c54fa42\",\"truthClass\":\"UNKNOWN\"}]",
      );

      const admissionRef = activationAdmissionRef(PROJECT_ID, "principal-1", COMMAND_ID);
      expect(standingHolds(store, admissionRef)).toBe(0);
      const consumed = resolve(store, "allowance");
      expect(consumed.ok).toBe(true);
      if (!consumed.ok) return;
      expect(consumed.gate.allowance?.outcome).toBe("HOLD_UNKNOWN");
      expect(consumed.gate.approval).toBeNull();
      expect(refusalOf(stage(store, undefined))).toStrictEqual(LEDGER_REFUSED);
      expect(standingHolds(store, admissionRef)).toBe(0);
    });
  });
});

/**
 * A project that is ACTIVE and carries the activation world, driven WITHOUT `policy.install` or
 * `policy.validate` — so the policy aggregate is genuinely empty.
 *
 * `driveThrough` cannot express this: its sequence is ordered and the two policy commands sit in
 * the middle of it. The four commands are therefore sent directly, which is the same route
 * `seedReadyProject` takes for exactly the same reason.
 */
function seedProjectWithoutPolicy(store: SqliteEventStore): void {
  // Everything up to `provider.probe` inclusive, which is the last command before the two
  // policy ones. `project.activate` then follows on the PROJECT aggregate at version 2 — the
  // policy commands live on `${projectId}-policy` and never move it.
  driveThrough(store, "policy.install");
  const activated = send(store, envelope("project.activate", 2, { witness: ACTIVATION_WITNESS }));
  if (!activated.ok) throw new Error(`project.activate refused: ${activated.code}`);
}

/** Reason code AND refusing layer, never merely "it failed" (global rail 1). */
const refusalOf = (result: { ok: boolean }): readonly [string, string] => {
  const refused = result as { code?: string; layer?: string };
  return [refused.code ?? "UNEXPECTEDLY_ADMITTED", refused.layer ?? "NO_LAYER"];
};

const requestWith = (
  budget: unknown, commandId: string = COMMAND_ID,
): ActivationIngressRequest => ({
  commandId,
  correlationId: "corr-activate-resolver",
  decidedAt: DECIDED_AT,
  expectedVersion: 0,
  kind: EFFECT_ACTIVATE_COMMAND_KIND,
  payload: (budget === undefined ? {} : { budget }) as unknown as JsonObject,
  principalId: "principal-1",
  projectId: PROJECT_ID,
  schemaVersion: ACTIVATION_INGRESS_SCHEMA_VERSION,
});

const stage = (store: SqliteEventStore, budget: unknown, commandId?: string) =>
  runActivationBudgetStage(
    commandId === undefined
      ? { request: requestWith(budget), store }
      : { request: requestWith(budget, commandId), store },
  );

const resolve = (
  store: SqliteEventStore,
  witnessField: "allowance" | "approval",
  overrides: Readonly<{ graphRevisionRef?: string; principalId?: string }> = {},
) =>
  resolveAdmissionGate({
    goalRef: GOAL_ID,
    graphRevisionRef: overrides.graphRevisionRef ?? ACTIVATION_WORLD_REVISION_ID,
    nodeKey: ACTIVATION_WORLD_NODE_KEY,
    policySliceHash: ACTIVATION_WORLD_POLICY_SLICE_HASH,
    principalId: overrides.principalId ?? "principal-1",
    projectId: PROJECT_ID,
    store,
    witnessField,
  });

/**
 * HOW MANY DURABLE HOLDS STAND for this admission identity, through production's own aggregate
 * id, event type and codec.
 *
 * The stage's `readStandingHold` returns an ACCEPTED result and returns EARLY, ABOVE the gate
 * read. A hostile-gate arm run against a world that already holds a reservation for
 * the activation admission identity therefore never reaches the resolver at all, and would
 * "prove" an unreachability this row did not create — it would pass on an unmodified tree. Every
 * such arm below states this precondition and SHOWS it at zero.
 */
function standingHolds(store: SqliteEventStore, admissionRef: string): number {
  const derived = deriveActivationBudget({ projectId: PROJECT_ID, store });
  if (!derived.ok) throw new Error("the world must derive an account to count holds against");
  const aggregateId = deriveBudgetAggregateId(PROJECT_ID, derived.value.accountId);
  let held = 0;
  for (const event of store.readEvents(aggregateId)) {
    if (event.eventType !== BUDGET_LEDGER_EVENT_TYPE) continue;
    const decoded = decodeBudgetLedgerRecord(event.payload);
    if (!decoded.ok || decoded.record.transition !== "RESERVED") continue;
    if (decoded.record.reservations.some((entry) => entry.admissionRef === admissionRef)) held += 1;
  }
  return held;
}

/** The durable `PolicyEvaluated` payload, read back so an expectation is never hand-built. */
function latestPolicyEvaluated(store: SqliteEventStore): JsonObject {
  const events = store.readEvents(policyAggregateId(PROJECT_ID))
    .filter((event) => event.eventType === "PolicyEvaluated");
  const last = events[events.length - 1];
  if (last === undefined) throw new Error("the world must carry a PolicyEvaluated");
  const decoded = decodeBoundedJsonBytes(last.payload);
  if (!decoded.ok) throw new Error("the durable policy decision must decode");
  return decoded.value as JsonObject;
}

function plantTrailingPolicyInstall(store: SqliteEventStore, sliceRef?: string): void {
  const aggregateId = policyAggregateId(PROJECT_ID);
  const source = store.readEvents(aggregateId).find((event) => event.eventType === "PolicyInstalled");
  if (source === undefined) throw new Error("the world must carry a PolicyInstalled to copy");
  const decoded = decodeBoundedJsonBytes(source.payload);
  if (!decoded.ok || decoded.value === null || typeof decoded.value !== "object"
    || Array.isArray(decoded.value)) throw new Error("the source install payload is unreadable");
  const payload = sliceRef === undefined
    ? source.payload
    : new TextEncoder().encode(JSON.stringify({ ...decoded.value, sliceRef }));
  const expectedVersion = store.getAggregateVersion(aggregateId);
  const commandId = `plant-trailing-policy-install-${String(expectedVersion + 1)}`;
  store.commit({
    aggregateId,
    commandBytes: new TextEncoder().encode(commandId),
    commandId,
    committedAt: "2025-01-01T00:00:00.001Z",
    events: [{ eventId: `${commandId}-PolicyInstalled`, eventType: "PolicyInstalled", payload }],
    expectedVersion,
  });
}

/** The durable approval record, read back for the same reason. */
function durableApproval(store: SqliteEventStore): JsonObject {
  const events = store.readEvents(GOAL_ID)
    .filter((event) => event.eventType === "GoalExecutionEnabled");
  if (events.length !== 1) throw new Error("the world must carry exactly one GoalExecutionEnabled");
  const decoded = decodeBoundedJsonBytes(events[0]!.payload);
  if (!decoded.ok) throw new Error("the durable approval must decode");
  return (decoded.value as JsonObject)["approval"] as JsonObject;
}

/** LITERALS, not the module's own constants: an expectation read out of the subject under test
 *  cannot constrain it, and the layer is the half that says WHICH authority refused. */
const RESOLVER_LAYER = "DAEMON_ADMISSION_GATE";
const ABSENT = ["ADMISSION_GATE_WITNESS_ABSENT", RESOLVER_LAYER] as const;
const POLICY_SOURCE_ABSENT = ["ADMISSION_GATE_POLICY_SOURCE_ABSENT", RESOLVER_LAYER] as const;
const SCOPE = ["ADMISSION_GATE_SCOPE_MISMATCH", RESOLVER_LAYER] as const;
const SUBJECT = ["ADMISSION_GATE_SUBJECT_MISMATCH", RESOLVER_LAYER] as const;
const POLICY_AUTHORITY_LAYER = "DAEMON_POLICY_AUTHORITY";
const DIGEST_VERSION_UNKNOWN = [
  "POLICY_AUTHORITY_DIGEST_VERSION_UNKNOWN", POLICY_AUTHORITY_LAYER,
] as const;
const PRINCIPAL_UNKNOWN = ["POLICY_AUTHORITY_PRINCIPAL_UNKNOWN", POLICY_AUTHORITY_LAYER] as const;
const MATERIAL_UNKNOWN = ["POLICY_AUTHORITY_MATERIAL_UNKNOWN", POLICY_AUTHORITY_LAYER] as const;
/** What the LEDGER answers when a present witness does not allow. A different vocabulary AND a
 *  different layer from the resolver's, which is the whole distinction DoD 2 asks for. */
const LEDGER_REFUSED = ["BUDGET_LEDGER_TRANSITION_REFUSED", "BUDGET_LEDGER"] as const;

interface HistoricalSubjectOverrides {
  readonly action?: string;
  readonly additionalAutoApprovalAction?: string;
  readonly graphNodeRevisionRefs?: readonly string[];
  readonly policyRef?: string;
  readonly principalId?: string;
  readonly scope?: readonly string[];
}

const FOREIGN_POLICY_SUBJECT_CASES = Object.freeze([
  ["another action", { action: "plan.approve" }],
  ["another principal", { principalId: "principal-other" }],
  ["another node scope", { scope: ["node-other"] }],
  ["an additional node scope", { scope: [ACTIVATION_WORLD_NODE_KEY, "node-other"] }],
  ["another graph revision", { graphNodeRevisionRefs: ["graph-revision-other"] }],
  ["an additional graph revision", {
    graphNodeRevisionRefs: [ACTIVATION_WORLD_REVISION_ID, "graph-revision-other"],
  }],
  ["another policy slice", { additionalAutoApprovalAction: "unrelated.action" }],
] as const);

function plantHistoricalAllowance(
  store: SqliteEventStore,
  overrides: HistoricalSubjectOverrides = {},
): void {
  const action = overrides.action ?? "effect.activate";
  const aggregateId = policyAggregateId(PROJECT_ID);
  const ordinal = String(store.getAggregateVersion(aggregateId) + 1);
  const commandId = `plant-historical-policy-allowance-${PROJECT_ID}-${ordinal}`;
  plantHistoricalPolicyAllowance(
    store, PROJECT_ID, HISTORICAL_POLICY_ALLOWANCE_EVALUATED_AT_EPOCH_MS,
    {
      action,
      ...(overrides.additionalAutoApprovalAction === undefined ? {} : {
        additionalAutoApprovalAction: overrides.additionalAutoApprovalAction,
      }),
      graphNodeRevisionRefs: overrides.graphNodeRevisionRefs ?? [ACTIVATION_WORLD_REVISION_ID],
      policyRef: overrides.policyRef ?? historicalPolicySliceRef(
        action, overrides.additionalAutoApprovalAction,
      ),
      principalId: overrides.principalId ?? "principal-1",
      scope: overrides.scope ?? [ACTIVATION_WORLD_NODE_KEY],
    },
  );
  const landed = store.readEvents(aggregateId).filter(
    (event) => event.commandId === commandId,
  );
  expect(landed).toHaveLength(1);
  expect(landed[0]?.eventType).toBe("PolicyEvaluated");
  expect(landed[0]?.committedAt).toBe(
    new Date(HISTORICAL_POLICY_ALLOWANCE_EVALUATED_AT_EPOCH_MS).toISOString(),
  );
}

function plantHistoricalHold(
  store: SqliteEventStore,
  overrides: HistoricalSubjectOverrides = {},
): void {
  const action = overrides.action ?? "effect.activate";
  plantHistoricalPolicyHold(
    store, PROJECT_ID, HISTORICAL_POLICY_ALLOWANCE_EVALUATED_AT_EPOCH_MS,
    {
      action,
      ...(overrides.additionalAutoApprovalAction === undefined ? {} : {
        additionalAutoApprovalAction: overrides.additionalAutoApprovalAction,
      }),
      graphNodeRevisionRefs: overrides.graphNodeRevisionRefs ?? [ACTIVATION_WORLD_REVISION_ID],
      policyRef: overrides.policyRef ?? historicalPolicySliceRef(
        action, overrides.additionalAutoApprovalAction,
      ),
      principalId: overrides.principalId ?? "principal-1",
      scope: overrides.scope ?? [ACTIVATION_WORLD_NODE_KEY],
    },
  );
}

function plantPolicyEvaluation(
  store: SqliteEventStore, label: string, payload: JsonObject,
): void {
  const aggregateId = policyAggregateId(PROJECT_ID);
  const expectedVersion = store.getAggregateVersion(aggregateId);
  const commandId = `plant-${label}-${String(expectedVersion + 1)}`;
  store.commit({
    aggregateId,
    commandBytes: new TextEncoder().encode(commandId),
    commandId,
    committedAt: "2024-01-01T00:00:00.000Z",
    events: [{
      eventId: `${commandId}-PolicyEvaluated`,
      eventType: "PolicyEvaluated",
      payload: new TextEncoder().encode(JSON.stringify(payload)),
    }],
    expectedVersion,
  });
}

function plantLegacyAllowance(store: SqliteEventStore): void {
  plantPolicyEvaluation(store, "legacy-policy-allowance", {
    decision: "ALLOW",
    policyRef: "legacy-policy-without-v2-authority",
  });
}

function plantPreV2WidenedAllowance(store: SqliteEventStore): void {
  plantPolicyEvaluation(store, "pre-v2-widened-policy-allowance", {
    decision: "ALLOW",
    decisionDigest: "a".repeat(64),
    policyRef: ACTIVATION_WORLD_POLICY_SLICE_HASH,
    principalId: "principal-1",
    projectId: PROJECT_ID,
    sliceRef: ACTIVATION_WORLD_POLICY_SLICE_HASH,
  });
}

function plantMalformedV2Allowance(store: SqliteEventStore): void {
  plantHistoricalAllowance(store);
  plantPolicyEvaluation(store, "malformed-v2-policy-allowance", {
    ...latestPolicyEvaluated(store),
    decisionMaterial: {},
  });
}

const POLICY_REFUSAL_CASES = Object.freeze([
  {
    expected: POLICY_SOURCE_ABSENT,
    label: "no PolicyEvaluated source",
    seed: (store: SqliteEventStore): void => {
      seedProjectWithoutPolicy(store);
      seedActivationWorldWithoutPolicyWitness(store, "POLICY_ALLOWANCE");
    },
  },
  {
    expected: DIGEST_VERSION_UNKNOWN,
    label: "pre-v2 widened caller-derived row",
    seed: (store: SqliteEventStore): void => {
      driveThrough(store, "goal.create");
      seedActivationWorldWithoutPolicyWitness(store, "POLICY_ALLOWANCE");
      plantPreV2WidenedAllowance(store);
    },
  },
  {
    expected: PRINCIPAL_UNKNOWN,
    label: "genuine two-field legacy row",
    seed: (store: SqliteEventStore): void => {
      driveThrough(store, "goal.create");
      seedActivationWorldWithoutPolicyWitness(store, "POLICY_ALLOWANCE");
      plantLegacyAllowance(store);
    },
  },
  {
    expected: MATERIAL_UNKNOWN,
    label: "malformed sealed v2 row",
    seed: (store: SqliteEventStore): void => {
      driveThrough(store, "goal.create");
      seedActivationWorldWithoutPolicyWitness(store, "POLICY_ALLOWANCE");
      plantMalformedV2Allowance(store);
    },
  },
  {
    expected: SUBJECT,
    label: "sealed v2 row for another principal",
    seed: (store: SqliteEventStore): void => {
      driveThrough(store, "goal.create");
      seedActivationWorldWithoutPolicyWitness(store, "POLICY_ALLOWANCE");
      plantHistoricalAllowance(store, { principalId: "principal-other" });
    },
  },
] as const);

describe("task-3a3d53fce0504c46b1d78f7e24f259cf — historical allowance containment", () => {
  it("keeps the generic activation world import graph disconnected from the fixture", () => {
    const source = readFileSync(new URL("./activation-world-fixtures.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(
      /\b(?:from\s+|import\s*)["']\.\/policy-allowance-fixtures\.js["']/,
    );
  });

  it("plants the writer's exact historical payload before the resolver reads it", () => {
    withStore("historical-policy-allowance", (store) => {
      driveThrough(store, "goal.create");
      seedActivationWorldWithGatePolicy(store, "POLICY_ALLOWANCE");
      plantHistoricalAllowance(store);

      const durable = latestPolicyEvaluated(store);
      expect(Object.keys(durable).sort()).toStrictEqual([
        "decision", "decisionDigest", "decisionDigestVersion", "decisionMaterial", "policyRef",
        "principalId", "projectId", "sliceRef",
      ]);
      expect(durable["decision"]).toBe("ALLOW");
      // Literal historical compatibility vector. The fixture does not ask today's evaluator
      // to author its outcome, and this pin also prevents a digest change from silently
      // regenerating the supposed historical row into a new format.
      expect(durable["decisionDigest"]).toBe(
        "f4648891d18ee67dc0668167d6df8bcda057eeae1a3ba505786c322e920d33a0",
      );
      expect(durable).not.toHaveProperty("facts");
      expect(durable).not.toHaveProperty("tier");
      expect(durable).not.toHaveProperty("truthClass");
      expect(durable).not.toHaveProperty("waiver");

      const resolved = resolve(store, "allowance");
      expect(refusalOf(resolved)[0]).toBe("UNEXPECTEDLY_ADMITTED");
      if (!resolved.ok) return;
      expect(resolved.gate.allowance).toStrictEqual({
        decisionRef: durable["decisionDigest"], outcome: "ALLOW",
      });
      expect(resolved.gate.approval).toBeNull();
    });
  });
});

describe("admission gate resolver — POLICY_ALLOWANCE is witnessed by the durable policy decision", () => {
  it("enumerates the exact nonzero foreign-subject roster", () => {
    expect(FOREIGN_POLICY_SUBJECT_CASES).toHaveLength(7);
    expect(FOREIGN_POLICY_SUBJECT_CASES.length).toBeGreaterThan(0);
  });

  it("builds the allowance from the newest matching PolicyEvaluated, field for field", () => {
    withStore("policy-happy", (store) => {
      driveThrough(store, "goal.create");
      seedActivationWorldWithoutPolicyWitness(store, "POLICY_ALLOWANCE");
      plantHistoricalAllowance(store);

      const resolved = resolve(store, "allowance");
      expect(refusalOf(resolved)[0]).toBe("UNEXPECTEDLY_ADMITTED");
      if (!resolved.ok) return;
      // Read back from the DURABLE event, never hand-built: an expectation authored here could
      // agree with a resolver that invented both halves.
      const durable = latestPolicyEvaluated(store);
      expect(resolved.gate.allowance).toStrictEqual({
        decisionRef: durable["decisionDigest"], outcome: durable["decision"],
      });
      expect(durable["decision"]).toBe("ALLOW");
      // A POLICY_ALLOWANCE node builds NO human approval, even though nothing forbids the shape.
      expect(resolved.gate.approval).toBeNull();
    });
  });

  it.each(FOREIGN_POLICY_SUBJECT_CASES)(
    "selects the newest matching decision past a later valid %s",
    (_label, overrides) => {
      withStore(`policy-later-foreign-${_label.replaceAll(" ", "-")}`, (store) => {
        driveThrough(store, "goal.create");
        seedActivationWorldWithGatePolicy(store, "POLICY_ALLOWANCE");
        plantHistoricalAllowance(store);
        const matching = latestPolicyEvaluated(store);
        const matchingDigest = matching["decisionDigest"];
        plantHistoricalAllowance(store, overrides);
        expect(latestPolicyEvaluated(store)["decisionDigest"]).not.toBe(matchingDigest);

        const admissionRef = activationAdmissionRef(PROJECT_ID, "principal-1", COMMAND_ID);
        expect(standingHolds(store, admissionRef)).toBe(0);
        const resolved = resolve(store, "allowance");
        expect(resolved.ok).toBe(true);
        if (!resolved.ok) return;
        expect(resolved.gate.allowance).toStrictEqual({
          decisionRef: matchingDigest, outcome: "ALLOW",
        });

        const reserved = stage(store, undefined);
        expect(reserved.ok).toBe(true);
        if (!reserved.ok) return;
        expect(reserved.leg.events).toHaveLength(1);
        // The stage returns a leg for atomic commit; it must not leak a standalone hold.
        expect(standingHolds(store, admissionRef)).toBe(0);
      });
    },
  );

  it("lets a newer matching HOLD supersede an older matching ALLOW", () => {
    withStore("policy-newer-matching-hold", (store) => {
      driveThrough(store, "goal.create");
      seedActivationWorldWithoutPolicyWitness(store, "POLICY_ALLOWANCE");
      plantHistoricalAllowance(store);
      plantHistoricalHold(store);

      const admissionRef = activationAdmissionRef(PROJECT_ID, "principal-1", COMMAND_ID);
      const resolved = resolve(store, "allowance");
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      expect(resolved.gate.allowance?.outcome).toBe("HOLD_UNKNOWN");
      expect(refusalOf(stage(store, undefined))).toStrictEqual(LEDGER_REFUSED);
      expect(standingHolds(store, admissionRef)).toBe(0);
    });
  });

  it("selects an earlier matching ALLOW past a later foreign HOLD_UNKNOWN", () => {
    withStore("policy-later-foreign-hold", (store) => {
      driveThrough(store, "goal.create");
      seedActivationWorldWithGatePolicy(store, "POLICY_ALLOWANCE");
      plantHistoricalAllowance(store);
      const matchingDigest = latestPolicyEvaluated(store)["decisionDigest"];
      plantHistoricalHold(store, { principalId: "principal-other" });
      expect(latestPolicyEvaluated(store)["decision"]).toBe("HOLD_UNKNOWN");

      const resolved = resolve(store, "allowance");
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      expect(resolved.gate.allowance).toStrictEqual({
        decisionRef: matchingDigest, outcome: "ALLOW",
      });
      expect(stage(store, undefined).ok).toBe(true);
    });
  });

  it.each(FOREIGN_POLICY_SUBJECT_CASES)("refuses a valid ALLOW bound to %s", (_label, overrides) => {
    withStore(`policy-subject-${_label.replaceAll(" ", "-")}`, (store) => {
      driveThrough(store, "goal.create");
      seedActivationWorldWithoutPolicyWitness(store, "POLICY_ALLOWANCE");
      plantHistoricalAllowance(store, overrides);

      expect(refusalOf(resolve(store, "allowance"))).toStrictEqual(SUBJECT);
    });
  });

  it("selects the decision BY TYPE, not as the newest event on the aggregate", () => {
    withStore("policy-by-type", (store) => {
      driveThrough(store, "goal.create");
      seedActivationWorldWithoutPolicyWitness(store, "POLICY_ALLOWANCE");
      plantHistoricalAllowance(store);
      // A LATER `PolicyInstalled`, so the newest event on the policy stream is NOT the decision.
      plantTrailingPolicyInstall(store);
      const events = store.readEvents(policyAggregateId(PROJECT_ID));
      expect(events[events.length - 1]?.eventType).toBe("PolicyInstalled");

      const resolved = resolve(store, "allowance");
      expect(refusalOf(resolved)[0]).toBe("UNEXPECTEDLY_ADMITTED");
      if (!resolved.ok) return;
      expect(resolved.gate.allowance?.outcome).toBe("ALLOW");
    });
  });

  it("refuses a decision superseded by a later install at the same content address", () => {
    withStore("policy-same-ref-reinstalled", (store) => {
      driveThrough(store, "goal.create");
      seedActivationWorldWithoutPolicyWitness(store, "POLICY_ALLOWANCE");
      plantHistoricalAllowance(store);
      plantTrailingPolicyInstall(store, ACTIVATION_WORLD_POLICY_SLICE_HASH);

      expect(refusalOf(resolve(store, "allowance"))).toStrictEqual(ABSENT);
    });
  });

  it("carries that allowance through the stage into a committed reservation", () => {
    withStore("policy-reserve", (store) => {
      driveThrough(store, "goal.create");
      seedActivationWorldWithGatePolicy(store, "POLICY_ALLOWANCE");
      // Planted at the seam, not driven: since the server resolver supplies a null-tier UNKNOWN
      // fact, `policy.validate` records HOLD_UNKNOWN and production can no longer mint an ALLOW.
      // The gate is unchanged — this world simply HOLDS the durable allowing witness it requires.
      plantHistoricalAllowance(store);

      const result = stage(store, undefined);
      expect(refusalOf(result)[0]).toBe("UNEXPECTEDLY_ADMITTED");
      if (!result.ok) return;
      expect(result.budget.reservation.admissionRef).toBe(
        activationAdmissionRef(PROJECT_ID, "principal-1", COMMAND_ID),
      );
      expect(result.authority.gateWitnessField).toBe("allowance");
      // No budget section at all in the payload, and it still reserves. That IS the retirement.
      expect(result.leg.events.length).toBe(1);
    });
  });
});

describe("admission gate resolver — HUMAN_APPROVAL is witnessed by the durable approval", () => {
  it("builds the approval from the stored event's own fields", () => {
    withStore("human-happy", (store) => {
      seedApprovedNodeScope(store, [ACTIVATION_WORLD_NODE_KEY]);
      seedActivationWorldWithGatePolicy(store, "HUMAN_APPROVAL");

      const resolved = resolve(store, "approval");
      expect(refusalOf(resolved)[0]).toBe("UNEXPECTEDLY_ADMITTED");
      if (!resolved.ok) return;
      const durable = durableApproval(store);
      expect(resolved.gate.approval).toStrictEqual({
        approvalRef: durable["approvalRef"],
        decision: durable["decision"],
        validity: durable["validity"],
      });
      expect(durable["decision"]).toBe("APPROVE");
      expect(durable["validity"]).toBe("CURRENT");
      // A HUMAN_APPROVAL node builds NO policy allowance — asserted on a world that HOLDS one.
      expect(resolved.gate.allowance).toBeNull();
    });
  });

  it("refuses an approval bound to another active graph revision", () => {
    withStore("human-foreign-graph-revision", (store) => {
      seedApprovedNodeScope(store, [ACTIVATION_WORLD_NODE_KEY]);
      seedActivationWorldWithGatePolicy(store, "HUMAN_APPROVAL");

      expect(refusalOf(resolve(store, "approval", {
        graphRevisionRef: "graph-revision-other",
      }))).toStrictEqual(SUBJECT);
    });
  });

  it("does not confuse the activating agent with the human approver", () => {
    withStore("human-distinct-activator", (store) => {
      seedApprovedNodeScope(store, [ACTIVATION_WORLD_NODE_KEY]);
      seedActivationWorldWithGatePolicy(store, "HUMAN_APPROVAL");

      expect(resolve(store, "approval", { principalId: "agent-activator" }).ok).toBe(true);
    });
  });

  it("reserves through the stage for a HUMAN_APPROVAL node with no payload budget", () => {
    withStore("human-reserve", (store) => {
      // ORDER IS LOAD-BEARING (task-1de7b81a): `approval.decide` establishes the project's
      // budget root, a root is ONCE-ONLY, and nothing in `@moe/scheduler` can add units to one.
      // The world's FUNDED root therefore has to land before the approval, or this reserve draws
      // on the zero-amount genesis root and refuses BUDGET_LEDGER_TRANSITION_REFUSED. The prefix
      // is driven first because the world seeder needs the goal, and `driveThrough` replays
      // idempotently inside `seedApprovedNodeScope` afterwards.
      driveThrough(store, "approval.decide");
      seedActivationWorldWithGatePolicy(store, "HUMAN_APPROVAL");
      seedApprovedNodeScope(store, [ACTIVATION_WORLD_NODE_KEY]);

      const result = stage(store, undefined);
      expect(refusalOf(result)[0]).toBe("UNEXPECTEDLY_ADMITTED");
      if (!result.ok) return;
      expect(result.authority.gateWitnessField).toBe("approval");
      expect(result.budget.reservation.admissionRef).toBe(
        activationAdmissionRef(PROJECT_ID, "principal-1", COMMAND_ID),
      );
    });
  });
});

describe("admission gate resolver — an absent witness is the RESOLVER's own refusal", () => {
  it("enumerates a literal nonzero policy-refusal roster", () => {
    expect(POLICY_REFUSAL_CASES).toHaveLength(5);
    expect(POLICY_REFUSAL_CASES.length).toBeGreaterThan(0);
  });

  it.each(POLICY_REFUSAL_CASES)("refuses $label without reservation residue", (testCase) => {
    withStore(`policy-refusal-${testCase.label.replaceAll(" ", "-")}`, (store) => {
      testCase.seed(store);
      const admissionRef = activationAdmissionRef(PROJECT_ID, "principal-1", COMMAND_ID);
      expect(standingHolds(store, admissionRef)).toBe(0);

      expect(refusalOf(stage(store, undefined))).toStrictEqual(testCase.expected);
      expect(standingHolds(store, admissionRef)).toBe(0);
    });
  });

  it("refuses a HUMAN_APPROVAL node whose goal was never approved", () => {
    withStore("human-absent", (store) => {
      driveThrough(store, "goal.create");
      seedActivationWorldWithGatePolicy(store, "HUMAN_APPROVAL");
      expect(store.readEvents(GOAL_ID)
        .filter((event) => event.eventType === "GoalExecutionEnabled").length).toBe(0);

      expect(refusalOf(resolve(store, "approval"))).toStrictEqual(ABSENT);
    });
  });

  it("answers ABSENT in its OWN vocabulary, not the scheduler's GATE_ABSENT", () => {
    withStore("absent-vocabulary", (store) => {
      seedProjectWithoutPolicy(store);
      seedActivationWorldWithoutPolicyWitness(store, "POLICY_ALLOWANCE");
      const refusal = refusalOf(stage(store, undefined));
      expect(refusal).toStrictEqual(POLICY_SOURCE_ABSENT);
      // `BUDGET_RESERVATION_GATE_ABSENT` is the SCHEDULER's answer to a both-null gate. It is
      // unreachable on this route now, and conflating the two would erase which layer refused.
      expect(refusal[0]).not.toBe("BUDGET_RESERVATION_GATE_ABSENT");
      expect(refusal[1]).not.toBe("BUDGET_LEDGER");
      expect(refusal[1]).not.toBe(ACTIVATION_INGRESS_LAYER);
    });
  });
});

describe("admission gate resolver — whether the witness ALLOWS stays the scheduler's call", () => {
  it("forwards a non-allowing policy decision to the ledger, unrestamped", () => {
    withStore("policy-not-allowed", (store) => {
      driveThrough(store, "goal.create");
      seedActivationWorldWithoutPolicyWitness(store, "POLICY_ALLOWANCE");
      seedNonAllowingPolicyDecision(store, ACTIVATION_POLICY_SUBJECT);

      // The witness EXISTS, so the resolver must not answer at all.
      const resolved = resolve(store, "allowance");
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      expect(resolved.gate.allowance?.outcome).not.toBe("ALLOW");
      // And the refusal that follows is the LEDGER's, in the ledger's vocabulary and layer.
      expect(refusalOf(stage(store, undefined))).toStrictEqual(LEDGER_REFUSED);
    });
  });

  it("cannot be overridden by a forged ALLOWING gate when the durable witness says no", () => {
    withStore("forged-over-deny", (store) => {
      driveThrough(store, "goal.create");
      seedActivationWorldWithGatePolicy(store, "POLICY_ALLOWANCE");
      seedNonAllowingPolicyDecision(store, ACTIVATION_POLICY_SUBJECT);
      expect(standingHolds(
        store, activationAdmissionRef(PROJECT_ID, "principal-1", COMMAND_ID),
      )).toBe(0);

      // THE ARM A MUTATION DRILL DEMANDED. The witness-absent forgery arm below passes even if
      // the stage hands the CALLER's gate to the writer, because the resolver refuses first and
      // the reserve call is never reached — measured by drilling exactly that mutation, which
      // stayed GREEN. This is the world where a caller-gate read would actually win: the
      // resolver resolves, the reserve call IS reached, and a forged ALLOW would be admitted.
      expect(refusalOf(stage(store, { gate: FORGED_GATE }))).toStrictEqual(LEDGER_REFUSED);
    });
  });

  it("names BUDGET_RESERVATION_POLICY_NOT_ALLOWED as the scheduler's own source code", () => {
    withStore("policy-source-code", (store) => {
      driveThrough(store, "goal.create");
      seedActivationWorldWithoutPolicyWitness(store, "POLICY_ALLOWANCE");
      seedNonAllowingPolicyDecision(store, ACTIVATION_POLICY_SUBJECT);
      const resolved = resolve(store, "allowance");
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;

      // The RESOLVER'S OWN gate handed to the production writer, so the code below is the
      // scheduler judging the durable witness — not a hand-built gate judged by a helper. The
      // ACCOUNT and the AMOUNTS come from the durable derivation for the same reason: a
      // hand-built line set refuses at `checkLines` FIRST (measured:
      // BUDGET_RESERVATION_PROTECTED_PURPOSE_MISSING), which would report a passing arm that
      // never reached `checkGate` at all.
      const derived = deriveActivationBudget({ projectId: PROJECT_ID, store });
      expect(derived.ok).toBe(true);
      if (!derived.ok) return;
      const written = reserveBudgetForAdmission(store, {
        accountId: derived.value.accountId,
        admissionRef: activationAdmissionRef(PROJECT_ID, "principal-1", COMMAND_ID),
        amounts: derived.value.amounts,
        context: {
          commandId: COMMAND_ID, correlationId: "corr-activate-resolver",
          decidedAt: DECIDED_AT, principalId: "principal-1",
        },
        gate: resolved.gate,
        goalRef: GOAL_ID,
        projectId: PROJECT_ID,
      }) as { readonly ok: boolean; readonly sourceCode?: unknown };
      expect(written.ok).toBe(false);
      expect(written.sourceCode).toBe("BUDGET_RESERVATION_POLICY_NOT_ALLOWED");
      // And that code is NOT in the resolver's roster: the two vocabularies stay disjoint.
      expect(ADMISSION_GATE_RESOLVER_CODES as readonly string[])
        .not.toContain("BUDGET_RESERVATION_POLICY_NOT_ALLOWED");
    });
  });
});

describe("admission gate resolver — one policy's witness can never satisfy the other", () => {
  it("refuses a HUMAN_APPROVAL node holding ONLY an allowing policy decision", () => {
    withStore("cross-human", (store) => {
      driveThrough(store, "goal.create");
      seedActivationWorldWithGatePolicy(store, "HUMAN_APPROVAL");
      // Planted, because production now records HOLD_UNKNOWN. Driving the seeder instead would
      // leave a NON-allowing row here and quietly weaken this arm to "a policy witness that does
      // not even allow fails to satisfy HUMAN_APPROVAL", which is not the claim in the title.
      plantHistoricalAllowance(store);
      // The allowance is real, durable and ALLOWING — and it is the wrong witness.
      expect(latestPolicyEvaluated(store)["decision"]).toBe("ALLOW");

      expect(refusalOf(resolve(store, "approval"))).toStrictEqual(ABSENT);
      expect(refusalOf(stage(store, undefined))).toStrictEqual(ABSENT);
    });
  });

  it("does not substitute a current human approval for the bound non-allowing policy", () => {
    withStore("cross-policy", (store) => {
      seedApprovedNodeScope(store, [ACTIVATION_WORLD_NODE_KEY]);
      // WITHOUT the policy witness on purpose: the happy seeder would upgrade the bootstrap's
      // HOLD_UNKNOWN to ALLOW and this arm would then pass for the wrong reason — an ALLOWING
      // allowance rather than the approval being ignored.
      seedActivationWorldWithoutPolicyWitness(store, "POLICY_ALLOWANCE");
      seedNonAllowingPolicyDecision(store, ACTIVATION_POLICY_SUBJECT);
      // The approval is real, durable, CURRENT and scoped to this very node.
      expect(durableApproval(store)["validity"]).toBe("CURRENT");
      // The activation-bound decision stands and it does not allow, so this refuses at the
      // ledger — which is itself the proof the approval was never consulted for this node.
      const resolved = resolve(store, "allowance");
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      expect(resolved.gate.approval).toBeNull();
      expect(resolved.gate.allowance?.outcome).toBe("HOLD_UNKNOWN");
      expect(refusalOf(stage(store, undefined))).toStrictEqual(LEDGER_REFUSED);
    });
  });
});

describe("admission gate resolver — an approval witnesses only the nodes it names", () => {
  it("refuses a node outside the approval's approvedNodeScope", () => {
    withStore("scope-mismatch", (store) => {
      // The stock approval scopes to `node-1`; the activation world's node is `dev-solo`.
      seedApprovedNodeScope(store, ["node-1"]);
      seedActivationWorldWithGatePolicy(store, "HUMAN_APPROVAL");
      expect(durableApproval(store)["approvedNodeScope"]).toStrictEqual(["node-1"]);

      const refusal = refusalOf(resolve(store, "approval"));
      expect(refusal).toStrictEqual(SCOPE);
      // SCOPE_MISMATCH is a RESOLUTION fault — which durable record applies to this node — and
      // must not collapse into ABSENT: one approval admitting every node in the goal is exactly
      // the forged-witness class this row closes.
      expect(refusal[0]).not.toBe(ABSENT[0]);
    });
  });

  it("admits the same world once the approval names the node", () => {
    withStore("scope-match", (store) => {
      seedApprovedNodeScope(store, ["node-1", ACTIVATION_WORLD_NODE_KEY]);
      seedActivationWorldWithGatePolicy(store, "HUMAN_APPROVAL");
      expect(resolve(store, "approval").ok).toBe(true);
    });
  });
});

describe("admission gate resolver — the resolved gate always carries the node's own witness", () => {
  /** The successor of the retired ACTIVATION_BUDGET_GATE_WITNESS_MISMATCH world: the question
   *  "does the gate carry the member the node's policy names" is now answered by CONSTRUCTION,
   *  and this arm is what holds that claim to the production surface in both directions. */
  const witnessCases: readonly (readonly ["allowance" | "approval", "POLICY_ALLOWANCE" | "HUMAN_APPROVAL"])[] = [
    ["allowance", "POLICY_ALLOWANCE"],
    ["approval", "HUMAN_APPROVAL"],
  ];

  // Asserted so a sweep that silently generated no case could not pass while testing nothing.
  it("covers both gate policies", () => {
    expect(witnessCases.length).toBe(2);
  });

  for (const [field, policy] of witnessCases) {
    it(`builds ${field} and only ${field} for a ${policy} node`, () => {
      withStore(`witness-kind-${field}`, (store) => {
        // BOTH durable witnesses exist in this world, so the choice cannot come from what
        // happens to be present — only from the node's own `admissionGatePolicy`.
        seedApprovedNodeScope(store, [ACTIVATION_WORLD_NODE_KEY]);
        if (policy === "POLICY_ALLOWANCE") {
          seedActivationWorldWithoutPolicyWitness(store, policy);
          plantHistoricalAllowance(store);
        } else {
          seedActivationWorldWithGatePolicy(store, policy);
          seedAllowingPolicyDecision(store, ACTIVATION_POLICY_SUBJECT);
        }

        const resolved = resolve(store, field);
        expect(refusalOf(resolved)[0]).toBe("UNEXPECTEDLY_ADMITTED");
        if (!resolved.ok) return;
        const other = field === "allowance" ? "approval" : "allowance";
        expect(resolved.gate[field]).not.toBeNull();
        expect(resolved.gate[other]).toBeNull();
      });
    });
  }

  it("REFUSES rather than throwing when the durable record is absent", () => {
    withStore("no-throw", (store) => {
      seedProjectWithoutPolicy(store);
      seedActivationWorldWithoutPolicyWitness(store, "POLICY_ALLOWANCE");
      // A crash is not a refusal: `checkGateWitness` used to be the only thing between an
      // absent witness and `checkGate`, and its replacement must answer, not die.
      expect(() => resolve(store, "allowance")).not.toThrow();
      expect(() => stage(store, undefined)).not.toThrow();
      expect(resolve(store, "allowance").ok).toBe(false);
    });
  });
});

describe("admission gate resolver — the caller's gate is no longer an input", () => {
  it("refuses a forged ALLOWING gate on a world with no durable witness", () => {
    withStore("forgery", (store) => {
      seedProjectWithoutPolicy(store);
      seedActivationWorldWithoutPolicyWitness(store, "POLICY_ALLOWANCE");
      // PRECONDITION, SHOWN: no hold stands for this admission identity, so `readStandingHold`
      // cannot answer above the gate read and this arm really does reach the resolver.
      expect(standingHolds(
        store, activationAdmissionRef(PROJECT_ID, "principal-1", COMMAND_ID),
      )).toBe(0);

      // Structurally perfect and ALLOWING by `checkGate`'s own rules. Under the retired
      // `checkGateWitness` this passed the stage outright; now nothing reads it. Asserted as a
      // NAMED code from the replacement vocabulary — "never the retired string" would be free.
      expect(refusalOf(stage(store, { gate: FORGED_GATE }))).toStrictEqual(POLICY_SOURCE_ABSENT);
    });
  });

  it("admits with no budget section at all, and admits identically with a forged one", () => {
    withStore("gate-unread", (store) => {
      driveThrough(store, "goal.create");
      seedActivationWorldWithGatePolicy(store, "POLICY_ALLOWANCE");
      // Planted, same reason as above: the contrast this arm measures is the PAYLOAD gate, so the
      // world must still hold an allowing durable witness or both halves refuse for an unrelated
      // reason and the pairing proves nothing.
      plantHistoricalAllowance(store);
      // Two DISTINCT admission identities, each shown to hold nothing before its own call —
      // otherwise the second would be answered by the first's standing hold, not by the gate.
      expect(activationAdmissionRef(PROJECT_ID, "principal-1", "cmd-a")).not.toBe(
        activationAdmissionRef(PROJECT_ID, "principal-1", "cmd-b"),
      );
      expect(standingHolds(
        store, activationAdmissionRef(PROJECT_ID, "principal-1", "cmd-a"),
      )).toBe(0);

      // Paired on one world so the contrast is the evidence: the payload gate changes nothing.
      expect(stage(store, undefined, "cmd-a").ok).toBe(true);
      expect(standingHolds(
        store, activationAdmissionRef(PROJECT_ID, "principal-1", "cmd-b"),
      )).toBe(0);
      expect(stage(store, { gate: FORGED_GATE }, "cmd-b").ok).toBe(true);
    });
  });

  it("pins the stage's roster to EXACTLY its surviving codes", () => {
    // THE RETIREMENT, RECORDED. `ACTIVATION_BUDGET_GATE_MALFORMED` (its world: a caller gate
    // that is not a record) and `ACTIVATION_BUDGET_GATE_WITNESS_MISMATCH` (its world: a caller
    // gate lacking the witness the node's policy names) are SUPERSEDED by
    // ADMISSION_GATE_WITNESS_ABSENT / _SCOPE_MISMATCH at the DAEMON_ADMISSION_GATE layer.
    // MEASUREMENT: neither world is constructable through production at this tree, because the
    // stage no longer reads `payload.budget.gate` at all — `readCallerGate` and
    // `checkGateWitness` and both call sites died in this same commit, which is what makes the
    // retirement checkable here rather than at a grader's HEAD. Authorized by governor
    // comment-1369e736, anchored by comment-370ca397, over QA's e194c5f6 round-2 verdict.
    //
    // LITERAL EQUALITY, not `.not.toContain`: once an identifier is deleted nothing can emit it,
    // so a "never the retired code" assertion is free and passes against any implementation.
    // NAMING TRAP: the survivors carry NO `GATE` infix, so an `ACTIVATION_BUDGET_GATE_` grep
    // returning zero after this row is expected rather than evidence of over-deletion.
    expect([...ACTIVATION_BUDGET_STAGE_CODES]).toStrictEqual([
      "ACTIVATION_BUDGET_LEG_ABSENT",
      "ACTIVATION_BUDGET_RESERVATION_ABSENT",
    ]);
  });

  it("covers every resolver code it claims to", () => {
    // Asserted so a roster that silently grows cannot leave an untested refusal behind.
    expect([...ADMISSION_GATE_RESOLVER_CODES]).toStrictEqual([
      "ADMISSION_GATE_POLICY_SOURCE_ABSENT",
      "ADMISSION_GATE_SCOPE_MISMATCH",
      "ADMISSION_GATE_SUBJECT_MISMATCH",
      "ADMISSION_GATE_WITNESS_ABSENT",
    ]);
  });
});
