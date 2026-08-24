import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonObject } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { resolvePolicyFact } from "./policy-fact-resolver.js";
import {
  OBSERVATION,
  POLICY_REF,
  POLICY_SLICE,
  PROJECT_ID,
  closeStores,
  envelope,
  hex64,
  openStore,
  send,
} from "./bootstrap-test-fixtures.js";

const ACTION = "plan.approve";
const PRINCIPAL_ID = "principal-1";
const CALLER_DIGEST = hex64("cab");
const HOSTILE_TRUTH_CLASSES = ["DAEMON_VERIFIED", "HUMAN_APPROVED"] as const;

function seedPolicy(): SqliteEventStore {
  const store = openStore();
  const commands = [
    envelope("project.register", 0, { owner: "owner-1" }, "adopt-register"),
    envelope(
      "project.bind_repository",
      1,
      { observation: OBSERVATION },
      "adopt-bind",
    ),
    envelope("policy.install", 0, { slice: POLICY_SLICE }, "adopt-install"),
  ];
  for (const command of commands) {
    const outcome = send(store, command);
    if (!outcome.ok) throw new Error(`adoption seed refused: ${outcome.code}`);
  }
  return store;
}

function validationInput(): Record<string, unknown> {
  return {
    action: ACTION,
    actor: PRINCIPAL_ID,
    callerRiskHint: null,
    decisionDigest: CALLER_DIGEST,
    graphNodeRevisionRefs: [],
    policyRevisionRef: POLICY_REF,
    requiredFactIds: [],
    scope: [],
  };
}

function policyRows(store: SqliteEventStore): readonly Uint8Array[] {
  return store.readEvents(`${PROJECT_ID}-policy`)
    .filter((event) => event.eventType === "PolicyEvaluated")
    .map((event) => event.payload);
}

function decodeObject(bytes: Uint8Array, label: string): JsonObject {
  const decoded = decodeBoundedJsonBytes(bytes);
  if (!decoded.ok) throw new Error(`${label} was undecodable: ${decoded.code}`);
  if (decoded.value === null || typeof decoded.value !== "object"
    || Array.isArray(decoded.value)) {
    throw new Error(`${label} was not an object`);
  }
  return decoded.value as JsonObject;
}

function objectField(
  value: JsonObject, key: string, label: string,
): JsonObject {
  const field = value[key];
  if (field === null || typeof field !== "object" || Array.isArray(field)) {
    throw new Error(`${label}.${key} was not an object`);
  }
  return field as JsonObject;
}

describe("server-held policy fact adoption", () => {
  afterEach(closeStores);

  it("refuses every trusted-looking caller fact before it gains durable authority", () => {
    expect(HOSTILE_TRUTH_CLASSES.length).toBeGreaterThan(0);
    expect(HOSTILE_TRUTH_CLASSES).toEqual(["DAEMON_VERIFIED", "HUMAN_APPROVED"]);
    let executedCases = 0;

    for (const truthClass of HOSTILE_TRUTH_CLASSES) {
      const store = seedPolicy();
      const commandId = `caller-fact-${truthClass.toLowerCase()}`;
      const outcome = send(store, envelope("policy.validate", 1, {
        input: {
          ...validationInput(),
          facts: [{ factId: `caller-${truthClass}`, tier: "R0", truthClass }],
        },
      }, commandId));

      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("expected caller-fact refusal");
      expect(outcome.code).toBe("BOOTSTRAP_POLICY_FACTS_CALLER_SUPPLIED");
      expect(outcome.refusedBy).toBe("DAEMON_INGRESS");
      expect(policyRows(store)).toHaveLength(0);
      expect(store.getCommandDecision({
        commandId,
        principalId: PRINCIPAL_ID,
        projectId: PROJECT_ID,
      })).toBeNull();
      executedCases += 1;
      closeStores();
    }

    expect(executedCases).toBe(HOSTILE_TRUTH_CLASSES.length);
  });

  it("persists only the server-resolved UNKNOWN fact evaluated by core", () => {
    const store = seedPolicy();
    const commandId = "server-fact-control";
    const outcome = send(store, envelope(
      "policy.validate", 1, { input: validationInput() }, commandId,
    ));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(`server fact refused: ${outcome.code}`);
    const rows = policyRows(store);
    expect(rows).toHaveLength(1);
    const encodedRow = rows[0];
    if (encodedRow === undefined) throw new Error("PolicyEvaluated row was not written");
    const row = decodeObject(encodedRow, "PolicyEvaluated payload");
    const material = objectField(row, "decisionMaterial", "PolicyEvaluated payload");
    const verifiedInput = objectField(material, "verifiedInput", "decisionMaterial");
    const verifiedOutcome = objectField(material, "verifiedOutcome", "decisionMaterial");
    const result = decodeObject(outcome.decision.resultBytes, "command result");
    const resultRecord = objectField(result, "record", "command result");
    const expectedFact = resolvePolicyFact(PROJECT_ID, PRINCIPAL_ID, ACTION);

    expect(material["projectId"]).toBe(PROJECT_ID);
    expect(verifiedInput["actor"]).toBe(PRINCIPAL_ID);
    expect(verifiedInput["action"]).toBe(ACTION);
    expect(verifiedInput["facts"]).toEqual([expectedFact]);
    expect(verifiedOutcome["decision"]).toBe("HOLD_UNKNOWN");
    expect(verifiedOutcome["reasonCodes"]).toEqual(["RISK_TIER_UNCLASSIFIABLE"]);
    expect(row["decision"]).toBe("HOLD_UNKNOWN");
    expect(row["projectId"]).toBe(PROJECT_ID);
    expect(row["principalId"]).toBe(PRINCIPAL_ID);
    expect(row["policyRef"]).toBe(POLICY_REF);
    expect(row["sliceRef"]).toBe(POLICY_REF);
    expect(row["decisionDigest"]).toMatch(/^[0-9a-f]{64}$/u);
    expect(row["decisionDigest"]).toBe(resultRecord["decisionDigest"]);
    expect(row["decisionDigest"]).not.toBe(CALLER_DIGEST);
    expect(verifiedInput).not.toHaveProperty("decisionDigest");
    expect(verifiedOutcome).not.toHaveProperty("decisionDigest");
    expect(resultRecord["decision"]).toBe("HOLD_UNKNOWN");
    expect(resultRecord["reasonCodes"]).toEqual(["RISK_TIER_UNCLASSIFIABLE"]);
  });
});
