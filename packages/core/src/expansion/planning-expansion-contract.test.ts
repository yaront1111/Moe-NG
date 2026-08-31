/**
 * Public contract pins for the PlanningRun EXPANSION binding. Everything under test is imported
 * through the package root, because `packages/core/package.json` pins an exclusive
 * `"exports": { ".": "./src/index.ts" }` map: a deep relative import would prove a shape no
 * consumer can actually reach.
 */
import { describe, expect, it } from "vitest";

import {
  PLANNING_EXPANSION_ERROR_CODES,
  PLANNING_EXPANSION_LAYERS,
  PLANNING_EXPANSION_TARGETS,
  inspectPlanningExpansionContract,
  reducePlanningRun,
  snapshotPlanningRunContractState,
  type PlanProposeCommand,
  type PlanningCreateDraftCommand,
  type PlanningExpansionHoldBinding,
  type PlanningExpansionProposalIdentity,
  type PlanningRunContractState,
  type PlanningRunCreated,
  type PlanningRunState,
  type PlanningSubmissionSealed,
} from "../index.js";

/** True only when the two key sets are mutually assignable, so a missing OR extra key fails. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type KeysOf<T> = keyof T & string;

const HOLD_BINDING_KEYS = [
  "generation", "goalVersion", "graphEpoch", "holdId", "lifecycle", "parentNodeRef",
  "parentRunRef", "proposalBaseHash", "sourceFingerprint", "truthClass", "workerHandoff",
] as const;
const PROPOSAL_IDENTITY_KEYS = ["proposalHash", "proposalRef", "truthClass"] as const;

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

export const HOLD_BINDING: PlanningExpansionHoldBinding = {
  generation: 3,
  goalVersion: 5,
  graphEpoch: 7,
  holdId: "hold:expansion:1",
  lifecycle: "ACTIVE",
  parentNodeRef: "node:parent",
  parentRunRef: "run:parent",
  proposalBaseHash: HASH_A,
  sourceFingerprint: HASH_B,
  truthClass: "DAEMON_VERIFIED",
  workerHandoff: { digest: HASH_C, ref: "handoff:worker:1" },
};

export const PROPOSAL_IDENTITY: PlanningExpansionProposalIdentity = {
  proposalHash: HASH_A,
  proposalRef: "submission:1",
  truthClass: "DAEMON_VERIFIED",
};

describe("expansion contract key sets", () => {
  it("pins PlanningExpansionHoldBinding to exactly its eleven keys", () => {
    const exact: Exact<KeysOf<PlanningExpansionHoldBinding>,
      (typeof HOLD_BINDING_KEYS)[number]> = true;
    expect(exact).toBe(true);
    expect(Object.keys(HOLD_BINDING).sort()).toStrictEqual([...HOLD_BINDING_KEYS].sort());
    expect(HOLD_BINDING_KEYS.length).toBe(11);
  });

  it("pins PlanningExpansionProposalIdentity to exactly its three keys", () => {
    const exact: Exact<KeysOf<PlanningExpansionProposalIdentity>,
      (typeof PROPOSAL_IDENTITY_KEYS)[number]> = true;
    expect(exact).toBe(true);
    expect(Object.keys(PROPOSAL_IDENTITY).sort())
      .toStrictEqual([...PROPOSAL_IDENTITY_KEYS].sort());
  });

  it("pins the two literal evidence fields rather than widening them", () => {
    const lifecycle: Exact<PlanningExpansionHoldBinding["lifecycle"], "ACTIVE"> = true;
    const holdTruth: Exact<PlanningExpansionHoldBinding["truthClass"], "DAEMON_VERIFIED"> = true;
    const proposalTruth:
      Exact<PlanningExpansionProposalIdentity["truthClass"], "DAEMON_VERIFIED"> = true;
    expect([lifecycle, holdTruth, proposalTruth]).toStrictEqual([true, true, true]);
  });

  it("reuses the landed ExpansionHandoffBinding rather than restating its shape", () => {
    const handoff: Exact<KeysOf<PlanningExpansionHoldBinding["workerHandoff"]>,
      "digest" | "ref"> = true;
    expect(handoff).toBe(true);
  });
});

describe("cross-kind command legality", () => {
  it("requires the expansion binding on an EXPANSION draft and forbids it elsewhere", () => {
    const expansionDraft: PlanningCreateDraftCommand = {
      commandId: "cmd-create", expansion: HOLD_BINDING, expectedVersion: 0, goalRef: "goal-1",
      kind: "planning.create_draft", runId: "planning-run-1", runKind: "EXPANSION",
    };
    const initialDraft: PlanningCreateDraftCommand = {
      commandId: "cmd-create", expectedVersion: 0, goalRef: "goal-1",
      kind: "planning.create_draft", runId: "planning-run-1", runKind: "INITIAL",
    };
    // @ts-expect-error EXPANSION without the binding must not be representable
    const missing: PlanningCreateDraftCommand = {
      commandId: "cmd-create", expectedVersion: 0, goalRef: "goal-1",
      kind: "planning.create_draft", runId: "planning-run-1", runKind: "EXPANSION",
    };
    const leaked: PlanningCreateDraftCommand = {
      commandId: "cmd-create",
      // @ts-expect-error the binding must not be legal on an INITIAL draft
      expansion: HOLD_BINDING, expectedVersion: 0, goalRef: "goal-1",
      kind: "planning.create_draft", runId: "planning-run-1", runKind: "INITIAL",
    };
    expect([expansionDraft.runKind, initialDraft.runKind]).toStrictEqual(["EXPANSION", "INITIAL"]);
    expect([missing, leaked].length).toBe(2);
  });

  it("requires binding and sealed proposal together on an EXPANSION proposal", () => {
    const expansionPropose: PlanProposeCommand = {
      commandId: "cmd-propose", expansion: HOLD_BINDING, expectedVersion: 7, kind: "plan.propose",
      proposalKind: "EXPANSION", sealedProposal: PROPOSAL_IDENTITY, submissionHash: HASH_A,
      witness: { attemptRef: "attempt-1", submissionRef: "submission:1",
        truthClass: "DAEMON_VERIFIED" },
    };
    // @ts-expect-error an EXPANSION proposal may not omit the sealed proposal identity
    const unsealed: PlanProposeCommand = {
      commandId: "cmd-propose", expansion: HOLD_BINDING, expectedVersion: 7, kind: "plan.propose",
      proposalKind: "EXPANSION", submissionHash: HASH_A,
      witness: { attemptRef: "attempt-1", submissionRef: "submission:1",
        truthClass: "DAEMON_VERIFIED" },
    };
    const leaked: PlanProposeCommand = {
      commandId: "cmd-propose", expectedVersion: 7, kind: "plan.propose",
      proposalKind: "INITIAL",
      // @ts-expect-error sealed proposal identity is not legal on an INITIAL proposal
      sealedProposal: PROPOSAL_IDENTITY, submissionHash: HASH_A,
      witness: { attemptRef: "attempt-1", submissionRef: "submission:1",
        truthClass: "DAEMON_VERIFIED" },
    };
    expect(expansionPropose.proposalKind).toBe("EXPANSION");
    expect([unsealed, leaked].length).toBe(2);
  });

  it("refuses expansion field writes at the type level, nested fields included", () => {
    const binding: PlanningExpansionHoldBinding = {
      ...HOLD_BINDING, workerHandoff: { ...HOLD_BINDING.workerHandoff },
    };
    // @ts-expect-error the binding is readonly
    binding.generation = 4;
    // @ts-expect-error the nested handoff is readonly
    binding.workerHandoff.ref = "handoff:other";
    // The two directives ARE the assertion. `readonly` is erased at runtime and freezes nothing,
    // so both writes land; asserting they did not would pin a guarantee this type never made.
    // Runtime immutability is a separate property, proven against the frozen production snapshot.
    expect([binding.generation, binding.workerHandoff.ref])
      .toStrictEqual([4, "handoff:other"]);
  });
});

describe("cross-kind event and state legality", () => {
  it("carries the binding on an EXPANSION created event only", () => {
    const created: PlanningRunCreated = {
      commandId: "cmd-create", expansion: HOLD_BINDING, goalRef: "goal-1",
      kind: "PlanningRunCreated", runId: "planning-run-1", runKind: "EXPANSION", version: 1,
    };
    // @ts-expect-error an EXPANSION created event may not omit the binding
    const bare: PlanningRunCreated = {
      commandId: "cmd-create", goalRef: "goal-1", kind: "PlanningRunCreated",
      runId: "planning-run-1", runKind: "EXPANSION", version: 1,
    };
    expect(created.runKind).toBe("EXPANSION");
    expect(bare.version).toBe(1);
  });

  it("carries binding, proposal kind and sealed identity on an EXPANSION sealed event", () => {
    const sealed: PlanningSubmissionSealed = {
      commandId: "cmd-propose", draining: false, expansion: HOLD_BINDING,
      kind: "PlanningSubmissionSealed", proposalKind: "EXPANSION",
      sealedProposal: PROPOSAL_IDENTITY, submissionHash: HASH_A, version: 8,
    };
    const legacy: PlanningSubmissionSealed = {
      commandId: "cmd-propose", draining: false, kind: "PlanningSubmissionSealed",
      submissionHash: HASH_A, version: 8,
    };
    expect([sealed.version, legacy.version]).toStrictEqual([8, 8]);
  });

  it("opens an EXPANSION contract state with a null sealed proposal and seals it later", () => {
    const opened: PlanningRunContractState = {
      approvedHashes: null, attemptRef: null, expansion: HOLD_BINDING,
      facets: { leaseSuspect: false, livePlannerEffect: false, owned: false, resumable: false },
      goalRef: "goal-1", graphRevisionRef: null, leaseRef: null, lifecycle: "DRAFT",
      runId: "planning-run-1", runKind: "EXPANSION", sealedHashes: null, sealedProposal: null,
      submissionHash: null, version: 1,
    };
    const submitted: PlanningRunContractState = { ...opened, sealedProposal: PROPOSAL_IDENTITY };
    // @ts-expect-error an EXPANSION contract state may not omit the sealed proposal slot
    const missingSlot: PlanningRunContractState = {
      approvedHashes: null, attemptRef: null, expansion: HOLD_BINDING,
      facets: { leaseSuspect: false, livePlannerEffect: false, owned: false, resumable: false },
      goalRef: "goal-1", graphRevisionRef: null, leaseRef: null, lifecycle: "DRAFT",
      runId: "planning-run-1", runKind: "EXPANSION", sealedHashes: null, submissionHash: null,
      version: 1,
    };
    const leaked: PlanningRunContractState = {
      approvedHashes: null, attemptRef: null,
      // @ts-expect-error expansion fields are not legal on an INITIAL contract state
      expansion: HOLD_BINDING,
      facets: { leaseSuspect: false, livePlannerEffect: false, owned: false, resumable: false },
      goalRef: "goal-1", graphRevisionRef: null, leaseRef: null, lifecycle: "DRAFT",
      runId: "planning-run-1", runKind: "INITIAL", sealedHashes: null, sealedProposal: null,
      submissionHash: null, version: 1,
    };
    expect(opened.sealedProposal).toBeNull();
    expect(submitted.sealedProposal).toStrictEqual(PROPOSAL_IDENTITY);
    expect([missingSlot, leaked].length).toBe(2);
  });

  it("keeps every contract state assignable to the unchanged PlanningRunState", () => {
    const widen = (state: PlanningRunContractState): PlanningRunState => state;
    expect(widen({
      approvedHashes: null, attemptRef: null,
      facets: { leaseSuspect: false, livePlannerEffect: false, owned: false, resumable: false },
      goalRef: "goal-1", graphRevisionRef: null, leaseRef: null, lifecycle: "DRAFT",
      runId: "planning-run-1", runKind: "INITIAL", sealedHashes: null, submissionHash: null,
      version: 1,
    }).runKind).toBe("INITIAL");
  });
});

describe("preserved legacy behaviour", () => {
  const createInitial: PlanningCreateDraftCommand = {
    commandId: "cmd-planning.create_draft", expectedVersion: 0, goalRef: "goal-1",
    kind: "planning.create_draft", runId: "planning-run-1", runKind: "INITIAL",
  };

  it("keeps the INITIAL create bytes identical through reducePlanningRun", () => {
    const result = reducePlanningRun(undefined, createInitial);
    expect(JSON.parse(JSON.stringify(result))).toStrictEqual({
      events: [{
        commandId: "cmd-planning.create_draft", goalRef: "goal-1", kind: "PlanningRunCreated",
        runId: "planning-run-1", runKind: "INITIAL", version: 1,
      }],
      ok: true,
      state: {
        approvedHashes: null, attemptRef: null,
        facets: { leaseSuspect: false, livePlannerEffect: false, owned: false, resumable: false },
        goalRef: "goal-1", graphRevisionRef: null, leaseRef: null, lifecycle: "DRAFT",
        runId: "planning-run-1", runKind: "INITIAL", sealedHashes: null, submissionHash: null,
        version: 1,
      },
    });
  });

  it("admits a REVISION draft with the same authority-free initial state", () => {
    expect(JSON.parse(JSON.stringify(reducePlanningRun(
      undefined, { ...createInitial, runKind: "REVISION" },
    )))).toStrictEqual({
      events: [{
        commandId: "cmd-planning.create_draft", goalRef: "goal-1", kind: "PlanningRunCreated",
        runId: "planning-run-1", runKind: "REVISION", version: 1,
      }],
      ok: true,
      state: {
        approvedHashes: null, attemptRef: null,
        facets: { leaseSuspect: false, livePlannerEffect: false, owned: false, resumable: false },
        goalRef: "goal-1", graphRevisionRef: null, leaseRef: null, lifecycle: "DRAFT",
        runId: "planning-run-1", runKind: "REVISION", sealedHashes: null,
        submissionHash: null, version: 1,
      },
    });
  });

  /**
   * EXPANSION creation became legal in task-93b0314e09f248118e21f92699989468. The claim this
   * case was written to pin is unchanged and still asserted: the schema alone grants no
   * authority. The draft it now produces carries exactly the hold binding and an empty seal —
   * no lease, effect, slot, resource, budget, activation, dispatch, or partial proposal.
   */
  it("creates only a zero-authority EXPANSION draft, so the schema alone grants nothing", () => {
    const result = reducePlanningRun(undefined, { ...createInitial, expansion: HOLD_BINDING,
      runKind: "EXPANSION" });
    const state = result.ok ? (result.state as unknown as Record<string, unknown>) : {};
    expect(state["lifecycle"]).toBe("DRAFT");
    expect(state["runKind"]).toBe("EXPANSION");
    expect(state["sealedProposal"]).toBeNull();
    expect(state["submissionHash"]).toBeNull();
    expect(Object.keys(state).sort()).toStrictEqual(["approvedHashes", "attemptRef", "expansion",
      "facets", "goalRef", "graphRevisionRef", "leaseRef", "lifecycle", "runId", "runKind",
      "sealedHashes", "sealedProposal", "submissionHash", "version"]);
  });
});

describe("published runtime surface", () => {
  it("publishes the contract-state snapshot as a callable root export", () => {
    expect(typeof snapshotPlanningRunContractState).toBe("function");
  });
});

/* ------------------------------------------------------------------ *
 * Fail-closed matrix. Acceptance is only ever decided by the imported
 * production predicates; the helpers below build inputs and never judge them.
 * ------------------------------------------------------------------ */

const WITNESS = {
  attemptRef: "attempt-1", submissionRef: "submission:1", truthClass: "DAEMON_VERIFIED",
} as const;

const CREATE_COMMAND = {
  commandId: "cmd-create", expansion: HOLD_BINDING, expectedVersion: 0, goalRef: "goal-1",
  kind: "planning.create_draft", runId: "planning-run-1", runKind: "EXPANSION",
} as const;

const PROPOSE_COMMAND = {
  commandId: "cmd-propose", expansion: HOLD_BINDING, expectedVersion: 7, kind: "plan.propose",
  proposalKind: "EXPANSION", sealedProposal: PROPOSAL_IDENTITY, submissionHash: HASH_A,
  witness: WITNESS,
} as const;

const CREATED_EVENT = {
  commandId: "cmd-create", expansion: HOLD_BINDING, goalRef: "goal-1",
  kind: "PlanningRunCreated", runId: "planning-run-1", runKind: "EXPANSION", version: 1,
} as const;

const SEALED_EVENT = {
  commandId: "cmd-propose", draining: false, expansion: HOLD_BINDING,
  kind: "PlanningSubmissionSealed", proposalKind: "EXPANSION",
  sealedProposal: PROPOSAL_IDENTITY, submissionHash: HASH_A, version: 8,
} as const;

const IDLE_FACETS = {
  leaseSuspect: false, livePlannerEffect: false, owned: false, resumable: false,
} as const;

const CONTRACT_STATE = {
  approvedHashes: null, attemptRef: null, expansion: HOLD_BINDING, facets: IDLE_FACETS,
  goalRef: "goal-1", graphRevisionRef: null, leaseRef: null, lifecycle: "DRAFT",
  runId: "planning-run-1", runKind: "EXPANSION", sealedHashes: null, sealedProposal: null,
  submissionHash: null, version: 1,
} as const;

type Shape = Readonly<object>;
interface Case { readonly label: string; readonly value: unknown }

const REF_257 = "r".repeat(257);
const UPPER_HEX = "A".repeat(64);
const SHORT_HEX = "a".repeat(63);

const omit = (base: Shape, key: string): Readonly<Record<string, unknown>> =>
  Object.fromEntries(Object.entries(base).filter(([name]) => name !== key));
const set = (base: Shape, key: string, value: unknown): Readonly<Record<string, unknown>> =>
  ({ ...base, [key]: value });

/** Missing-key, extra-key and non-record cases, derived from the fixture's own key set. */
function structuralCases(base: Shape): readonly Case[] {
  return [
    ...Object.keys(base).map((key) => ({ label: `missing ${key}`, value: omit(base, key) })),
    { label: "extra key", value: set(base, "unexpectedField", 1) },
    { label: "not a record", value: "not-a-record" },
    { label: "null", value: null },
    { label: "array", value: [] },
  ];
}

const valueCases = (base: Shape, key: string, values: readonly unknown[]): readonly Case[] =>
  values.map((value, index) => ({ label: `${key} #${index}`, value: set(base, key, value) }));

const BAD_POSITIVE = [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "1", null] as const;
const BAD_NONNEGATIVE = [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "0"] as const;
const BAD_REFS = ["", REF_257, 1, null, {}] as const;
const BAD_HASHES = [UPPER_HEX, SHORT_HEX, "", `${HASH_A}a`, "z".repeat(64), 1] as const;
const WEAK_TRUTH = ["HUMAN_APPROVED", "AGENT_REPORTED", "UNKNOWN", "", null] as const;

function holdBindingCases(): readonly Case[] {
  return [
    ...structuralCases(HOLD_BINDING),
    ...valueCases(HOLD_BINDING, "generation", BAD_POSITIVE),
    ...valueCases(HOLD_BINDING, "goalVersion", BAD_POSITIVE),
    ...valueCases(HOLD_BINDING, "graphEpoch", BAD_NONNEGATIVE),
    ...valueCases(HOLD_BINDING, "holdId", BAD_REFS),
    ...valueCases(HOLD_BINDING, "parentNodeRef", BAD_REFS),
    ...valueCases(HOLD_BINDING, "parentRunRef", BAD_REFS),
    ...valueCases(HOLD_BINDING, "proposalBaseHash", BAD_HASHES),
    ...valueCases(HOLD_BINDING, "sourceFingerprint", BAD_HASHES),
    ...valueCases(HOLD_BINDING, "lifecycle", ["TERMINATED", "ACTIVE ", "active", "", null]),
    ...valueCases(HOLD_BINDING, "truthClass", WEAK_TRUTH),
    ...valueCases(HOLD_BINDING, "workerHandoff", [
      omit(HOLD_BINDING.workerHandoff, "ref"),
      omit(HOLD_BINDING.workerHandoff, "digest"),
      set(HOLD_BINDING.workerHandoff, "digest", UPPER_HEX),
      set(HOLD_BINDING.workerHandoff, "ref", ""),
      set(HOLD_BINDING.workerHandoff, "extra", 1),
      "handoff", null,
    ]),
  ];
}

function proposalIdentityCases(): readonly Case[] {
  return [
    ...structuralCases(PROPOSAL_IDENTITY),
    ...valueCases(PROPOSAL_IDENTITY, "proposalHash", BAD_HASHES),
    ...valueCases(PROPOSAL_IDENTITY, "proposalRef", BAD_REFS),
    ...valueCases(PROPOSAL_IDENTITY, "truthClass", WEAK_TRUTH),
  ];
}

/** A binding whose own rules are broken must sink its carrier, not be trusted structurally. */
const STALE_BINDING = set(HOLD_BINDING, "lifecycle", "TERMINATED");

function createCommandCases(): readonly Case[] {
  return [
    ...structuralCases(CREATE_COMMAND),
    ...valueCases(CREATE_COMMAND, "expectedVersion", [1, -1, 1.5, "0", null]),
    ...valueCases(CREATE_COMMAND, "commandId", BAD_REFS),
    ...valueCases(CREATE_COMMAND, "goalRef", BAD_REFS),
    ...valueCases(CREATE_COMMAND, "runId", BAD_REFS),
    ...valueCases(CREATE_COMMAND, "kind", ["plan.propose", "", null]),
    ...valueCases(CREATE_COMMAND, "expansion", [STALE_BINDING, {}, null]),
    { label: "cross-kind: INITIAL carrying a binding",
      value: set(CREATE_COMMAND, "runKind", "INITIAL") },
    { label: "cross-kind: REVISION carrying a binding",
      value: set(CREATE_COMMAND, "runKind", "REVISION") },
    { label: "cross-kind: EXPANSION omitting the binding",
      value: omit(CREATE_COMMAND, "expansion") },
  ];
}

function proposeCommandCases(): readonly Case[] {
  return [
    ...structuralCases(PROPOSE_COMMAND),
    ...valueCases(PROPOSE_COMMAND, "expectedVersion", [-1, 1.5, "7", null]),
    ...valueCases(PROPOSE_COMMAND, "submissionHash", BAD_HASHES),
    ...valueCases(PROPOSE_COMMAND, "expansion", [STALE_BINDING, {}, null]),
    ...valueCases(PROPOSE_COMMAND, "witness", [
      set(WITNESS, "truthClass", "AGENT_REPORTED"), omit(WITNESS, "submissionRef"), null,
    ]),
    { label: "cross-kind: INITIAL carrying expansion evidence",
      value: set(PROPOSE_COMMAND, "proposalKind", "INITIAL") },
    { label: "cross-kind: EXPANSION omitting the binding",
      value: omit(PROPOSE_COMMAND, "expansion") },
    { label: "cross-kind: EXPANSION omitting the sealed proposal",
      value: omit(PROPOSE_COMMAND, "sealedProposal") },
    { label: "sealed proposal hash not equal to submissionHash",
      value: set(PROPOSE_COMMAND, "sealedProposal",
        set(PROPOSAL_IDENTITY, "proposalHash", HASH_B)) },
    { label: "sealed proposal ref not equal to witness.submissionRef",
      value: set(PROPOSE_COMMAND, "sealedProposal",
        set(PROPOSAL_IDENTITY, "proposalRef", "submission:other")) },
  ];
}

function createdEventCases(): readonly Case[] {
  return [
    ...structuralCases(CREATED_EVENT),
    ...valueCases(CREATED_EVENT, "version", BAD_POSITIVE),
    ...valueCases(CREATED_EVENT, "expansion", [STALE_BINDING, {}, null]),
    { label: "cross-kind: INITIAL carrying a binding",
      value: set(CREATED_EVENT, "runKind", "INITIAL") },
    { label: "cross-kind: EXPANSION omitting the binding",
      value: omit(CREATED_EVENT, "expansion") },
  ];
}

function sealedEventCases(): readonly Case[] {
  return [
    ...structuralCases(SEALED_EVENT),
    ...valueCases(SEALED_EVENT, "version", BAD_POSITIVE),
    ...valueCases(SEALED_EVENT, "draining", ["false", 0, null]),
    ...valueCases(SEALED_EVENT, "submissionHash", BAD_HASHES),
    { label: "cross-kind: INITIAL proposal kind carrying expansion evidence",
      value: set(SEALED_EVENT, "proposalKind", "INITIAL") },
    { label: "cross-kind: EXPANSION omitting the sealed proposal",
      value: omit(SEALED_EVENT, "sealedProposal") },
    { label: "sealed proposal hash not equal to submissionHash",
      value: set(SEALED_EVENT, "sealedProposal",
        set(PROPOSAL_IDENTITY, "proposalHash", HASH_B)) },
  ];
}

const SEALED_STATE = {
  ...CONTRACT_STATE, lifecycle: "SUBMISSION_DRAINING", sealedProposal: PROPOSAL_IDENTITY,
  submissionHash: HASH_A,
} as const;

function contractStateCases(): readonly Case[] {
  return [
    ...structuralCases(CONTRACT_STATE),
    ...valueCases(CONTRACT_STATE, "version", BAD_POSITIVE),
    ...valueCases(CONTRACT_STATE, "lifecycle", ["OPEN", "draft", "", null]),
    ...valueCases(CONTRACT_STATE, "facets", [omit(IDLE_FACETS, "owned"), {}, null]),
    ...valueCases(CONTRACT_STATE, "expansion", [STALE_BINDING, {}, null]),
    { label: "cross-kind: INITIAL carrying a binding",
      value: set(CONTRACT_STATE, "runKind", "INITIAL") },
    { label: "cross-kind: EXPANSION omitting the binding",
      value: omit(CONTRACT_STATE, "expansion") },
    { label: "cross-kind: EXPANSION omitting the sealed proposal slot",
      value: omit(CONTRACT_STATE, "sealedProposal") },
    { label: "sealed proposal present before any submission",
      value: set(CONTRACT_STATE, "sealedProposal", PROPOSAL_IDENTITY) },
    { label: "submission sealed with no proposal identity",
      value: set(SEALED_STATE, "sealedProposal", null) },
    { label: "sealed proposal hash not equal to submissionHash",
      value: set(SEALED_STATE, "sealedProposal", set(PROPOSAL_IDENTITY, "proposalHash", HASH_B)) },
  ];
}

const MATRIX = [
  { accepted: [HOLD_BINDING], cases: holdBindingCases(),
    code: "PLANNING_EXPANSION_HOLD_BINDING_INVALID", layer: "BINDING",
    target: "HOLD_BINDING" },
  { accepted: [PROPOSAL_IDENTITY], cases: proposalIdentityCases(),
    code: "PLANNING_EXPANSION_PROPOSAL_IDENTITY_INVALID", layer: "IDENTITY",
    target: "PROPOSAL_IDENTITY" },
  { accepted: [CREATE_COMMAND], cases: createCommandCases(),
    code: "PLANNING_EXPANSION_CREATE_COMMAND_INVALID", layer: "COMMAND",
    target: "CREATE_COMMAND" },
  { accepted: [PROPOSE_COMMAND], cases: proposeCommandCases(),
    code: "PLANNING_EXPANSION_PROPOSE_COMMAND_INVALID", layer: "COMMAND",
    target: "PROPOSE_COMMAND" },
  { accepted: [CREATED_EVENT], cases: createdEventCases(),
    code: "PLANNING_EXPANSION_CREATED_EVENT_INVALID", layer: "EVENT",
    target: "CREATED_EVENT" },
  { accepted: [SEALED_EVENT], cases: sealedEventCases(),
    code: "PLANNING_EXPANSION_SEALED_EVENT_INVALID", layer: "EVENT",
    target: "SEALED_EVENT" },
  { accepted: [CONTRACT_STATE, SEALED_STATE], cases: contractStateCases(),
    code: "PLANNING_EXPANSION_CONTRACT_STATE_INVALID", layer: "STATE",
    target: "CONTRACT_STATE" },
] as const;

/**
 * Exact per-target counts, derived by hand from the generator arithmetic rather than transcribed
 * from a run: a count copied off an actual result can only ever agree with itself.
 */
const EXPECTED_CASE_COUNTS: Readonly<Record<string, number>> = {
  CONTRACT_STATE: 41, CREATED_EVENT: 23, CREATE_COMMAND: 40, HOLD_BINDING: 78,
  PROPOSAL_IDENTITY: 23, PROPOSE_COMMAND: 33, SEALED_EVENT: 31,
};
const EXPECTED_TOTAL_CASES = 269;

describe("expansion contract inspection matrix", () => {
  it("generates a nonzero, exactly sized, duplicate-free case list for every target", () => {
    // Asserted BEFORE anything that touches the production surface, so the sweep is proven
    // non-vacuous even in the red state where the surface does not exist yet.
    expect(MATRIX.length).toBe(7);
    expect(structuralCases(HOLD_BINDING).length).toBe(HOLD_BINDING_KEYS.length + 4);
    for (const entry of MATRIX) {
      expect(entry.cases.length).toBeGreaterThan(0);
      expect(entry.cases.length).toBe(EXPECTED_CASE_COUNTS[entry.target]);
      expect(new Set(entry.cases.map((item) => item.label)).size).toBe(entry.cases.length);
    }
    expect(MATRIX.reduce((total, entry) => total + entry.cases.length, 0))
      .toBe(EXPECTED_TOTAL_CASES);
    expect(Object.values(EXPECTED_CASE_COUNTS).reduce((total, count) => total + count, 0))
      .toBe(EXPECTED_TOTAL_CASES);
  });

  it("covers every published target exactly once", () => {
    expect([...PLANNING_EXPANSION_TARGETS].sort())
      .toStrictEqual(MATRIX.map((entry) => entry.target).sort());
  });

  it("refuses hostile binding carriers at the binding layer without observing them twice", () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const accessor = Object.defineProperty({}, "holdId", {
      enumerable: true, get: () => { throw new Error("must stay contained"); },
    });
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    const hostile = [revoked.proxy, accessor, cyclic];
    expect(hostile.length).toBe(3);
    for (const value of hostile) {
      expect(inspectPlanningExpansionContract("HOLD_BINDING", value)).toStrictEqual({
        code: "PLANNING_EXPANSION_HOLD_BINDING_INVALID", layer: "BINDING", ok: false,
        target: "HOLD_BINDING",
      });
    }
  });

  it.each(MATRIX.map((entry) => [entry.target, entry] as const))(
    "accepts the valid %s shape", (_target, entry) => {
      for (const accepted of entry.accepted) {
        const result = inspectPlanningExpansionContract(entry.target, accepted);
        expect(result).toStrictEqual({ ok: true, target: entry.target, value: accepted });
      }
    });

  it.each(MATRIX.map((entry) => [entry.target, entry] as const))(
    "refuses every invalid %s with its exact code and layer", (_target, entry) => {
      const refusals = entry.cases.map((item) => ({
        label: item.label,
        result: inspectPlanningExpansionContract(entry.target, item.value),
      }));
      const wrong = refusals.filter((item) =>
        JSON.stringify(item.result)
          !== JSON.stringify({ code: entry.code, layer: entry.layer, ok: false,
            target: entry.target }));
      // Reported by LABEL so a regression names the case rather than a count.
      expect(wrong.map((item) => item.label)).toStrictEqual([]);
    });

  it("leaves every rejected input byte-identical", () => {
    for (const entry of MATRIX) {
      for (const item of entry.cases) {
        const before = JSON.stringify(item.value);
        inspectPlanningExpansionContract(entry.target, item.value);
        expect(JSON.stringify(item.value)).toBe(before);
      }
    }
  });

  it("refuses an unknown target rather than defaulting to a positive answer", () => {
    // @ts-expect-error the target vocabulary is closed
    const result = inspectPlanningExpansionContract("NOT_A_TARGET", HOLD_BINDING);
    expect(result).toStrictEqual({
      code: "PLANNING_EXPANSION_TARGET_INVALID", layer: "TARGET", ok: false,
      target: "NOT_A_TARGET",
    });
  });

  it("refuses a hostile non-string target without coercing or observing it", () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    // @ts-expect-error the target vocabulary is a closed string union
    const result = inspectPlanningExpansionContract(revoked.proxy, HOLD_BINDING);
    expect(result).toStrictEqual({
      code: "PLANNING_EXPANSION_TARGET_INVALID", layer: "TARGET", ok: false,
      target: "<invalid-target>",
    });
  });

  it("freezes inspection results and detaches accepted evidence from its caller", () => {
    const mutable = {
      ...HOLD_BINDING, workerHandoff: { ...HOLD_BINDING.workerHandoff },
    };
    const accepted = inspectPlanningExpansionContract("HOLD_BINDING", mutable);
    const refused = inspectPlanningExpansionContract("HOLD_BINDING", {});
    expect([Object.isFrozen(accepted), Object.isFrozen(refused)]).toStrictEqual([true, true]);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error("accepted fixture was refused");
    const evidence = accepted.value as PlanningExpansionHoldBinding;
    expect([Object.isFrozen(evidence), Object.isFrozen(evidence.workerHandoff)])
      .toStrictEqual([true, true]);
    mutable.workerHandoff.ref = "handoff:mutated";
    expect(evidence.workerHandoff.ref).toBe("handoff:worker:1");
  });

  it("freezes its published vocabulary", () => {
    expect([
      Object.isFrozen(PLANNING_EXPANSION_TARGETS),
      Object.isFrozen(PLANNING_EXPANSION_ERROR_CODES),
      Object.isFrozen(PLANNING_EXPANSION_LAYERS),
    ]).toStrictEqual([true, true, true]);
    expect([...PLANNING_EXPANSION_ERROR_CODES].sort())
      .toStrictEqual([...new Set([
        ...MATRIX.map((entry) => entry.code), "PLANNING_EXPANSION_TARGET_INVALID",
      ])].sort());
    expect([...PLANNING_EXPANSION_LAYERS].sort())
      .toStrictEqual([...new Set([...MATRIX.map((entry) => entry.layer), "TARGET"])].sort());
  });
});

describe("contract-state snapshot", () => {
  it("returns a deeply frozen copy detached from the caller's object", () => {
    const mutable = {
      ...CONTRACT_STATE, expansion: { ...HOLD_BINDING, workerHandoff: { ...HOLD_BINDING.workerHandoff } },
      facets: { ...IDLE_FACETS, owned: false as boolean },
    };
    const snapshot = snapshotPlanningRunContractState(mutable);
    expect(snapshot).toStrictEqual(CONTRACT_STATE);
    expect([
      Object.isFrozen(snapshot), Object.isFrozen(snapshot?.facets),
      Object.isFrozen(snapshot?.runKind === "EXPANSION" ? snapshot.expansion : {}),
      Object.isFrozen(snapshot?.runKind === "EXPANSION" ? snapshot.expansion.workerHandoff : {}),
    ]).toStrictEqual([true, true, true, true]);
    mutable.facets.owned = true;
    mutable.expansion.workerHandoff.ref = "handoff:other";
    expect(snapshot?.facets.owned).toBe(false);
    expect(snapshot?.runKind === "EXPANSION" ? snapshot.expansion.workerHandoff.ref : null)
      .toBe("handoff:worker:1");
  });

  it("returns undefined for a state the production predicate refuses", () => {
    expect(snapshotPlanningRunContractState(omit(CONTRACT_STATE, "expansion"))).toBeUndefined();
    expect(snapshotPlanningRunContractState(set(CONTRACT_STATE, "runKind", "INITIAL")))
      .toBeUndefined();
  });

  it("accepts a legacy INITIAL state unchanged, so the projection widened nothing", () => {
    const legacy = omit(omit(CONTRACT_STATE, "expansion"), "sealedProposal");
    expect(snapshotPlanningRunContractState(set(legacy, "runKind", "INITIAL")))
      .toStrictEqual({ ...legacy, runKind: "INITIAL" });
  });
});

describe("authority containment", () => {
  const FORBIDDEN = [
    "child", "graph", "budget", "resource", "lease", "effect", "slot", "allocation",
    "activation", "dispatch",
  ] as const;

  /**
   * `graphEpoch` is a staleness counter, not a handle: it carries an integer the daemon compares
   * for currency and can address nothing. Named here rather than dropped from the sweep, so a
   * genuinely authority-shaped key like `graphRef` cannot hide behind the same substring.
   */
  const NAMED_NON_AUTHORITY = ["graphEpoch"] as const;

  it("grants no authority vocabulary through either expansion-only shape", () => {
    // Scoped to the EXPANSION-ONLY fields on purpose: the legacy PlanningRunState already
    // carries `leaseRef` and `graphRevisionRef`, and this task must not be read as retiring them.
    const introduced = [...HOLD_BINDING_KEYS, ...PROPOSAL_IDENTITY_KEYS, "expansion",
      "sealedProposal", "proposalKind"];
    const flagged = introduced.filter((key) =>
      FORBIDDEN.some((token) => key.toLowerCase().includes(token)));
    expect(flagged).toStrictEqual([...NAMED_NON_AUTHORITY]);
    expect(introduced.length).toBeGreaterThan(0);
    // Every named exception must still be earned; an unused entry would silence a future field.
    expect(NAMED_NON_AUTHORITY.filter((key) => !introduced.includes(key))).toStrictEqual([]);
  });

  it("keeps the sweep able to fail, so an empty offender list means something", () => {
    const probe = ["childRef", "graphRef", "budgetHandle", "dispatchToken"];
    expect(probe.filter((key) => FORBIDDEN.some((token) => key.toLowerCase().includes(token))))
      .toStrictEqual(probe);
  });
});
