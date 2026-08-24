import { RUNTIME_COMMAND_KINDS, decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonValue } from "@moe/contracts";
import {
  POLICY_SLICE_DIGEST_VERSION, derivePolicySliceDigest, evaluatePolicy,
} from "@moe/core";
import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  BOOTSTRAP_COMMAND_KINDS,
  BOOTSTRAP_REQUEST_KEYS,
  BOOTSTRAP_SCHEMA_VERSION,
  decodeBootstrapRequestBytes,
} from "./bootstrap-contracts.js";
import {
  OBSERVATION,
  PROJECT_ID,
  closeStores,
  envelope,
  hex64,
  openStore,
  send,
} from "./bootstrap-test-fixtures.js";
import {
  POLICY_DECISION_DIGEST_VERSION,
  decisionDigestFor,
} from "./bootstrap-policy-authority.js";
import { readPolicyEvaluationAuthority } from "./bootstrap-policy-services.js";

const encoder = new TextEncoder();

function addressedPolicySlice(
  content: Readonly<Record<string, unknown>> = { autoApprovalOptIns: [], rules: [] },
): Readonly<Record<string, unknown> & { readonly sliceRef: string }> {
  const candidate = { ...content, sliceRef: "pending-policy-slice" };
  const derived = derivePolicySliceDigest(candidate);
  if (!derived.ok) throw new Error(`policy slice fixture refused: ${derived.code}`);
  return Object.freeze({ ...candidate, sliceRef: derived.digest });
}

/**
 * The ten kinds this surface owns, restated as a literal rather than derived from the
 * production list: set equality against a derived list is vacuous, because an eleventh kind
 * added to production would silently appear on both sides of the comparison.
 */
const OWNED_KINDS = [
  "approval.decide",
  "goal.close",
  "goal.create",
  "plan.propose",
  "policy.install",
  "policy.validate",
  "project.activate",
  "project.bind_repository",
  "project.register",
  "provider.probe",
] as const;

function bytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function validEnvelope(): Record<string, unknown> {
  return {
    commandId: "cmd-1",
    correlationId: "corr-1",
    decidedAt: "2026-08-08T00:00:00.000Z",
    expectedVersion: 0,
    kind: "project.register",
    payload: { owner: "owner-1", projectId: "project-1" },
    principalId: "principal-1",
    projectId: "project-1",
    schemaVersion: BOOTSTRAP_SCHEMA_VERSION,
  };
}

describe("bootstrap command vocabulary", () => {
  it("covers exactly the ten command kinds this surface owns", () => {
    expect(new Set<string>(BOOTSTRAP_COMMAND_KINDS)).toEqual(new Set<string>(OWNED_KINDS));
    expect(BOOTSTRAP_COMMAND_KINDS).toHaveLength(10);
    expect(OWNED_KINDS).toHaveLength(10);
  });

  it("names only kinds that exist in the runtime command vocabulary", () => {
    const vocabulary = new Set<string>(RUNTIME_COMMAND_KINDS);
    const unknown = BOOTSTRAP_COMMAND_KINDS.filter((kind) => !vocabulary.has(kind));
    expect(unknown).toEqual([]);
  });

  it("pins the envelope key list and schema version", () => {
    expect([...BOOTSTRAP_REQUEST_KEYS]).toEqual([
      "commandId",
      "correlationId",
      "decidedAt",
      "expectedVersion",
      "kind",
      "payload",
      "principalId",
      "projectId",
      "schemaVersion",
    ]);
    expect(BOOTSTRAP_SCHEMA_VERSION).toBe("moe-bootstrap-command/1");
  });
});

describe("bootstrap request ingress", () => {
  it("accepts an exact envelope", () => {
    const result = decodeBootstrapRequestBytes(bytes(validEnvelope()));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected acceptance");
    expect(result.request.kind).toBe("project.register");
    expect(result.request.expectedVersion).toBe(0);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("surfaces the decode error verbatim for unparseable input", () => {
    const raw = encoder.encode("{ not json");
    const decoded = decodeBoundedJsonBytes(raw);
    expect(decoded.ok).toBe(false);
    if (decoded.ok) throw new Error("expected a decode failure fixture");

    const result = decodeBootstrapRequestBytes(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.code).toBe("BOOTSTRAP_INPUT_REJECTED");
    expect(result.refusedBy).toBe("DAEMON_INGRESS");
    if (result.code !== "BOOTSTRAP_INPUT_REJECTED") throw new Error("expected decode refusal");
    expect(result.decodeError).toEqual(decoded);
    expect(result.decodeError.code).toBe(decoded.code);
    expect(result.decodeError.message).toBe(decoded.message);
  });

  it("refuses an envelope carrying an extra key", () => {
    const result = decodeBootstrapRequestBytes(
      bytes({ ...validEnvelope(), unexpected: "extra" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.code).toBe("BOOTSTRAP_REQUEST_INVALID");
    expect(result.refusedBy).toBe("DAEMON_INGRESS");
  });

  it("refuses an envelope missing a required key", () => {
    const envelope = validEnvelope();
    delete envelope["principalId"];
    const result = decodeBootstrapRequestBytes(bytes(envelope));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.code).toBe("BOOTSTRAP_REQUEST_INVALID");
    expect(result.refusedBy).toBe("DAEMON_INGRESS");
  });

  it("refuses a wrong schema version", () => {
    const result = decodeBootstrapRequestBytes(
      bytes({ ...validEnvelope(), schemaVersion: "moe-bootstrap-command/2" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.code).toBe("BOOTSTRAP_REQUEST_INVALID");
    expect(result.refusedBy).toBe("DAEMON_INGRESS");
  });

  it("refuses a command kind outside the owned nine", () => {
    const result = decodeBootstrapRequestBytes(
      bytes({ ...validEnvelope(), kind: "work.claim" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.code).toBe("BOOTSTRAP_COMMAND_UNKNOWN");
    expect(result.refusedBy).toBe("DAEMON_INGRESS");
  });

  it("refuses a non-integer expected version", () => {
    const result = decodeBootstrapRequestBytes(
      bytes({ ...validEnvelope(), expectedVersion: 1.5 }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.code).toBe("BOOTSTRAP_REQUEST_INVALID");
  });

  it("refuses a non-object payload", () => {
    const result = decodeBootstrapRequestBytes(bytes({ ...validEnvelope(), payload: [] }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.code).toBe("BOOTSTRAP_REQUEST_INVALID");
  });
});

describe("policy.install - immutable content authority", () => {
  afterEach(closeStores);

  it("refuses a valid policy slice whose address is not its canonical content digest", () => {
    const store = openStore();
    const outcome = send(store, envelope("policy.install", 0, {
      slice: { autoApprovalOptIns: [], rules: [], sliceRef: hex64("caller-label") },
    }, "cmd-install-mismatched-content"));

    expect(outcome).toMatchObject({
      code: "BOOTSTRAP_POLICY_SLICE_DIGEST_MISMATCH",
      ok: false,
      refusedBy: "DAEMON_INGRESS",
    });
    expect(store.readEvents(`${PROJECT_ID}-policy`)).toHaveLength(0);
  });

  it("refuses a second installation at an already durable address", () => {
    const store = openStore();
    const slice = addressedPolicySlice();
    expect(send(store, envelope("policy.install", 0, { slice }, "cmd-install-first")).ok)
      .toBe(true);

    const duplicate = send(
      store, envelope("policy.install", 1, { slice }, "cmd-install-duplicate"),
    );
    expect(duplicate).toMatchObject({
      code: "BOOTSTRAP_POLICY_SLICE_ALREADY_INSTALLED",
      ok: false,
      refusedBy: "DAEMON_PREREQUISITE",
    });
    expect(store.readEvents(`${PROJECT_ID}-policy`)
      .filter((event) => event.eventType === "PolicyInstalled")).toHaveLength(1);
  });
});

/**
 * `policy.validate` binds to the AUTHENTICATED principal and the INSTALLED slice bytes
 * (task-eb6a1fa6).
 *
 * The task id is in the describe title so a failing line on this shared branch attributes
 * itself to this row rather than to whoever else is mid-TDD in this file.
 *
 * The defect these arms close: `validatePolicy` proved only that `policyRevisionRef` named an
 * installed slice and then handed the CALLER'S evaluation input to `evaluatePolicy` unchanged.
 * The caller supplies `sliceChain` - the rules themselves - so a ONE-ELEMENT permissive chain
 * decides ALLOW while the ref names a DENY slice whose bytes are never read. One element is the
 * minimal exploit: `foldSlices` only detects relaxation against an ancestor WITHIN the same
 * caller-supplied chain, so a chain of one trips nothing.
 */
describe("policy.validate - binds the principal and the installed slices (task-eb6a1fa6)", () => {
  afterEach(closeStores);

  const ACTION = "plan.approve";
  const CALLER_REQUESTED_ACTIONS = [
    ACTION,
    "effect.activate",
    "operator.override",
  ] as const;

  /** A slice that FORBIDS the action outright: no opt-in covers it. */
  const denySlice = addressedPolicySlice({
    autoApprovalOptIns: [],
    // The EXACT `PolicyRule` shape (policy-contract.ts:80-85): effect, obligations,
    // requiredFactIds, ruleId. A guessed shape is refused by core as INPUT_INVALID before the
    // decision is ever reached, which reads as "the arm failed" rather than "the fixture is
    // wrong" - that is how this one first went red.
    rules: [Object.freeze({
      effect: "DENY",
      obligations: [],
      requiredFactIds: [],
      ruleId: "rule-deny-approve",
    })],
  });
  const DENY_REF = denySlice.sliceRef;

  /** The permissive one-element chain a caller would send to overrule it. */
  const permissiveSlice = Object.freeze({
    autoApprovalOptIns: [],
    rules: [],
    sliceRef: DENY_REF,
  });

  const allowSlice = addressedPolicySlice();
  const ALLOW_REF = allowSlice.sliceRef;

  /** The bootstrap prefix every policy command needs, then the installs the arm asks for. */
  function seeded(slices: readonly Record<string, unknown>[]): SqliteEventStore {
    const store = openStore();
    const prefix = [
      envelope("project.register", 0, { owner: "owner-1" }),
      envelope("project.bind_repository", 1, { observation: OBSERVATION }),
    ];
    for (const step of prefix) {
      const outcome = send(store, step);
      if (!outcome.ok) throw new Error(`seed refused at ${step.kind}: ${outcome.code}`);
    }
    slices.forEach((slice, index) => {
      const outcome = send(
        store,
        envelope("policy.install", index, { slice }, `cmd-install-${index}`),
      );
      if (!outcome.ok) throw new Error(`install refused: ${outcome.code}`);
    });
    return store;
  }

  /** The evaluation input WITHOUT the keys this row refuses; arms add back what they test. */
  function baseInput(
    policyRevisionRef: string,
    action: string = ACTION,
  ): Record<string, unknown> {
    return {
      action,
      actor: "principal-1",
      callerRiskHint: null,
      decisionDigest: hex64("d1"),
      graphNodeRevisionRefs: [],
      policyRevisionRef,
      requiredFactIds: [],
      scope: [],
    };
  }

  /**
    * A DISTINCT commandId per call. The durable decision ledger keys on
    * (commandId, principalId, projectId), so reusing one replays the first decision instead of
    * evaluating again - which would make a two-validate arm silently assert against one result.
    */
  function validate(
    store: SqliteEventStore, input: Record<string, unknown>, version: number,
    commandId = `cmd-validate-${version}`,
  ): Record<string, unknown> {
    return send(
      store, envelope("policy.validate", version, { input }, commandId),
    ) as unknown as Record<string, unknown>;
  }

  /** The LATEST durable PolicyEvaluated payload, selected BY TYPE and never by index. */
  function evaluatedRow(
    store: SqliteEventStore,
    projectId: string = PROJECT_ID,
  ): Record<string, unknown> {
    const events = store.readEvents(`${projectId}-policy`)
      .filter((event) => event.eventType === "PolicyEvaluated");
    const latest = events[events.length - 1];
    if (latest === undefined) throw new Error("no PolicyEvaluated row was written");
    const decoded = decodeBoundedJsonBytes(latest.payload);
    if (!decoded.ok) throw new Error(`payload undecodable: ${decoded.code}`);
    return decoded.value as unknown as Record<string, unknown>;
  }

  function evaluatedDecision(
    store: SqliteEventStore,
    commandId: string,
  ): Record<string, unknown> {
    const decision = store.getCommandDecision({
      commandId,
      principalId: "principal-1",
      projectId: PROJECT_ID,
    });
    if (decision === null) throw new Error("no policy.validate decision was written");
    const decoded = decodeBoundedJsonBytes(decision.resultBytes);
    if (!decoded.ok) throw new Error(`decision result undecodable: ${decoded.code}`);
    const result = decoded.value as unknown as Record<string, unknown>;
    const record = result["record"];
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      throw new Error("policy.validate decision result has no record");
    }
    return record as Record<string, unknown>;
  }

  function expectRefusal(outcome: Record<string, unknown>, code: string): void {
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe(code);
    // The LAYER, not merely the code: more than one layer can refuse this command, and an arm
    // that pins only the code stays green when a different layer starts answering first.
    expect(outcome.refusedBy).toBe("DAEMON_INGRESS");
  }

  // A. THE DEFECT. This is the arm the row exists for.
  it("refuses a caller ALLOW chain riding a durable DENY ref", () => {
    const store = seeded([denySlice]);
    const outcome = validate(store, {
      ...baseInput(DENY_REF),
      sliceChain: [permissiveSlice],
    }, 1);

    expectRefusal(outcome, "BOOTSTRAP_POLICY_CHAIN_CALLER_SUPPLIED");
    // And nothing was recorded: a refusal that still wrote the row would leave the admission
    // gate reading an ALLOW the server never verified, which is the whole defect.
    expect(() => evaluatedRow(store)).toThrow();
  });

  // B. THE ACCEPTED CONTROL - without it every arm here is answerable by a guard that refuses
  // everything. Two slices in ONE project, so the decision must FOLLOW THE REF: a handler that
  // ignored the ref entirely would pass a single-slice version of this arm.
  it("decides from the INSTALLED bytes the ref names, not from anything the caller sent", () => {
    const store = seeded([denySlice, allowSlice]);

    const allowed = validate(store, baseInput(ALLOW_REF), 2);
    expect(allowed.ok).toBe(true);
    const allowedRow = evaluatedRow(store);

    const denied = validate(store, baseInput(DENY_REF), 3);
    expect(denied.ok).toBe(true);
    const deniedRow = evaluatedRow(store);

    expect(allowedRow.policyRef).toBe(ALLOW_REF);
    expect(deniedRow.policyRef).toBe(DENY_REF);
    // The two refs produce DIFFERENT decisions from the same caller input, which is what proves
    // the installed bytes are what decided.
    expect(allowedRow.decision).not.toBe(deniedRow.decision);
  });

  // C. ACTOR BINDING. Asserted against the DURABLE ROW, not the return value.
  it("refuses an actor that disagrees with the authenticated principal", () => {
    const store = seeded([allowSlice]);
    const outcome = validate(store, {
      ...baseInput(ALLOW_REF),
      actor: "principal-somebody-else",
    }, 1);

    expectRefusal(outcome, "BOOTSTRAP_POLICY_ACTOR_UNBOUND");
  });

  it("records the AUTHENTICATED principal on the durable row, not the caller's string", () => {
    const store = seeded([allowSlice]);
    expect(validate(store, baseInput(ALLOW_REF), 1).ok).toBe(true);
    expect(evaluatedRow(store).principalId).toBe("principal-1");
  });

  // D. WAIVERS. Own-property PRESENCE is the test, so an empty array and an explicitly
  // undefined key both refuse - "no durable waiver producer" is legible in the refusal.
  it("refuses waivers by PRESENCE, including an empty array and an undefined value", () => {
    // `undefined` is deliberately NOT a case: `send` JSON-encodes the envelope, and
    // `JSON.stringify` DROPS an own key whose value is undefined, so over this wire
    // "present but undefined" and "absent" are the same bytes. Own-property presence is still
    // the right predicate - it is what distinguishes an empty array from absence - but the
    // undefined half of it is untestable through the real command path and asserting it would
    // have been a claim about a request nobody can send.
    for (const waivers of [[], [{ waiverRef: hex64("wa1") }]]) {
      const store = seeded([allowSlice]);
      const outcome = validate(store, { ...baseInput(ALLOW_REF), waivers }, 1);
      expectRefusal(outcome, "BOOTSTRAP_POLICY_WAIVER_UNVERIFIABLE");
      closeStores();
    }
  });

  // E. THE SERVER-COMPUTED DIGEST. This is what turns "the caller's value was adopted" from a
  // review question into a red.
  it("records a digest the SERVER computed, never the caller's decisionDigest", () => {
    const store = seeded([allowSlice]);
    const callerDigest = hex64("d1");
    expect(validate(store, baseInput(ALLOW_REF), 1).ok).toBe(true);

    const row = evaluatedRow(store);
    expect(typeof row.decisionDigest).toBe("string");
    expect(row.decisionDigest).not.toBe(callerDigest);
  });

  it("computes the same digest twice for the same verified evaluation", () => {
    // Determinism, so the digest is a function of what was verified rather than of the moment.
    const first = seeded([allowSlice]);
    expect(validate(first, baseInput(ALLOW_REF), 1).ok).toBe(true);
    const firstDigest = evaluatedRow(first).decisionDigest;
    closeStores();

    const second = seeded([allowSlice]);
    expect(validate(second, baseInput(ALLOW_REF), 1).ok).toBe(true);
    expect(evaluatedRow(second).decisionDigest).toBe(firstDigest);
  });

  it("computes a DIFFERENT digest for a different installed slice", () => {
    // Otherwise the digest is a constant dressed as a derivation.
    const store = seeded([denySlice, allowSlice]);
    expect(validate(store, baseInput(ALLOW_REF), 2).ok).toBe(true);
    const allowDigest = evaluatedRow(store).decisionDigest;
    expect(validate(store, baseInput(DENY_REF), 3).ok).toBe(true);
    expect(evaluatedRow(store).decisionDigest).not.toBe(allowDigest);
  });

  it("computes a DIFFERENT digest for the same evaluation in another project", () => {
    const first = seeded([allowSlice]);
    expect(validate(first, baseInput(ALLOW_REF), 1).ok).toBe(true);
    const firstDigest = evaluatedRow(first).decisionDigest;

    const otherProjectId = "project-2";
    const second = SqliteEventStore.openEphemeralForProjectTest(otherProjectId);
    try {
      const inOtherProject = (request: ReturnType<typeof envelope>) =>
        send(second, { ...request, projectId: otherProjectId });
      for (const step of [
        envelope("project.register", 0, { owner: "owner-1" }),
        envelope("project.bind_repository", 1, { observation: OBSERVATION }),
        envelope("policy.install", 0, { slice: allowSlice }, "cmd-install-other-project"),
      ]) {
        const outcome = inOtherProject(step);
        if (!outcome.ok) throw new Error(`other-project seed refused: ${outcome.code}`);
      }
      const outcome = inOtherProject(envelope(
        "policy.validate",
        1,
        { input: baseInput(ALLOW_REF) },
        "cmd-validate-other-project",
      ));
      if (!outcome.ok) throw new Error(`other-project validate refused: ${outcome.code}`);

      expect(evaluatedRow(second, otherProjectId).decisionDigest).not.toBe(firstDigest);
    } finally {
      second.close();
    }
  });

  it("binds every caller-selected evaluation field that core verified", () => {
    const store = seeded([allowSlice]);
    const baseline = baseInput(ALLOW_REF);
    expect(validate(store, baseline, 1).ok).toBe(true);
    const baselineDigest = evaluatedRow(store).decisionDigest;
    const mutations: readonly Record<string, unknown>[] = [
      { ...baseline, action: "effect.activate" },
      { ...baseline, callerRiskHint: "R0" },
      { ...baseline, graphNodeRevisionRefs: ["node-revision-1"] },
      { ...baseline, requiredFactIds: ["required-fact-1"] },
      { ...baseline, scope: ["project:project-1"] },
    ];

    mutations.forEach((input, index) => {
      expect(validate(store, input, index + 2).ok).toBe(true);
      expect(evaluatedRow(store).decisionDigest).not.toBe(baselineDigest);
    });
  });

  it("does not let the caller's passthrough digest move server evidence", () => {
    const store = seeded([allowSlice]);
    const baseline = baseInput(ALLOW_REF);
    expect(validate(store, baseline, 1).ok).toBe(true);
    const serverDigest = evaluatedRow(store).decisionDigest;

    expect(validate(store, { ...baseline, decisionDigest: hex64("different") }, 2).ok)
      .toBe(true);
    expect(evaluatedRow(store).decisionDigest).toBe(serverDigest);
  });

  it("returns the server digest instead of echoing the caller digest in the command result", () => {
    const store = seeded([allowSlice]);
    const callerDigest = hex64("caller");
    const commandId = "cmd-validate-result-digest";
    expect(validate(store, { ...baseInput(ALLOW_REF), decisionDigest: callerDigest }, 1, commandId).ok)
      .toBe(true);

    const durableDigest = evaluatedRow(store).decisionDigest;
    const returnedDigest = evaluatedDecision(store, commandId)["decisionDigest"];
    expect(returnedDigest).toBe(durableDigest);
    expect(returnedDigest).not.toBe(callerDigest);
  });

  // The durable row must answer who / which / over-what.
  it("carries who evaluated, which slice, and the server digest", () => {
    const store = seeded([allowSlice]);
    expect(validate(store, baseInput(ALLOW_REF), 1).ok).toBe(true);
    const row = evaluatedRow(store);
    for (const key of [
      "decision",
      "policyRef",
      "principalId",
      "sliceRef",
      "decisionDigest",
      "decisionDigestVersion",
      "decisionMaterial",
      "projectId",
    ]) {
      expect(Object.prototype.hasOwnProperty.call(row, key)).toBe(true);
    }
  });

  it("refuses caller-supplied facts with their own ingress code", () => {
    const store = seeded([allowSlice]);
    const outcome = validate(store, {
      ...baseInput(ALLOW_REF),
      facts: [{ factId: "fact-1", tier: "R0", truthClass: "DAEMON_VERIFIED" }],
    }, 1);

    expectRefusal(outcome, "BOOTSTRAP_POLICY_FACTS_CALLER_SUPPLIED");
    expect(() => evaluatedRow(store)).toThrow();
  });

  it("refuses caller-supplied evaluation time and evaluator provenance", () => {
    const cases = [
      ["evaluatedAtEpochMs", 1_760_000_000_000, "BOOTSTRAP_POLICY_TIME_CALLER_SUPPLIED"],
      ["evaluatorVersion", "caller-evaluator", "BOOTSTRAP_POLICY_EVALUATOR_CALLER_SUPPLIED"],
    ] as const;
    for (const [key, value, code] of cases) {
      const store = seeded([allowSlice]);
      const outcome = validate(store, { ...baseInput(ALLOW_REF), [key]: value }, 1);
      expectRefusal(outcome, code);
      closeStores();
    }
  });

  it("sources evaluation time and evaluator identity from daemon authority", () => {
    const store = seeded([allowSlice]);
    const input = baseInput(ALLOW_REF);
    expect(validate(store, input, 1).ok).toBe(true);

    const material = evaluatedRow(store)["decisionMaterial"] as Record<string, unknown>;
    const verified = material["verifiedInput"] as Record<string, unknown>;
    expect(verified["evaluatedAtEpochMs"]).toBe(Date.parse("2026-08-08T00:00:00.000Z"));
    expect(verified["evaluatorVersion"]).toBe("moe-policy-evaluator/1");
  });

  it("binds the daemon command clock reading into the decision digest", () => {
    const store = seeded([allowSlice]);
    const input = baseInput(ALLOW_REF);
    expect(validate(store, input, 1).ok).toBe(true);
    const firstDigest = evaluatedRow(store).decisionDigest;

    const second = send(store, {
      ...envelope("policy.validate", 2, { input }, "cmd-validate-second-clock"),
      decidedAt: "2026-08-08T00:00:00.001Z",
    });
    expect(second.ok).toBe(true);
    expect(evaluatedRow(store).decisionDigest).not.toBe(firstDigest);
  });

  it("refuses when the daemon command clock reading is unusable", () => {
    const store = seeded([allowSlice]);
    const outcome = send(store, {
      ...envelope("policy.validate", 1, { input: baseInput(ALLOW_REF) }),
      decidedAt: "not-a-time",
    }) as unknown as Record<string, unknown>;
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe("BOOTSTRAP_POLICY_TIME_UNAVAILABLE");
    expect(outcome.refusedBy).toBe("DAEMON_PREREQUISITE");
  });

  it("refuses parseable but noncanonical command-clock spellings", () => {
    for (const decidedAt of ["0", "2026-08-08T03:00:00+03:00"]) {
      const store = seeded([allowSlice]);
      const outcome = send(store, {
        ...envelope("policy.validate", 1, { input: baseInput(ALLOW_REF) }),
        decidedAt,
      }) as unknown as Record<string, unknown>;
      expect(outcome.ok).toBe(false);
      expect(outcome.code).toBe("BOOTSTRAP_POLICY_TIME_UNAVAILABLE");
      expect(outcome.refusedBy).toBe("DAEMON_PREREQUISITE");
      closeStores();
    }
  });

  it("routes the server-resolved fact through the evaluator and durable writer", () => {
    const store = seeded([allowSlice]);
    const input = baseInput(ALLOW_REF);
    delete input.facts;

    expect(validate(store, input, 1).ok).toBe(true);
    expect(evaluatedRow(store).decision).toBe("HOLD_UNKNOWN");
  });

  it("keeps every caller-requested action fail-closed in the durable decision", () => {
    const store = seeded([allowSlice]);

    expect(CALLER_REQUESTED_ACTIONS.length).toBeGreaterThan(0);
    CALLER_REQUESTED_ACTIONS.forEach((action, index) => {
      const commandId = `cmd-caller-action-${index}`;
      const outcome = validate(store, baseInput(ALLOW_REF, action), index + 1, commandId);
      expect(outcome.ok).toBe(true);

      const record = evaluatedDecision(store, commandId);
      expect(record["action"]).toBe(action);
      expect(record["decision"]).toBe("HOLD_UNKNOWN");
      expect(record["reasonCodes"]).toEqual(["RISK_TIER_UNCLASSIFIABLE"]);
      expect(record["decision"]).not.toBe("ALLOW");
    });
  });
});

/**
 * The STRICT reader over the widened row (task-eb6a1fa6).
 *
 * A row written before this binding landed carries only `{decision, policyRef}`. It must read
 * UNKNOWN with a code naming WHICH fact is missing, and must never be back-filled with a
 * default: a defaulted principal is indistinguishable from a verified one at every call site
 * downstream, which is the exact confusion the widened row exists to remove.
 */
describe("readPolicyEvaluationAuthority - refuses rather than infers (task-eb6a1fa6)", () => {
  afterEach(closeStores);

  const AUTHORITY_SLICE = addressedPolicySlice();
  const AUTHORITY_POLICY_REF = AUTHORITY_SLICE.sliceRef;
  const AUTHORITY_INPUT = {
    action: "plan.approve",
    actor: "principal-1",
    callerRiskHint: null,
    decisionDigest: hex64("ignored"),
    evaluatedAtEpochMs: 1_760_000_000_000,
    evaluatorVersion: "moe-policy-evaluator/1",
    facts: [{
      factId: "policy-risk-unclassifiable:test",
      tier: null,
      truthClass: "UNKNOWN",
    }],
    graphNodeRevisionRefs: [],
    policyRevisionRef: AUTHORITY_POLICY_REF,
    requiredFactIds: [],
    scope: [],
    sliceChain: [AUTHORITY_SLICE],
    waivers: [],
  };
  const AUTHORITY_EVALUATED = evaluatePolicy(AUTHORITY_INPUT);
  if (!AUTHORITY_EVALUATED.ok) throw new Error("authority fixture must evaluate");
  const { decisionDigest: _inputDigest, ...verifiedInput } = AUTHORITY_INPUT;
  const { decisionDigest: _outcomeDigest, ...verifiedOutcome } = AUTHORITY_EVALUATED.record;
  const DECISION_MATERIAL = Object.freeze({
    projectId: PROJECT_ID,
    serverSources: {
      evaluationTimeSource: "DAEMON_COMMAND_CLOCK",
      evaluatorVersionSource: "DAEMON_BUILD",
      policySliceDigestVersion: POLICY_SLICE_DIGEST_VERSION,
      waiverResolutionStatus: "RESOLVED_EMPTY",
    },
    verifiedInput,
    verifiedOutcome,
  });
  const WIDENED = Object.freeze({
    decision: AUTHORITY_EVALUATED.record.decision,
    decisionDigest: decisionDigestFor(DECISION_MATERIAL as unknown as JsonValue),
    decisionDigestVersion: POLICY_DECISION_DIGEST_VERSION,
    decisionMaterial: DECISION_MATERIAL,
    policyRef: AUTHORITY_POLICY_REF,
    principalId: "principal-1",
    projectId: PROJECT_ID,
    sliceRef: AUTHORITY_POLICY_REF,
  });

  function authorityOf(
    row: Record<string, unknown>,
    expectedProjectId: string = PROJECT_ID,
    expectedEvaluatedAtEpochMs: number = AUTHORITY_INPUT.evaluatedAtEpochMs,
  ): Record<string, unknown> {
    const result: unknown = readPolicyEvaluationAuthority(
      row as never, expectedProjectId, expectedEvaluatedAtEpochMs,
    );
    return result as Record<string, unknown>;
  }

  it("answers from a widened row", () => {
    const read = authorityOf({ ...WIDENED });
    expect(read.ok, String(read.code)).toBe(true);
    expect(read.action).toBe("plan.approve");
    expect(read.graphNodeRevisionRefs).toStrictEqual([]);
    expect(read.principalId).toBe("principal-1");
    expect(read.scope).toStrictEqual([]);
    expect(read.sliceRef).toBe(WIDENED.sliceRef);
    expect(read.decisionDigest).toBe(WIDENED.decisionDigest);
    expect(read.decisionDigestVersion).toBe(POLICY_DECISION_DIGEST_VERSION);
    expect(Object.isFrozen(read.graphNodeRevisionRefs)).toBe(true);
    expect(Object.isFrozen(read.scope)).toBe(true);
  });

  // THE LEGACY ROW. Two fields, exactly what `validatePolicy` wrote before this row.
  it("answers UNKNOWN on a legacy two-field row rather than defaulting the principal", () => {
    const read = authorityOf({ decision: "ALLOW", policyRef: hex64("a110") });
    expect(read.ok).toBe(false);
    expect(read.code).toBe("POLICY_AUTHORITY_PRINCIPAL_UNKNOWN");
    expect(read.layer).toBe("DAEMON_POLICY_AUTHORITY");
    // Nothing was invented in place of the missing facts.
    expect(read.principalId).toBeUndefined();
  });

  // A DISTINCT code per missing fact, so a reader can tell WHICH authority is absent rather
  // than only that something is. One arm per fact, because a single arm would pass while two
  // of the three codes were never reachable.
  it("names WHICH fact is missing, with its own code", () => {
    const cases = [
      ["principalId", "POLICY_AUTHORITY_PRINCIPAL_UNKNOWN"],
      ["sliceRef", "POLICY_AUTHORITY_SLICE_UNKNOWN"],
      ["decisionDigest", "POLICY_AUTHORITY_DIGEST_UNKNOWN"],
      ["decisionDigestVersion", "POLICY_AUTHORITY_DIGEST_VERSION_UNKNOWN"],
      ["projectId", "POLICY_AUTHORITY_PROJECT_UNKNOWN"],
    ] as const;
    for (const [key, code] of cases) {
      const row: Record<string, unknown> = { ...WIDENED };
      delete row[key];
      expect(authorityOf(row).code).toBe(code);
    }
  });

  it("refuses a row without the persisted digest material", () => {
    const row: Record<string, unknown> = { ...WIDENED };
    delete row["decisionMaterial"];
    expect(authorityOf(row).code).toBe("POLICY_AUTHORITY_MATERIAL_UNKNOWN");
  });

  it("refuses an empty string as loudly as an absent key", () => {
    // Otherwise "" reads as present and a caller-shaped blank becomes an authority.
    expect(authorityOf({ ...WIDENED, principalId: "" }).code)
      .toBe("POLICY_AUTHORITY_PRINCIPAL_UNKNOWN");
  });

  it("refuses a digest version whose preimage contract it does not understand", () => {
    expect(authorityOf({ ...WIDENED, decisionDigestVersion: "future-v3" }).code)
      .toBe("POLICY_AUTHORITY_DIGEST_VERSION_UNSUPPORTED");
  });

  it("refuses a policy-slice digest version whose preimage it cannot replay", () => {
    const decisionMaterial = {
      ...DECISION_MATERIAL,
      serverSources: {
        ...DECISION_MATERIAL.serverSources,
        policySliceDigestVersion: "future-policy-slice-v2",
      },
    };
    expect(authorityOf({
      ...WIDENED,
      decisionDigest: decisionDigestFor(decisionMaterial as unknown as JsonValue),
      decisionMaterial,
    }).code).toBe("POLICY_AUTHORITY_SLICE_DIGEST_VERSION_UNSUPPORTED");
  });

  it("refuses recomputed decision material whose slice bytes do not match its address", () => {
    const tamperedInput = {
      ...AUTHORITY_INPUT,
      sliceChain: [{
        autoApprovalOptIns: [{ action: "plan.approve", tier: "R0" as const }],
        rules: [],
        sliceRef: AUTHORITY_POLICY_REF,
      }],
    };
    const tampered = evaluatePolicy(tamperedInput);
    if (!tampered.ok) throw new Error("tampered policy fixture must still evaluate");
    const { decisionDigest: _tamperedInputDigest, ...tamperedVerifiedInput } = tamperedInput;
    const { decisionDigest: _tamperedOutcomeDigest, ...tamperedVerifiedOutcome } = tampered.record;
    const decisionMaterial = {
      ...DECISION_MATERIAL,
      verifiedInput: tamperedVerifiedInput,
      verifiedOutcome: tamperedVerifiedOutcome,
    };
    expect(authorityOf({
      ...WIDENED,
      decision: tampered.record.decision,
      decisionDigest: decisionDigestFor(decisionMaterial as unknown as JsonValue),
      decisionMaterial,
    }).code).toBe("POLICY_AUTHORITY_SLICE_DIGEST_MISMATCH");
  });

  it("refuses a digest that was not derived from its persisted decision material", () => {
    const read = authorityOf({
      ...WIDENED,
      decisionDigest: hex64("wrong"),
    });
    expect(read.ok).toBe(false);
    expect(read.code).toBe("POLICY_AUTHORITY_DIGEST_MISMATCH");
  });

  it("refuses copied authority under another expected project", () => {
    expect(authorityOf({ ...WIDENED }, "project-2").code)
      .toBe("POLICY_AUTHORITY_PROJECT_MISMATCH");
  });

  it("refuses authority moved onto an event with another command-clock timestamp", () => {
    const read = authorityOf(
      { ...WIDENED }, PROJECT_ID, AUTHORITY_INPUT.evaluatedAtEpochMs + 1,
    );
    expect(read.ok).toBe(false);
    expect(read.code).toBe("POLICY_AUTHORITY_TIME_MISMATCH");
    expect(read.layer).toBe("DAEMON_POLICY_AUTHORITY");
  });

  it("refuses a recomputed digest over an outcome core did not produce", () => {
    const decisionMaterial = {
      ...DECISION_MATERIAL,
      verifiedOutcome: { ...verifiedOutcome, decision: "DENY" },
    };
    expect(authorityOf({
      ...WIDENED,
      decision: "DENY",
      decisionDigest: decisionDigestFor(decisionMaterial as unknown as JsonValue),
      decisionMaterial,
    }).code).toBe("POLICY_AUTHORITY_OUTCOME_MISMATCH");
  });

  it("refuses a recomputed authority carrying an additional policy slice", () => {
    const extraInput = {
      ...AUTHORITY_INPUT,
      sliceChain: [
        ...AUTHORITY_INPUT.sliceChain,
        { autoApprovalOptIns: [], rules: [], sliceRef: hex64("extra-slice") },
      ],
    };
    const extraEvaluated = evaluatePolicy(extraInput);
    if (!extraEvaluated.ok) throw new Error("additional-slice fixture must evaluate");
    const { decisionDigest: _extraInputDigest, ...extraVerifiedInput } = extraInput;
    const { decisionDigest: _extraOutcomeDigest, ...extraVerifiedOutcome } = extraEvaluated.record;
    const decisionMaterial = {
      ...DECISION_MATERIAL,
      verifiedInput: extraVerifiedInput,
      verifiedOutcome: extraVerifiedOutcome,
    };
    expect(authorityOf({
      ...WIDENED,
      decision: extraEvaluated.record.decision,
      decisionDigest: decisionDigestFor(decisionMaterial as unknown as JsonValue),
      decisionMaterial,
    }).code).toBe("POLICY_AUTHORITY_SUMMARY_MISMATCH");
  });

  it("refuses malformed digests, mismatched summaries, and extra row keys", () => {
    expect(authorityOf({ ...WIDENED, decisionDigest: "not-a-digest" }).code)
      .toBe("POLICY_AUTHORITY_DIGEST_INVALID");
    expect(authorityOf({ ...WIDENED, sliceRef: hex64("different") }).code)
      .toBe("POLICY_AUTHORITY_SLICE_DIGEST_MISMATCH");
    expect(authorityOf({ ...WIDENED, extra: true }).code)
      .toBe("POLICY_AUTHORITY_ROW_UNREADABLE");
  });

  it("refuses a row that is not a record at all", () => {
    for (const value of [null, [], "row", 3]) {
      expect(authorityOf(value as never).code).toBe("POLICY_AUTHORITY_ROW_UNREADABLE");
    }
  });

  // The reader must answer over what `validatePolicy` ACTUALLY writes, not over a literal this
  // file shaped - otherwise the two can drift and both stay green.
  it("answers from the row the production handler really wrote", () => {
    const store = openStore();
    for (const step of [
      envelope("project.register", 0, { owner: "owner-1" }),
      envelope("project.bind_repository", 1, { observation: OBSERVATION }),
    ]) {
      const outcome = send(store, step);
      if (!outcome.ok) throw new Error(`seed refused at ${step.kind}: ${outcome.code}`);
    }
    const slice = addressedPolicySlice();
    const sliceRef = slice.sliceRef;
    const installed = send(store, envelope("policy.install", 0, {
      slice,
    }, "cmd-install-reader"));
    if (!installed.ok) throw new Error(`install refused: ${installed.code}`);
    const validated = send(store, envelope("policy.validate", 1, {
      input: {
        action: "plan.approve",
        actor: "principal-1",
        callerRiskHint: null,
        decisionDigest: hex64("d1"),
        graphNodeRevisionRefs: [],
        policyRevisionRef: sliceRef,
        requiredFactIds: [],
        scope: [],
      },
    }, "cmd-validate-reader"));
    if (!validated.ok) throw new Error(`validate refused: ${validated.code}`);

    const events = store.readEvents(`${PROJECT_ID}-policy`)
      .filter((event) => event.eventType === "PolicyEvaluated");
    const latest = events[events.length - 1];
    if (latest === undefined) throw new Error("no PolicyEvaluated row was written");
    const decoded = decodeBoundedJsonBytes(latest.payload);
    if (!decoded.ok) throw new Error(`payload undecodable: ${decoded.code}`);

    const read = authorityOf(
      decoded.value as unknown as Record<string, unknown>,
      PROJECT_ID,
      Date.parse(latest.committedAt),
    );
    expect(read.ok).toBe(true);
    expect(read.action).toBe("plan.approve");
    expect(read.graphNodeRevisionRefs).toStrictEqual([]);
    expect(read.principalId).toBe("principal-1");
    expect(read.scope).toStrictEqual([]);
    expect(read.sliceRef).toBe(sliceRef);
    expect(typeof read.decisionDigest).toBe("string");
    expect(read.decisionDigestVersion).toBe(POLICY_DECISION_DIGEST_VERSION);
    expect(read.decisionDigest).not.toBe(hex64("d1"));
  });
});
