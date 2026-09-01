/**
 * THE DURABLE BUDGET STAGE's own refusals, and the BOUNDARIES it must not restamp.
 *
 * WHY THIS FILE EXISTS. `activation-budget-stage.ts` shipped with four refusal codes and ZERO
 * tests: no suite imported the module at all, so disabling its guards outright reddened nothing
 * across the daemon suite or `test:security` (the QA rejection of task-e194c5f6). A guard nothing
 * witnesses is the defect epic rail 6 names.
 *
 * WHAT CHANGED UNDER IT, and what that cost this file. task-93e8aab3 replaced the one surviving
 * caller input on this route — `payload.budget.gate` — with `resolveAdmissionGate`, which builds
 * the witness from durable records. `readCallerGate` and `checkGateWitness` and both of their
 * call sites died in that commit, and with them TWO refusal codes and the twelve arms that drove
 * them:
 *
 *   ACTIVATION_BUDGET_GATE_MALFORMED — eight arms, one per wire shape a caller could put in
 *     `payload.budget.gate` (absent section, gate null, gate an array, gate a string, ...).
 *   ACTIVATION_BUDGET_GATE_WITNESS_MISMATCH — four arms, a gate carrying the OTHER witness kind
 *     than the node's `admissionGatePolicy` names.
 *
 * BOTH WORLDS ARE UNCONSTRUCTABLE THROUGH PRODUCTION AT THIS TREE: no expression in
 * `activation-budget-stage.ts` reads `request.payload` any more, so no payload shape can reach a
 * gate check that no longer exists. Retiring those arms was AUTHORIZED IN RECORDED FORM by
 * governor `comment-1369e736` and anchored to the DELIVERED tree by `comment-370ca397` — the
 * call-site deletion and the arm deletion land in ONE commit, which is what makes the claim
 * checkable at all. Their replacement coverage lives in `admission-gate-resolver.test.ts`
 * (`ADMISSION_GATE_WITNESS_ABSENT` / `_SCOPE_MISMATCH` at the `DAEMON_ADMISSION_GATE` layer),
 * and the stage's surviving roster is pinned there by literal equality so a future silent
 * deletion reddens. The two survivors — ACTIVATION_BUDGET_LEG_ABSENT and
 * ACTIVATION_BUDGET_RESERVATION_ABSENT — are NOT retired and this retirement does not extend to
 * them by analogy.
 *
 * WHAT IS ASSERTED HERE NOW: that the stage answers with the DURABLE witness, and that every
 * refusal which is not its own travels out unrestamped — the derivation's upstream code and
 * layer, the ledger's own vocabulary when a present witness does not allow, and the standing
 * hold that answers before any witness is resolved at all.
 *
 * THE WORLD USES PRODUCTION DURABLE SHAPES. `seedActivationWorld` drives the graph through
 * `reduceGraphRevision` / `putGraphBody` / `createNodeDefinition` + `deriveNodeAuthoritySet` and
 * the root through `authorizeBudgetRoot`. Non-allowing decisions remain production-written;
 * ALLOW reader coverage uses the explicitly historical event-seam fixture and claims no current
 * production reachability.
 *
 * WINDOWS HANDLE DISCIPLINE: the store handle closes in a `finally` INSIDE the temp directory's
 * own `finally`. A handle held across `rmSync` throws EPERM and kills the vitest worker with no
 * output at all.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SqliteEventStore } from "@moe/store";

import type { JsonObject } from "@moe/contracts";

import { policyAggregateId } from "../bootstrap/bootstrap-sequence.js";
import { GOAL_ID, PROJECT_ID, driveThrough } from "../bootstrap/bootstrap-test-fixtures.js";
import { reserveBudgetForAdmission } from "../budget/budget-ledger-holds.js";

import { captureBudgetLeg } from "./activation-budget-derivation.js";
import {
  ACTIVATION_WORLD_NODE_KEY, ACTIVATION_WORLD_POLICY_SLICE_HASH, ACTIVATION_WORLD_REVISION_ID,
  seedActivationWorldWithoutPolicyWitness,
} from "./activation-world-fixtures.js";
import {
  ACTIVATION_INGRESS_LAYER, ACTIVATION_INGRESS_SCHEMA_VERSION, EFFECT_ACTIVATE_COMMAND_KIND,
} from "./activation-ingress-contracts.js";
import type { ActivationIngressRequest } from "./activation-ingress-contracts.js";
import { ACTIVATION_LEDGER_COMMAND_KIND } from "./activation-ledger-contracts.js";
import {
  ACTIVATION_BUDGET_STAGE_CODES, runActivationBudgetStage,
} from "./activation-budget-stage.js";
import {
  activationAdmissionRef, legacyActivationAdmissionRef,
} from "./activation-admission-identity.js";
import { resolveAdmissionGate } from "./admission-gate-resolver.js";
import {
  HISTORICAL_POLICY_ALLOWANCE_EVALUATED_AT_EPOCH_MS, plantHistoricalPolicyAllowance,
  plantHistoricalPolicyHold,
} from "./policy-allowance-fixtures.js";

const COMMAND_ID = "cmd-activate-stage-1";
const DECIDED_AT = "2026-08-19T00:00:00.000Z";
const encoder = new TextEncoder();
const ACTIVATION_POLICY_SUBJECT = Object.freeze({
  action: "effect.activate",
  graphNodeRevisionRefs: Object.freeze([ACTIVATION_WORLD_REVISION_ID]),
  policyRef: ACTIVATION_WORLD_POLICY_SLICE_HASH,
  principalId: "principal-1",
  scope: Object.freeze([ACTIVATION_WORLD_NODE_KEY]),
});

function withStore<T>(name: string, run: (store: SqliteEventStore) => T): T {
  const directory = mkdtempSync(join(tmpdir(), `moe-actstage-${name}-`));
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
  name: string, prepare: (store: SqliteEventStore) => void,
  run: (store: SqliteEventStore) => T,
): T {
  const directory = mkdtempSync(join(tmpdir(), `moe-actstage-${name}-`));
  const databasePath = join(directory, "store.sqlite");
  try {
    const first = SqliteEventStore.openForProject(databasePath, PROJECT_ID);
    try {
      prepare(first);
    } finally {
      first.close();
    }
    const reopened = SqliteEventStore.openForProject(databasePath, PROJECT_ID);
    try {
      return run(reopened);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { force: true, maxRetries: 5, recursive: true });
  }
}

/** The explicit historical-policy world: production graph/root plus a contained ALLOW event. */
function seeded(store: SqliteEventStore): void {
  driveThrough(store, "goal.create");
  seedActivationWorldWithoutPolicyWitness(store, "POLICY_ALLOWANCE");
  plantHistoricalAllowance(store);
}

/** Reason code AND refusing layer, never merely "it failed" (global rail 1). */
const refusalOf = (result: { ok: boolean }): readonly [string, string] => {
  const refused = result as { code?: string; layer?: string };
  return [refused.code ?? "UNEXPECTEDLY_ADMITTED", refused.layer ?? "NO_LAYER"];
};

/**
 * `budget` is typed loose on purpose and every arm below passes `undefined`.
 *
 * The parameter survives the gate's retirement because the SECTION still rides the envelope
 * until fence link 4 (task-b8b69e74) drops it — this stage simply never reads it. The one arm
 * that hands it hostile bytes lives in `admission-gate-resolver.test.ts`, where the claim it
 * proves ("the caller's gate is not an input") belongs.
 */
const requestWith = (
  budget: unknown, commandId: string = COMMAND_ID, principalId = "principal-1",
): ActivationIngressRequest => ({
  commandId,
  correlationId: "corr-activate-stage",
  decidedAt: DECIDED_AT,
  expectedVersion: 0,
  kind: EFFECT_ACTIVATE_COMMAND_KIND,
  payload: (budget === undefined ? {} : { budget }) as unknown as JsonObject,
  principalId,
  projectId: PROJECT_ID,
  schemaVersion: ACTIVATION_INGRESS_SCHEMA_VERSION,
});

const stage = (store: SqliteEventStore, commandId?: string, principalId?: string) =>
  runActivationBudgetStage(
    commandId === undefined
      ? { request: requestWith(undefined), store }
      : { request: requestWith(undefined, commandId, principalId), store },
  );

const LEDGER_REFUSED = ["BUDGET_LEDGER_TRANSITION_REFUSED", "BUDGET_LEDGER"] as const;
const LEDGER_IDENTITY_REFUSED = [
  "BUDGET_LEDGER_IDEMPOTENCY_CONFLICT", "BUDGET_LEDGER",
] as const;

function plantHistoricalAllowance(store: SqliteEventStore): void {
  plantHistoricalPolicyAllowance(
    store, PROJECT_ID, HISTORICAL_POLICY_ALLOWANCE_EVALUATED_AT_EPOCH_MS,
    ACTIVATION_POLICY_SUBJECT,
  );
  const landed = store.readEvents(policyAggregateId(PROJECT_ID)).filter(
    (event) => event.commandId.startsWith("plant-historical-policy-allowance-"),
  );
  expect(landed).toHaveLength(1);
  expect(landed[0]?.eventType).toBe("PolicyEvaluated");
  expect(landed[0]?.committedAt).toBe(
    new Date(HISTORICAL_POLICY_ALLOWANCE_EVALUATED_AT_EPOCH_MS).toISOString(),
  );
}

function admissionAuthority(store: SqliteEventStore) {
  const staged = stage(store);
  expect(staged.ok).toBe(true);
  if (!staged.ok) throw new Error(`activation authority refused: ${refusalOf(staged).join(" @ ")}`);
  const resolved = resolveAdmissionGate({
    goalRef: staged.authority.goalRef,
    graphRevisionRef: staged.authority.graphRevisionRef,
    nodeKey: staged.authority.nodeKey,
    policySliceHash: staged.authority.policySliceHash,
    principalId: "principal-1",
    projectId: PROJECT_ID,
    store,
    witnessField: staged.authority.gateWitnessField,
  });
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) throw new Error(`admission gate refused: ${resolved.code}`);
  return { authority: staged.authority, gate: resolved.gate };
}

function plantAuthenticatedActivationHold(
  store: SqliteEventStore, admissionRef: string,
): void {
  const { authority, gate } = admissionAuthority(store);
  const captured = captureBudgetLeg((commit) => reserveBudgetForAdmission(store, {
    accountId: authority.accountId,
    admissionRef,
    amounts: authority.amounts,
    context: {
      commandId: COMMAND_ID, correlationId: "corr-activate-stage",
      decidedAt: DECIDED_AT, principalId: "principal-1",
    },
    gate,
    goalRef: authority.goalRef,
    projectId: PROJECT_ID,
  }, commit));
  expect(captured.result.ok).toBe(true);
  if (!("leg" in captured)) return;
  const committed = store.commitExpectedVersionDecision({
    commandKind: ACTIVATION_LEDGER_COMMAND_KIND,
    committedResultBytes: encoder.encode("legacy-activation-result"),
    correlationId: "corr-activate-stage",
    decidedAt: DECIDED_AT,
    events: captured.leg.events,
    expectedVersion: captured.leg.expectedVersion,
    key: { commandId: COMMAND_ID, principalId: "principal-1", projectId: PROJECT_ID },
    requestBytes: encoder.encode("legacy-activation-request"),
    targetAggregateId: captured.leg.aggregateId,
  });
  expect(committed.decision.effectDisposition).toBe("EFFECTS_COMMITTED");
}

function plantBudgetCommandHold(store: SqliteEventStore, admissionRef: string): void {
  const { authority, gate } = admissionAuthority(store);
  const reserved = reserveBudgetForAdmission(store, {
    accountId: authority.accountId,
    admissionRef,
    amounts: authority.amounts,
    context: {
      commandId: COMMAND_ID, correlationId: "corr-activate-stage",
      decidedAt: DECIDED_AT, principalId: "principal-1",
    },
    gate,
    goalRef: authority.goalRef,
    projectId: PROJECT_ID,
  });
  expect(refusalOf(reserved)[0]).toBe("UNEXPECTEDLY_ADMITTED");
}

describe("activation budget stage — the accepted control the refusal arms hang off", () => {
  it("length-frames every authenticated admission identity component", () => {
    expect(activationAdmissionRef("ab", "c", "d")).not.toBe(
      activationAdmissionRef("a", "bc", "d"),
    );
    expect(activationAdmissionRef(PROJECT_ID, "principal-1", COMMAND_ID)).not.toBe(
      activationAdmissionRef(PROJECT_ID, "principal-other", COMMAND_ID),
    );
    expect(activationAdmissionRef(PROJECT_ID, "principal-1", COMMAND_ID)).not.toBe(
      activationAdmissionRef("project-other", "principal-1", COMMAND_ID),
    );
  });

  it("reserves against durable authority with no caller input at all", () => {
    withStore("accept", (store) => {
      driveThrough(store, "goal.create");
      seedActivationWorldWithoutPolicyWitness(store, "POLICY_ALLOWANCE");
      plantHistoricalAllowance(store);
      const result = stage(store);
      // Quoted so a refusal names itself rather than failing as `false !== true`.
      expect(refusalOf(result)[0]).toBe("UNEXPECTEDLY_ADMITTED");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // The node the production writers actually seeded demands the ALLOWANCE witness, and the
      // resolver builds exactly that one. Asserted rather than assumed: every arm depends on it.
      expect(result.authority.gateWitnessField).toBe("allowance");
      expect(result.authority.goalRef).toBe(GOAL_ID);
      // The hold is keyed off the AUTHENTICATED command, never off a payload field.
      expect(result.budget.reservation.admissionRef).toBe(
        activationAdmissionRef(PROJECT_ID, "principal-1", COMMAND_ID),
      );
      expect(result.budget.reservation.accountId).toBe(result.authority.accountId);
      // A leg is what the activation's atomic commit carries; an accepted stage without one
      // would publish a receipt for a hold this decision never writes.
      expect(result.leg.aggregateId.length).toBeGreaterThan(0);
      expect(result.leg.events.length).toBe(1);
      // Amounts come from the durable node definition. Nonzero, so an empty world cannot pass
      // this arm vacuously while every refusal arm below still refuses for its own reason.
      expect(result.authority.amounts.length).toBeGreaterThan(0);
    });
  });
});

describe("activation budget stage — resolving the witness is its job, ALLOWING is the scheduler's", () => {
  it("lets a non-allowing durable decision through to the writer, in the LEDGER's vocabulary", () => {
    withStore("deny-passthrough", (store) => {
      driveThrough(store, "goal.create");
      seedActivationWorldWithoutPolicyWitness(store, "POLICY_ALLOWANCE");
      plantHistoricalPolicyHold(
        store, PROJECT_ID, HISTORICAL_POLICY_ALLOWANCE_EVALUATED_AT_EPOCH_MS,
        ACTIVATION_POLICY_SUBJECT,
      );
      // The witness EXISTS, so neither this stage nor the resolver may answer. Which vocabulary
      // and which LAYER replied is the assertion: restamping would make "no durable witness"
      // and "the durable witness says no" indistinguishable at the ingress boundary.
      expect(refusalOf(stage(store))).toStrictEqual(LEDGER_REFUSED);
    });
  });

  it("keeps the scheduler's own refusal reachable only as the ledger's sourceCode", () => {
    withStore("deny-source", (store) => {
      driveThrough(store, "goal.create");
      seedActivationWorldWithoutPolicyWitness(store, "POLICY_ALLOWANCE");
      const refused = stage(store) as { readonly sourceCode?: unknown };
      // RECORDED, not endorsed: the stage rebuilds its refusal as `{code, layer, ok}` and drops
      // `sourceCode`, so BUDGET_RESERVATION_POLICY_NOT_ALLOWED / _APPROVAL_NOT_CURRENT /
      // _GATE_ABSENT are indistinguishable downstream of this boundary. That narrowing predates
      // this suite and belongs to the forwarding shape, not to any guard under test.
      expect(refused.sourceCode).toBeUndefined();
    });
  });

  it("refuses upstream derivation faults unrestamped, so a missing graph is not a gate fault", () => {
    withStore("upstream", (store) => {
      // Deliberately NOT seeded past the goal: no ACTIVE graph exists, so the derivation
      // refuses before any witness is resolved — carrying the durable READER's own code AND
      // layer. A DAEMON_INGRESS layer here would mean this stage had restamped it.
      driveThrough(store, "goal.create");
      const refusal = refusalOf(stage(store));
      expect(refusal).toStrictEqual(["BUDGET_PROJECTION_GRAPH_UNAVAILABLE", "BUDGET_CURRENT_PROJECTION"]);
      expect(ACTIVATION_BUDGET_STAGE_CODES as readonly string[]).not.toContain(refusal[0]);
      expect(refusal[1]).not.toBe(ACTIVATION_INGRESS_LAYER);
    });
  });
});

describe("activation budget stage — a hold that already stands answers before the witness is read", () => {
  it("replays an authenticated legacy hold after reopening the durable store", () => {
    withReopenedStore("standing-legacy", (store) => {
      seeded(store);
      plantAuthenticatedActivationHold(store, legacyActivationAdmissionRef(COMMAND_ID));
    }, (store) => {
      plantHistoricalPolicyHold(
        store, PROJECT_ID, HISTORICAL_POLICY_ALLOWANCE_EVALUATED_AT_EPOCH_MS + 1,
        ACTIVATION_POLICY_SUBJECT,
      );
      const replayed = stage(store);
      expect(replayed.ok).toBe(true);
      if (!replayed.ok) return;
      expect(replayed.budget.reservation.admissionRef).toBe(
        legacyActivationAdmissionRef(COMMAND_ID),
      );
      expect(refusalOf(stage(store, COMMAND_ID, "principal-other"))).toStrictEqual([
        "ADMISSION_GATE_SUBJECT_MISMATCH", "DAEMON_ADMISSION_GATE",
      ]);
    });
  });

  it("returns the standing hold even once the durable decision stops allowing", () => {
    withStore("standing", (store) => {
      seeded(store);
      const admissionRef = activationAdmissionRef(PROJECT_ID, "principal-1", COMMAND_ID);
      plantAuthenticatedActivationHold(store, admissionRef);

      // Append the contained historical HOLD shape: production cannot extend a stream carrying
      // reader-only ALLOW history, and this test makes no such authority claim.
      plantHistoricalPolicyHold(
        store, PROJECT_ID, HISTORICAL_POLICY_ALLOWANCE_EVALUATED_AT_EPOCH_MS + 1,
        ACTIVATION_POLICY_SUBJECT,
      );
      // The byte-identical retry must still succeed: the hold IS the answer, and re-reserving
      // would fold against a head that already moved and refuse as REPLAY_DIVERGED.
      const replayed = stage(store);
      expect(replayed.ok).toBe(true);
      if (!replayed.ok) return;
      expect(replayed.budget.reservation.admissionRef).toBe(admissionRef);
      // The leg is reconstructed from the ORIGINAL event, so the retry presents the same fence.
      expect(replayed.leg.events.length).toBe(1);
    });
  });

  it("does not let one command's hold answer for another's admission identity", () => {
    withStore("standing-foreign", (store) => {
      seeded(store);
      plantAuthenticatedActivationHold(
        store, activationAdmissionRef(PROJECT_ID, "principal-1", COMMAND_ID),
      );
      plantHistoricalPolicyHold(
        store, PROJECT_ID, HISTORICAL_POLICY_ALLOWANCE_EVALUATED_AT_EPOCH_MS + 1,
        ACTIVATION_POLICY_SUBJECT,
      );
      // A DIFFERENT commandId derives a different admissionRef, so no hold stands for it and the
      // witness is resolved again — proving the early return is keyed on identity, not on any
      // hold existing anywhere on the account. It then refuses in the LEDGER's own vocabulary,
      // which is the same contrast the standing arm above turns on.
      expect(refusalOf(stage(store, "cmd-activate-stage-2"))).toStrictEqual(LEDGER_REFUSED);
    });
  });

  it("does not let another principal reuse a standing hold under the same command id", () => {
    withStore("standing-foreign-principal", (store) => {
      seeded(store);
      plantAuthenticatedActivationHold(
        store, activationAdmissionRef(PROJECT_ID, "principal-1", COMMAND_ID),
      );

      expect(refusalOf(stage(store, COMMAND_ID, "principal-other"))).toStrictEqual([
        "ADMISSION_GATE_SUBJECT_MISMATCH", "DAEMON_ADMISSION_GATE",
      ]);
    });
  });

  it("does not trust a matching hold planted by the budget command", () => {
    withStore("standing-budget-command", (store) => {
      seeded(store);
      plantBudgetCommandHold(
        store, activationAdmissionRef(PROJECT_ID, "principal-1", COMMAND_ID),
      );
      plantHistoricalPolicyHold(
        store, PROJECT_ID, HISTORICAL_POLICY_ALLOWANCE_EVALUATED_AT_EPOCH_MS + 1,
        ACTIVATION_POLICY_SUBJECT,
      );
      expect(refusalOf(stage(store))).toStrictEqual(LEDGER_IDENTITY_REFUSED);
    });
  });
});
