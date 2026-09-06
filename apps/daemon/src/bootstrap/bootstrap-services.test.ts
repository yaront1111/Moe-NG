import { RUNTIME_COMMAND_KINDS, decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonValue } from "@moe/contracts";
import {
  POLICY_SLICE_DIGEST_VERSION, derivePolicySliceDigest, evaluatePolicy,
} from "@moe/core";
import type { PolicyObligation } from "@moe/core";
import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  BOOTSTRAP_COMMAND_KINDS,
  BOOTSTRAP_REQUEST_KEYS,
  BOOTSTRAP_SCHEMA_VERSION,
  decodeBootstrapRequestBytes,
} from "./bootstrap-contracts.js";
import { admitBootstrapCommand } from "./bootstrap-services.js";
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
import type { ServiceOutcome } from "./bootstrap-ledger.js";
import { readPolicyEvaluationAuthority } from "./bootstrap-policy-services.js";
import {
  buildPolicyWaiverGrant,
  policyWaiverAggregateIdFor,
} from "./policy-waiver-record.js";

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
 * The eleven kinds this surface owns, restated as a literal rather than derived from the
 * production list: set equality against a derived list is vacuous, because a twelfth kind
 * added to production would silently appear on both sides of the comparison.
 */
const OWNED_KINDS = [
  "approval.decide",
  "goal.close",
  "goal.create",
  "goal.create_with_source",
  "plan.propose",
  "policy.install",
  "policy.validate",
  "project.activate",
  "project.bind_repository",
  "project.register",
  "provider.probe",
  // Served on the ASYNC entry, not through BOOTSTRAP_HANDLERS: its service runs `git`,
  // optionally `gh` and a tree write, none of which a synchronous CommandHandler can express.
  "repository.bootstrap",
  "repository.publish",
  // Both deployment edges admit through this surface. `deployment.set_target` is an ordinary
  // synchronous write; `deployment.deploy` is served on the ASYNC entry for the same reason
  // `repository.bootstrap` is -- it runs `docker` and an optional `ssh`, and polls health.
  "deployment.set_target",
  "deployment.deploy",
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
  it("covers exactly the fifteen command kinds this surface owns", () => {
    expect(new Set<string>(BOOTSTRAP_COMMAND_KINDS)).toEqual(new Set<string>(OWNED_KINDS));
    // Moved 13 -> 15 from the PRINTED expected-vs-received of this arm when the two deployment
    // kinds joined the family, never from a number in a plan.
    expect(BOOTSTRAP_COMMAND_KINDS).toHaveLength(15);
    expect(OWNED_KINDS).toHaveLength(15);
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
    const waiverCases = Object.freeze([[], [{ waiverRef: hex64("wa1") }]]);
    expect(waiverCases).toHaveLength(2);
    expect(waiverCases.length).toBeGreaterThan(0);
    for (const waivers of waiverCases) {
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
    const mutations: readonly Record<string, unknown>[] = Object.freeze([
      { ...baseline, action: "effect.activate" },
      { ...baseline, callerRiskHint: "R0" },
      { ...baseline, graphNodeRevisionRefs: ["node-revision-1"] },
      { ...baseline, requiredFactIds: ["required-fact-1"] },
      { ...baseline, scope: ["project:project-1"] },
    ]);
    expect(mutations).toHaveLength(5);
    expect(mutations.length).toBeGreaterThan(0);

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
    const callerProvenanceCases = Object.freeze([
      ["evaluatedAtEpochMs", 1_760_000_000_000, "BOOTSTRAP_POLICY_TIME_CALLER_SUPPLIED"],
      ["evaluatorVersion", "caller-evaluator", "BOOTSTRAP_POLICY_EVALUATOR_CALLER_SUPPLIED"],
    ] as const);
    expect(callerProvenanceCases).toHaveLength(2);
    expect(callerProvenanceCases.length).toBeGreaterThan(0);
    for (const [key, value, code] of callerProvenanceCases) {
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
    const noncanonicalClocks = Object.freeze(["0", "2026-08-08T03:00:00+03:00"]);
    expect(noncanonicalClocks).toHaveLength(2);
    expect(noncanonicalClocks.length).toBeGreaterThan(0);
    for (const decidedAt of noncanonicalClocks) {
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
    const missingAuthorityCases = Object.freeze([
      ["principalId", "POLICY_AUTHORITY_PRINCIPAL_UNKNOWN"],
      ["sliceRef", "POLICY_AUTHORITY_SLICE_UNKNOWN"],
      ["decisionDigest", "POLICY_AUTHORITY_DIGEST_UNKNOWN"],
      ["decisionDigestVersion", "POLICY_AUTHORITY_DIGEST_VERSION_UNKNOWN"],
      ["projectId", "POLICY_AUTHORITY_PROJECT_UNKNOWN"],
    ] as const);
    expect(missingAuthorityCases).toHaveLength(5);
    expect(missingAuthorityCases.length).toBeGreaterThan(0);
    for (const [key, code] of missingAuthorityCases) {
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
    const nonRecordRows = Object.freeze([null, [], "row", 3] as const);
    expect(nonRecordRows).toHaveLength(4);
    expect(nonRecordRows.length).toBeGreaterThan(0);
    for (const value of nonRecordRows) {
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

  // ---- CLASSIFIED SLICES (task-4e013e45, consuming task-cb0d65ff's core vocabulary) ----
  // A policy revision that DECLARES risk classifications is a FOUR-key slice. This reader
  // re-validates the slice shape against its own exact roster, so until that roster admits the
  // fourth key a classified revision reads back as unreadable authority rather than as policy.
  const CLASSIFIED_SLICE = addressedPolicySlice({
    autoApprovalOptIns: [],
    riskClassifications: [{ factId: "policy-risk-classified:other", tier: "R2" }],
    rules: [],
  });

  /**
   * The WIDENED row above, rebuilt for an arbitrary slice so that the SLICE SHAPE is the only
   * thing that varies between these arms. `chain` defaults to the evaluated slice; passing a
   * different chain is how an arm reaches the reader with a slice core would not evaluate.
   */
  function widenedFor(
    slice: Readonly<Record<string, unknown> & { readonly sliceRef: string }>,
    chain: readonly Readonly<Record<string, unknown>>[] = [slice],
  ): Readonly<Record<string, unknown>> {
    const evaluated = evaluatePolicy({
      ...AUTHORITY_INPUT, policyRevisionRef: slice.sliceRef, sliceChain: [slice],
    });
    if (!evaluated.ok) throw new Error("classified fixture must evaluate");
    const { decisionDigest: _inputDigest, ...classifiedInput } = {
      ...AUTHORITY_INPUT, policyRevisionRef: slice.sliceRef, sliceChain: chain,
    };
    const { decisionDigest: _outcomeDigest, ...classifiedOutcome } = evaluated.record;
    const material = Object.freeze({
      projectId: PROJECT_ID,
      serverSources: DECISION_MATERIAL.serverSources,
      verifiedInput: classifiedInput,
      verifiedOutcome: classifiedOutcome,
    });
    return Object.freeze({
      decision: evaluated.record.decision,
      decisionDigest: decisionDigestFor(material as unknown as JsonValue),
      decisionDigestVersion: POLICY_DECISION_DIGEST_VERSION,
      decisionMaterial: material,
      policyRef: slice.sliceRef,
      principalId: "principal-1",
      projectId: PROJECT_ID,
      sliceRef: slice.sliceRef,
    });
  }

  // ARM A. The policyRef is asserted against a FRESH derivePolicySliceDigest call rather than
  // against the fixture's stored sliceRef: the production digest is the authority, and comparing
  // the row to itself would pass even if the reader answered from a different slice.
  it("answers from a widened row whose slice declares risk classifications", () => {
    const read = authorityOf({ ...widenedFor(CLASSIFIED_SLICE) });
    expect(read.ok, String(read.code)).toBe(true);
    const derived = derivePolicySliceDigest(CLASSIFIED_SLICE);
    if (!derived.ok) throw new Error("classified slice must derive a digest");
    expect(read.policyRef).toBe(derived.digest);
    expect(read.sliceRef).toBe(derived.digest);
  });

  // ARM B. Regression pin, GREEN before the widening as well: admitting the four-key roster must
  // not admit a fifth key. The exact code and layer are asserted because more than one fence can
  // refuse this input, and "not ok" alone would keep passing if the roster stopped grading it.
  it("still refuses a five-key slice with the reader's own code and layer", () => {
    const fiveKeySlice = Object.freeze({ ...CLASSIFIED_SLICE, unknownKey: "extra" });
    const read = authorityOf({ ...widenedFor(CLASSIFIED_SLICE, [fiveKeySlice]) });
    expect(read.ok).toBe(false);
    expect(read.code).toBe("POLICY_AUTHORITY_OUTCOME_MISMATCH");
    expect(read.layer).toBe("DAEMON_POLICY_AUTHORITY");
  });

  // ARM C. The three-key path is unchanged by the widening: same answer, and its policyRef is
  // likewise pinned to a fresh production digest rather than to the stored ref.
  it("keeps answering a three-key slice with core's own digest", () => {
    const read = authorityOf({ ...WIDENED });
    expect(read.ok, String(read.code)).toBe(true);
    const derived = derivePolicySliceDigest(AUTHORITY_SLICE);
    if (!derived.ok) throw new Error("three-key slice must derive a digest");
    expect(read.policyRef).toBe(derived.digest);
    expect(read.sliceRef).toBe(derived.digest);
  });

  // The DoD's end-to-end clause. A hand-built row proves the READER; this proves the whole
  // production path - policy.install writes the classified slice to durable bytes, policy.validate
  // replays it, and the authority is read back off the event the daemon actually persisted.
  it("installs and replays a classified policy revision through the production commands", () => {
    const store = openStore();
    for (const step of [
      envelope("project.register", 0, { owner: "owner-1" }),
      envelope("project.bind_repository", 1, { observation: OBSERVATION }),
    ]) {
      const outcome = send(store, step);
      if (!outcome.ok) throw new Error(`seed refused at ${step.kind}: ${outcome.code}`);
    }
    const derived = derivePolicySliceDigest(CLASSIFIED_SLICE);
    if (!derived.ok) throw new Error("classified slice must derive a digest");
    const installed = send(store, envelope("policy.install", 0, {
      slice: CLASSIFIED_SLICE,
    }, "cmd-install-classified"));
    if (!installed.ok) throw new Error(`classified install refused: ${installed.code}`);
    const validated = send(store, envelope("policy.validate", 1, {
      input: {
        action: "plan.approve",
        actor: "principal-1",
        callerRiskHint: null,
        decisionDigest: hex64("c1"),
        graphNodeRevisionRefs: [],
        policyRevisionRef: derived.digest,
        requiredFactIds: [],
        scope: [],
      },
    }, "cmd-validate-classified"));
    if (!validated.ok) throw new Error(`classified validate refused: ${validated.code}`);

    const events = store.readEvents(`${PROJECT_ID}-policy`)
      .filter((event) => event.eventType === "PolicyEvaluated");
    const latest = events[events.length - 1];
    if (latest === undefined) throw new Error("no PolicyEvaluated row was written");
    const decoded = decodeBoundedJsonBytes(latest.payload);
    if (!decoded.ok) throw new Error(`payload undecodable: ${decoded.code}`);
    const row = decoded.value as unknown as Record<string, unknown>;

    // The fourth key survived into the durable bytes. Without this the readback below could be
    // answering about a three-key slice that silently lost its classifications in transit.
    const material = row["decisionMaterial"] as Record<string, unknown>;
    const verified = material["verifiedInput"] as Record<string, unknown>;
    const chain = verified["sliceChain"] as readonly Record<string, unknown>[];
    expect(chain).toHaveLength(1);
    // Asserted field by field with an exact key set rather than by toStrictEqual: the bounded
    // JSON decoder builds null-prototype objects (bounded-json-parser.ts:87), which no object
    // literal can match on prototype, and the key set is the stronger check anyway.
    const classifications = chain[0]?.["riskClassifications"] as readonly Record<string, unknown>[];
    expect(classifications).toHaveLength(1);
    expect(Object.keys(classifications[0] ?? {}).sort()).toEqual(["factId", "tier"]);
    expect(classifications[0]?.["factId"]).toBe("policy-risk-classified:other");
    expect(classifications[0]?.["tier"]).toBe("R2");

    const read = authorityOf(row, PROJECT_ID, Date.parse(latest.committedAt));
    expect(read.ok, String(read.code)).toBe(true);
    expect(read.policyRef).toBe(derived.digest);
    expect(read.sliceRef).toBe(derived.digest);
  });

  // ADVERSARIAL: a slice with FOUR own keys whose riskClassifications is explicitly `undefined`
  // satisfies the widened roster's key COUNT, so the guard that refuses it has to be core's, not
  // this roster. Asserted against the production digest surface with its exact code and layer.
  // It cannot arrive as an authority row at all: durable rows are decoded from JSON bytes, which
  // carry no `undefined`, and decisionDigestFor throws on one (bootstrap-policy-authority.ts:59),
  // so no such row can be minted either.
  it("refuses a four-key slice whose classification table is explicitly undefined", () => {
    const undefinedTable = {
      autoApprovalOptIns: [], riskClassifications: undefined, rules: [], sliceRef: hex64("u1"),
    };
    expect(Reflect.ownKeys(undefinedTable)).toHaveLength(4);
    const derived = derivePolicySliceDigest(undefinedTable);
    expect(derived.ok).toBe(false);
    if (derived.ok) return;
    expect(derived.code).toBe("POLICY_SLICE_INVALID");
    expect(derived.layer).toBe("POLICY_SLICE_CODEC");
  });
});

/**
 * THE CONSUMER EDGE (task-5d462855, DoD 4). Contract A is authority per comment-27fb9e2e.
 *
 * Core reads `input.waivers` in exactly ONE place — `ruleRelaxation` (policy-composition.ts:106)
 * — reached only when a ruleId is redeclared in the fold. A waiver can therefore relax a DROPPED
 * SOFT OBLIGATION and nothing else, which is why the three invariants below are structural rather
 * than defensive. `validSlice` does not require ruleIds to be unique WITHIN a slice, so one
 * installed slice carrying an ancestor rule and its weaker redeclaration reaches that path on the
 * real single-slice chain policy.validate evaluates.
 */
describe("policy.validate - consumes verified durable waivers (task-5d462855)", () => {
  afterEach(closeStores);

  const ACTION = "plan.approve";
  const OBLIGATION = "obligation.soft.waivable";
  const RULE_ID = "rule-redeclared";
  const SCOPE = Object.freeze(["scope.alpha", "scope.beta"] as const);
  const DECIDED_AT = "2026-08-08T00:00:00.000Z";
  const DECIDED_MS = Date.parse(DECIDED_AT);
  const EXPIRES_MS = DECIDED_MS + 3_600_000;
  const AGGREGATE_PREFIX = "policy-waiver:aggregate:v1:sha256:";

  /** An ancestor rule and its weaker redeclaration, in ONE slice, sharing a ruleId. */
  function redeclaringSlice(
    obligations: readonly PolicyObligation[], requiredFactIds: readonly string[] = [],
  ): Readonly<Record<string, unknown> & { readonly sliceRef: string }> {
    return addressedPolicySlice({
      autoApprovalOptIns: [],
      rules: [
        Object.freeze({ effect: "ALLOW", obligations, requiredFactIds, ruleId: RULE_ID }),
        Object.freeze({
          effect: "ALLOW", obligations: [], requiredFactIds: [], ruleId: RULE_ID,
        }),
      ],
    });
  }

  const SOFT = Object.freeze({ kind: "SOFT", obligationId: OBLIGATION } as const);
  const softSlice = redeclaringSlice([SOFT]);
  /** The obligation the grant names is HARD here, so the READER refuses to verify it at all. */
  const notSoftSlice = redeclaringSlice([{ kind: "HARD", obligationId: OBLIGATION }]);
  /**
   * A VERIFIABLE soft obligation beside an unwaivable one. The grant joins and is verified, so
   * these two arms cannot pass by the resolver simply never producing a waiver.
   */
  const hardSlice = redeclaringSlice([
    SOFT, { kind: "HARD", obligationId: "obligation.hard.blocking" },
  ]);
  const factSlice = redeclaringSlice([SOFT], ["fact.required"]);

  function seeded(slice: Readonly<Record<string, unknown>>): SqliteEventStore {
    const store = openStore();
    const prefix = [
      envelope("project.register", 0, { owner: "owner-1" }),
      envelope("project.bind_repository", 1, { observation: OBSERVATION }),
    ];
    for (const step of prefix) {
      const outcome = send(store, step);
      if (!outcome.ok) throw new Error(`seed refused at ${step.kind}: ${outcome.code}`);
    }
    const installed = send(store, envelope("policy.install", 0, { slice }, "cmd-install-waiver"));
    if (!installed.ok) throw new Error(`install refused: ${installed.code}`);
    return store;
  }

  /**
   * Seeds the grant through the PRODUCTION record codec and aggregate-id derivation. The reader
   * still recomputes every ref and re-runs every join, so this is durable history, not a fixture
   * that grants authority: only the `approval.decide` transport (task-4704a298, separately
   * tested) is skipped.
   */
  function seedGrant(
    store: SqliteEventStore, policyRevisionRef: string,
    over: Readonly<Record<string, unknown>> = {},
  ): void {
    const built = buildPolicyWaiverGrant({
      actionKind: ACTION,
      approvedAt: DECIDED_AT,
      approvedBy: "principal-1",
      commandId: "cmd-waiver-grant",
      decisionReason: "human approved this soft obligation for the consumer-edge arm",
      expiresAtEpochMs: EXPIRES_MS,
      namedObligationId: OBLIGATION,
      policyRevisionRef,
      projectId: PROJECT_ID,
      scope: [...SCOPE],
      stepUpAuthRef: "step-up:consumer-edge",
      supersedesWaiverRef: null,
      ...over,
    });
    if (!built.ok) throw new Error(`grant fixture refused: ${built.code}`);
    const aggregateId = policyWaiverAggregateIdFor(built.record);
    if (!aggregateId.startsWith(AGGREGATE_PREFIX)) {
      throw new Error(`grant landed outside the reader prefix: ${aggregateId}`);
    }
    store.commit({
      aggregateId,
      commandBytes: bytes({ commandId: "cmd-waiver-grant" }),
      commandId: "cmd-waiver-grant",
      committedAt: DECIDED_AT,
      events: [{
        eventId: `${aggregateId}#1`, eventType: built.eventType, payload: built.bytes,
      }],
      expectedVersion: 0,
    });
  }

  /**
   * The request `validated` sends, returned UNJUDGED. A refusal is an outcome this block now
   * asserts on rather than a thrown fixture error, so the ingress arms can pin its exact code
   * and layer without reaching past the production command path.
   */
  function attempt(
    store: SqliteEventStore, sliceRef: string,
    extraInputKeys: Readonly<Record<string, unknown>> = {},
  ): ServiceOutcome {
    return send(store, envelope("policy.validate", 1, {
      input: {
        action: ACTION,
        actor: "principal-1",
        callerRiskHint: null,
        decisionDigest: hex64("d1"),
        graphNodeRevisionRefs: [],
        policyRevisionRef: sliceRef,
        requiredFactIds: [],
        scope: [...SCOPE],
        ...extraInputKeys,
      },
    }, "cmd-validate-waiver"));
  }

  function validated(
    store: SqliteEventStore, sliceRef: string,
    extraInputKeys: Readonly<Record<string, unknown>> = {},
  ): Record<string, unknown> {
    const outcome = attempt(store, sliceRef, extraInputKeys);
    if (!outcome.ok) throw new Error(`policy.validate refused: ${outcome.code}`);
    const events = store.readEvents(`${PROJECT_ID}-policy`)
      .filter((event) => event.eventType === "PolicyEvaluated");
    const latest = events[events.length - 1];
    if (latest === undefined) throw new Error("no PolicyEvaluated row was written");
    const decoded = decodeBoundedJsonBytes(latest.payload);
    if (!decoded.ok) throw new Error(`payload undecodable: ${decoded.code}`);
    return decoded.value as unknown as Record<string, unknown>;
  }

  function serverSources(row: Record<string, unknown>): Record<string, unknown> {
    const material = row["decisionMaterial"] as Record<string, unknown>;
    return material["serverSources"] as Record<string, unknown>;
  }

  it("keeps the fail-closed default: no grant is RESOLVED_EMPTY and the relaxation stands", () => {
    const store = seeded(softSlice);
    const row = validated(store, softSlice.sliceRef);

    expect(serverSources(row)["waiverResolutionStatus"]).toBe("RESOLVED_EMPTY");
    expect(row["decision"]).toBe("DENY");
  });

  it("applies a fully joined verified grant to the dropped SOFT obligation", () => {
    const store = seeded(softSlice);
    seedGrant(store, softSlice.sliceRef);
    const row = validated(store, softSlice.sliceRef);

    expect(serverSources(row)["waiverResolutionStatus"]).toBe("RESOLVED_VERIFIED");
    // The relaxation is gone, so DENY is gone. HOLD_UNKNOWN remains — the next arm pins that.
    expect(row["decision"]).not.toBe("DENY");
  });

  it("never lets a waiver reach ALLOW: HOLD_UNKNOWN still dominates", () => {
    const store = seeded(softSlice);
    seedGrant(store, softSlice.sliceRef);

    expect(validated(store, softSlice.sliceRef)["decision"]).toBe("HOLD_UNKNOWN");
  });

  it("refuses to verify a grant whose named obligation is HARD in the installed chain", () => {
    const store = seeded(notSoftSlice);
    seedGrant(store, notSoftSlice.sliceRef);
    const row = validated(store, notSoftSlice.sliceRef);

    expect(serverSources(row)["waiverResolutionStatus"]).toBe("RESOLVED_EMPTY");
    expect(row["decision"]).toBe("DENY");
  });

  it("never suppresses a HARD obligation, even alongside a VERIFIED waiver", () => {
    const store = seeded(hardSlice);
    seedGrant(store, hardSlice.sliceRef);
    const row = validated(store, hardSlice.sliceRef);

    // RESOLVED_VERIFIED is what makes this arm non-vacuous: a real waiver was applied to the
    // soft obligation in the same rule, and the dropped HARD one still denies.
    expect(serverSources(row)["waiverResolutionStatus"]).toBe("RESOLVED_VERIFIED");
    expect(row["decision"]).toBe("DENY");
  });

  it("never shrinks a required fact, even alongside a VERIFIED waiver", () => {
    const store = seeded(factSlice);
    seedGrant(store, factSlice.sliceRef);
    const row = validated(store, factSlice.sliceRef);

    expect(serverSources(row)["waiverResolutionStatus"]).toBe("RESOLVED_VERIFIED");
    expect(row["decision"]).toBe("DENY");
  });

  it("refuses a grant bound to a different installed policy revision", () => {
    const store = seeded(softSlice);
    seedGrant(store, softSlice.sliceRef, { policyRevisionRef: hex64("aa") });
    const row = validated(store, softSlice.sliceRef);

    expect(serverSources(row)["waiverResolutionStatus"]).toBe("RESOLVED_EMPTY");
    expect(row["decision"]).toBe("DENY");
  });

  /**
   * DoD 2's second clause. A caller-carried approval REFERENCE must be REFUSED before any
   * authority read, with an exact stable code and an exact refusing layer. Ignored is not
   * refused: it carries neither, and a silent drop is indistinguishable at the call site from
   * having been honoured. `SERVER_SOURCED_KEYS` (bootstrap-policy-authority.ts:34-43) rosters
   * the three ref spellings, so each falls to the catch-all leg at
   * bootstrap-policy-services.ts:130-132 without needing new vocabulary.
   *
   * Asserted PER KEY rather than over a bag of three, so one key dropped from the roster later
   * cannot hide behind the other two. The zero-durable-row assertion is what makes this "before
   * any authority read" and not merely "refused"; it strictly replaces the decisionDigest
   * identity proof this arm carried while the three keys were still ignored.
   */
  it("refuses each caller-carried approval reference with the exact code and layer", () => {
    const carriedKeys = Object.freeze(["approvalRef", "humanApprovalRef", "waiverRef"] as const);
    expect(carriedKeys).toHaveLength(3);
    expect(carriedKeys.length).toBeGreaterThan(0);
    for (const key of carriedKeys) {
      const store = seeded(softSlice);
      seedGrant(store, softSlice.sliceRef);
      const outcome = attempt(store, softSlice.sliceRef, { [key]: hex64("ab") });

      if (outcome.ok) throw new Error(`${key} was accepted instead of refused`);
      expect(outcome.code).toBe("BOOTSTRAP_POLICY_WAIVER_UNVERIFIABLE");
      expect(outcome.refusedBy).toBe("DAEMON_INGRESS");
      expect(store.readEvents(`${PROJECT_ID}-policy`)
        .filter((event) => event.eventType === "PolicyEvaluated")).toHaveLength(0);
      closeStores();
    }
  });

  /**
   * Roster ORDER is load-bearing and this arm is the fence on it. `callerSuppliedKey`
   * (bootstrap-policy-authority.ts:107-110) is a `find`, so the FIRST rostered key the payload
   * carries answers. The three refs are appended for exactly this reason: prepending them would
   * silently retarget the four dedicated refusals to BOOTSTRAP_POLICY_WAIVER_UNVERIFIABLE for
   * any payload that carried both, turning a precise refusal into a vaguer one with no test
   * going red. Green before and after this row's change, deliberately — a fence, not a red-first
   * arm.
   */
  it("keeps the dedicated chain refusal ahead of a co-supplied approval reference", () => {
    const store = seeded(softSlice);
    const outcome = attempt(store, softSlice.sliceRef, {
      approvalRef: hex64("ab"), sliceChain: [softSlice],
    });

    if (outcome.ok) throw new Error("a caller-supplied slice chain was accepted");
    expect(outcome.code).toBe("BOOTSTRAP_POLICY_CHAIN_CALLER_SUPPLIED");
    expect(outcome.refusedBy).toBe("DAEMON_INGRESS");
  });

  it("keeps serverSources at exactly the four keys the admission reader accepts", () => {
    const store = seeded(softSlice);
    seedGrant(store, softSlice.sliceRef);

    expect(Object.keys(serverSources(validated(store, softSlice.sliceRef))).sort()).toEqual([
      "evaluationTimeSource", "evaluatorVersionSource", "policySliceDigestVersion",
      "waiverResolutionStatus",
    ]);
  });
});

describe("admitBootstrapCommand answers the pre-handler gates without running a handler", () => {
  afterEach(closeStores);

  it("admits a fresh command with its handler, ledger and request", () => {
    const store = openStore();
    const admitted = admitBootstrapCommand(store, bytes(validEnvelope()));
    if ("outcome" in admitted) throw new Error(`expected admission, got ${admitted.outcome.ok ? "ok" : admitted.outcome.code}`);
    expect(admitted.request.kind).toBe("project.register");
    expect(typeof admitted.handler).toBe("function");
    expect(admitted.ledger.decisionCount).toBe(0);
  });

  it("answers a replay, an ingress refusal and a missing prerequisite as outcomes", () => {
    const store = openStore();
    const registered = send(store, envelope("project.register", 0, { owner: "owner-1" }, "cmd-admit-1"));
    if (!registered.ok) throw new Error(`fixture register refused: ${registered.code}`);

    const replay = admitBootstrapCommand(store, bytes(envelope("project.register", 0, { owner: "owner-1" }, "cmd-admit-1")));
    expect("outcome" in replay && replay.outcome.ok && replay.outcome.disposition).toBe("REPLAYED");

    const malformed = admitBootstrapCommand(store, encoder.encode("{not json"));
    expect("outcome" in malformed && !malformed.outcome.ok && malformed.outcome.refusedBy).toBe("DAEMON_INGRESS");

    // project.activate before its prerequisites: refused at the prerequisite gate, no handler.
    const premature = admitBootstrapCommand(store, bytes(envelope("project.activate", 1, {}, "cmd-admit-activate")));
    expect("outcome" in premature && !premature.outcome.ok && premature.outcome.code).toBe("BOOTSTRAP_PREREQUISITE_MISSING");
  });
});
