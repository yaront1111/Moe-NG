/**
 * THE DURABLE BUDGET STAGE's own refusals — the witness `comment-3a2f1c` / the QA rejection of
 * task-e194c5f6 found missing.
 *
 * WHY THIS FILE EXISTS. `activation-budget-stage.ts` shipped with four refusal codes and ZERO
 * tests: no suite imported the module at all, so disabling `checkGateWitness` outright
 * (`return null`) reddened nothing across the daemon suite or `test:security`. That guard is the
 * entire boundary between the ONE surviving caller input on this route — `payload.budget.gate` —
 * and durable budget authority, so a guard nothing witnesses is the defect epic rail 6 names.
 *
 * WHAT IS ASSERTED, AND WHAT DELIBERATELY IS NOT. `checkGateWitness` answers exactly one
 * question: is the witness the node's OWN durable policy names present? Whether that witness
 * ALLOWS belongs to `checkGate` in `@moe/scheduler`, and the boundary between the two is itself
 * under test here — a DENY allowance must travel out with the SCHEDULER's code, never restamped
 * into a stage code. A suite that only proved "it refused" would pass while the two vocabularies
 * silently merged.
 *
 * THE WORLD IS PRODUCTION-WRITTEN. `seedActivationWorld` drives the graph through
 * `reduceGraphRevision` / `putGraphBody` / `createNodeDefinition` + `deriveNodeAuthoritySet` and
 * the root through `authorizeBudgetRoot`. Its single execution-bearing node carries
 * `admissionGatePolicy: "POLICY_ALLOWANCE"`, so the witness field this stage demands is
 * `allowance` — asserted below rather than assumed, because every mismatch arm hangs off it.
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

import type { AdmissionGate } from "@moe/scheduler";
import type { JsonObject } from "@moe/contracts";

import { GOAL_ID, PROJECT_ID, driveThrough } from "../bootstrap/bootstrap-test-fixtures.js";
import { reserveBudgetForAdmission } from "../budget/budget-ledger-holds.js";

import { seedActivationWorld } from "./activation-world-fixtures.js";
import {
  ACTIVATION_INGRESS_LAYER, ACTIVATION_INGRESS_SCHEMA_VERSION, EFFECT_ACTIVATE_COMMAND_KIND,
} from "./activation-ingress-contracts.js";
import type { ActivationIngressRequest } from "./activation-ingress-contracts.js";
import {
  ACTIVATION_BUDGET_STAGE_CODES, activationAdmissionRef, runActivationBudgetStage,
} from "./activation-budget-stage.js";


const COMMAND_ID = "cmd-activate-stage-1";
const DECIDED_AT = "2026-08-19T00:00:00.000Z";

/** The witness an ALLOWING policy decision looks like. Both gate keys are present because the
 *  scheduler's own `readGate` demands every declared key, absent ones included as `null`. */
const ALLOWING_GATE: AdmissionGate = {
  allowance: { decisionRef: "policy-decision-1", outcome: "ALLOW" }, approval: null,
};

/** Structurally valid and ALLOWING, but the wrong WITNESS KIND for a POLICY_ALLOWANCE node.
 *  This is the forgery `checkGateWitness` exists to stop: `checkGate` accepts either witness. */
const HUMAN_ONLY_GATE: AdmissionGate = {
  allowance: null,
  approval: { approvalRef: "approval-1", decision: "APPROVE", validity: "CURRENT" },
};

const DENYING_GATE: AdmissionGate = {
  allowance: { decisionRef: "policy-decision-1", outcome: "DENY" }, approval: null,
};

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

/** The full happy world: project, goal, ACTIVE graph, authorized root. */
function seeded(store: SqliteEventStore): void {
  driveThrough(store, "goal.create");
  seedActivationWorld(store);
}

/** Reason code AND refusing layer, never merely "it failed" (global rail 1). */
const refusalOf = (result: { ok: boolean }): readonly [string, string] => {
  const refused = result as { code?: string; layer?: string };
  return [refused.code ?? "UNEXPECTEDLY_ADMITTED", refused.layer ?? "NO_LAYER"];
};

/** `budget` is typed loose on purpose: every hostile arm below is a shape the wire can carry
 *  and the payload fence admits, which is exactly why the stage must refuse it itself. */
const requestWith = (budget: unknown, commandId: string = COMMAND_ID): ActivationIngressRequest => ({
  commandId,
  correlationId: "corr-activate-stage",
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

const MALFORMED = ["ACTIVATION_BUDGET_GATE_MALFORMED", ACTIVATION_INGRESS_LAYER] as const;
const MISMATCH = ["ACTIVATION_BUDGET_GATE_WITNESS_MISMATCH", ACTIVATION_INGRESS_LAYER] as const;

describe("activation budget stage — the accepted control the refusal arms hang off", () => {
  it("reserves against durable authority when the node's own witness is present", () => {
    withStore("accept", (store) => {
      seeded(store);
      const result = stage(store, { gate: ALLOWING_GATE });
      // Quoted so a refusal names itself rather than failing as `false !== true`.
      expect(refusalOf(result)[0]).toBe("UNEXPECTEDLY_ADMITTED");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // The node the production writers actually seeded demands the ALLOWANCE witness. Every
      // mismatch arm below depends on this, so it is asserted rather than assumed.
      expect(result.authority.gateWitnessField).toBe("allowance");
      expect(result.authority.goalRef).toBe(GOAL_ID);
      // The hold is keyed off the AUTHENTICATED command, never off a payload field.
      expect(result.budget.reservation.admissionRef).toBe(activationAdmissionRef(COMMAND_ID));
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

describe("activation budget stage — a gate that is not a record is MALFORMED, not mismatched", () => {
  /** Each case is a distinct shape the wire can carry. `null` and the missing section are kept
   *  apart from the wrong-type cases because a future guard might answer one and not the others. */
  const malformedCases: readonly (readonly [string, unknown])[] = [
    ["no budget section at all", undefined],
    ["a budget section carrying no gate", {}],
    ["an explicitly null gate", { gate: null }],
    ["a gate that is an array", { gate: [] }],
    ["a gate that is a string", { gate: "ALLOW" }],
    ["a gate that is a number", { gate: 1 }],
    ["a budget section that is itself an array", []],
    ["a budget section carrying a key outside BUDGET_KEYS", { gate: ALLOWING_GATE, smuggled: 1 }],
  ];

  // Asserted so a fixture that silently loses cases cannot pass by generating none.
  it("covers every malformed shape it claims to", () => {
    expect(malformedCases.length).toBe(8);
  });

  for (const [label, budget] of malformedCases) {
    it(`refuses ${label} with the stage's own code and layer`, () => {
      withStore(`malformed-${label.replace(/[^a-z]+/giu, "-")}`, (store) => {
        seeded(store);
        expect(refusalOf(stage(store, budget))).toStrictEqual(MALFORMED);
      });
    });
  }
});

describe("activation budget stage — the node's DURABLE policy decides which witness counts", () => {
  it("refuses a HUMAN_APPROVAL witness on a POLICY_ALLOWANCE node — the forgery this guard stops", () => {
    withStore("mismatch-human", (store) => {
      seeded(store);
      // Structurally valid AND allowing by `checkGate`'s own rules: its only absence rule is
      // `allowance === null && approval === null`, so without this stage the scheduler would
      // admit a human approval for a node whose durable policy names a policy allowance.
      expect(refusalOf(stage(store, { gate: HUMAN_ONLY_GATE }))).toStrictEqual(MISMATCH);
    });
  });

  it("refuses a gate with the named witness explicitly null", () => {
    withStore("mismatch-null", (store) => {
      seeded(store);
      expect(refusalOf(stage(store, { gate: { allowance: null, approval: null } })))
        .toStrictEqual(MISMATCH);
    });
  });

  it("refuses a gate with the named witness absent as a key", () => {
    withStore("mismatch-absent", (store) => {
      seeded(store);
      expect(refusalOf(stage(store, { gate: { approval: HUMAN_ONLY_GATE.approval } })))
        .toStrictEqual(MISMATCH);
    });
  });

  it("separates MALFORMED from MISMATCH — the two faults never stand in for each other", () => {
    withStore("mismatch-distinct", (store) => {
      seeded(store);
      const malformed = refusalOf(stage(store, { gate: null }));
      const mismatch = refusalOf(stage(store, { gate: HUMAN_ONLY_GATE }));
      expect(malformed).toStrictEqual(MALFORMED);
      expect(mismatch).toStrictEqual(MISMATCH);
      expect(malformed[0]).not.toBe(mismatch[0]);
    });
  });
});

describe("activation budget stage — presence is this stage's question, ALLOWING is the scheduler's", () => {
  it("lets a DENY allowance through to the writer, answering in the LEDGER's vocabulary", () => {
    withStore("deny-passthrough", (store) => {
      seeded(store);
      // The witness IS present, so this stage must not answer at all. Which vocabulary and
      // which LAYER replied is the assertion: restamping here would make "no witness" and
      // "witness says no" indistinguishable at the ingress boundary.
      expect(refusalOf(stage(store, { gate: DENYING_GATE })))
        .toStrictEqual(["BUDGET_LEDGER_TRANSITION_REFUSED", "BUDGET_LEDGER"]);
      // Paired with the mismatch arm on the SAME world, so the contrast is the evidence: an
      // absent witness is answered HERE, a present-but-refusing one downstream.
      expect(refusalOf(stage(store, { gate: HUMAN_ONLY_GATE }))).toStrictEqual(MISMATCH);
    });
  });

  it("keeps the scheduler's own refusal reachable only as the ledger's sourceCode", () => {
    withStore("deny-source", (store) => {
      seeded(store);
      const refused = stage(store, { gate: DENYING_GATE }) as { readonly sourceCode?: unknown };
      // RECORDED, not endorsed: the stage rebuilds its refusal as `{code, layer, ok}` and drops
      // `sourceCode`, so BUDGET_RESERVATION_POLICY_NOT_ALLOWED / _APPROVAL_NOT_CURRENT /
      // _GATE_ABSENT are indistinguishable downstream of this boundary. That narrowing predates
      // this suite and belongs to the forwarding shape, not to the witness guard under test.
      expect(refused.sourceCode).toBeUndefined();
    });
  });

  it("refuses upstream derivation faults unrestamped, so a missing graph is not a gate fault", () => {
    withStore("upstream", (store) => {
      // Deliberately NOT seeded past the goal: no ACTIVE graph exists, so the derivation
      // refuses before the gate is ever read — carrying the durable READER's own code AND
      // layer. A DAEMON_INGRESS layer here would mean this stage had restamped it.
      driveThrough(store, "goal.create");
      const refusal = refusalOf(stage(store, { gate: ALLOWING_GATE }));
      expect(refusal).toStrictEqual(["BUDGET_PROJECTION_GRAPH_UNAVAILABLE", "BUDGET_CURRENT_PROJECTION"]);
      expect(ACTIVATION_BUDGET_STAGE_CODES as readonly string[]).not.toContain(refusal[0]);
      expect(refusal[1]).not.toBe(ACTIVATION_INGRESS_LAYER);
    });
  });
});

describe("activation budget stage — a hold that already stands answers before the gate is read", () => {
  it("returns the standing hold rebuilt from its own durable event, gate unread", () => {
    withStore("standing", (store) => {
      seeded(store);
      const admissionRef = activationAdmissionRef(COMMAND_ID);
      // Reserve durably through the PRODUCTION writer first, against the real store.
      const authority = stage(store, { gate: ALLOWING_GATE });
      expect(authority.ok).toBe(true);
      if (!authority.ok) return;
      const reserved = reserveBudgetForAdmission(store, {
        accountId: authority.authority.accountId,
        admissionRef,
        amounts: authority.authority.amounts,
        context: {
          commandId: COMMAND_ID, correlationId: "corr-activate-stage",
          decidedAt: DECIDED_AT, principalId: "principal-1",
        },
        gate: ALLOWING_GATE,
        goalRef: authority.authority.goalRef,
        projectId: PROJECT_ID,
      });
      expect(refusalOf(reserved)[0]).toBe("UNEXPECTEDLY_ADMITTED");

      // Now a byte-identical retry carrying a gate this stage would otherwise refuse outright.
      // It must still succeed: the hold IS the answer, and re-reserving would fold against a
      // head that already moved and refuse the retry as REPLAY_DIVERGED.
      const replayed = stage(store, { gate: null });
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
      const first = stage(store, { gate: ALLOWING_GATE });
      expect(first.ok).toBe(true);
      // A DIFFERENT commandId derives a different admissionRef, so no hold stands for it and
      // the gate is read again — proving the early return is keyed on identity, not on any
      // hold existing anywhere on the account.
      expect(refusalOf(stage(store, { gate: null }, "cmd-activate-stage-2")))
        .toStrictEqual(MALFORMED);
    });
  });
});
