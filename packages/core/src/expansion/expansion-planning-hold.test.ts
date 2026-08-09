import { describe, expect, it } from "vitest";

import {
  EXPANSION_HOLD_COMMAND_KINDS,
  EXPANSION_HOLD_CAUSES,
  EXPANSION_HOLD_ERROR_CODES,
  EXPANSION_HOLD_LAYERS,
  reduceExpansionPlanningHold,
  type ExpansionPlanningHoldCommand,
  type ExpansionPlanningHoldResult,
  type ExpansionPlanningHoldState,
} from "./expansion-planning-hold.js";

type CreateCommand = Extract<
  ExpansionPlanningHoldCommand,
  { readonly kind: "graph.request_expansion" }
>;
type TransitionCommand = Extract<
  ExpansionPlanningHoldCommand,
  { readonly kind: "expansion.transition_hold" }
>;

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function createCommand(overrides: Partial<CreateCommand> = {}): CreateCommand {
  return {
    commandId: "command:create",
    deadline: 4_000,
    expectedVersion: 0,
    generation: 1,
    graphEpoch: 7,
    holdId: "hold:expansion:1",
    kind: "graph.request_expansion",
    parentNodeRef: "node:parent",
    parentRevisionRef: "revision:active",
    parentRunRef: "run:parent",
    planningRunRef: "planning:expansion:1",
    proposalBaseHash: HASH_A,
    rationale: { text: "split bounded independent work", truthClass: "AGENT_REPORTED" },
    release: {
      attemptRef: "attempt:released",
      attemptState: "RELEASED",
      disposition: {
        resumable: true,
        strongestReason: "WORK_RELEASE_OR_PAUSE",
        terminalTarget: "RELEASED",
      },
      effectsTerminal: true,
      handoff: { digest: HASH_B, ref: "handoff:worker" },
      leaseRef: "lease:released",
      leaseState: "RELEASED",
      observationRef: "observation:safe-boundary",
      providerSlotRef: "slot:released",
      providerSlotState: "RELEASED",
      reason: "WORK_RELEASE_OR_PAUSE",
      receiptRef: "receipt:release",
      resourcesTerminal: true,
      safeBoundaryObserved: true,
      terminalEffectRefs: ["effect:terminal"],
      terminalResourceRefs: ["resource:terminal"],
      truthClass: "DAEMON_VERIFIED",
    },
    sourceFingerprint: HASH_B,
    workerHandoff: { digest: HASH_B, ref: "handoff:worker" },
    ...overrides,
  };
}

function transitionCommand(
  state: ExpansionPlanningHoldState,
  overrides: Partial<TransitionCommand> = {},
): TransitionCommand {
  return {
    cause: "EXPANSION_REFUSED",
    commandId: "command:terminal",
    expectedVersion: state.version,
    generation: state.generation,
    graphEpoch: state.graphEpoch,
    holdId: state.holdId,
    kind: "expansion.transition_hold",
    parentNodeRef: state.parentNodeRef,
    parentRevisionRef: state.parentRevisionRef,
    parentRunRef: state.parentRunRef,
    planningRunRef: state.planningRunRef,
    proposalBaseHash: state.proposalBaseHash,
    sourceFingerprint: state.sourceFingerprint,
    targetLifecycle: "RESOLVED",
    terminalProof: {
      authorityState: "TERMINAL",
      decisionRef: "decision:terminal",
      successorHoldRef: null,
      truthClass: "DAEMON_VERIFIED",
    },
    ...overrides,
  };
}

function expectDeepFrozen(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    expectDeepFrozen((value as Record<PropertyKey, unknown>)[key], seen);
  }
}

function expectRefusal(
  result: ExpansionPlanningHoldResult,
  code: (typeof EXPANSION_HOLD_ERROR_CODES)[number],
  layer: (typeof EXPANSION_HOLD_LAYERS)[number],
  state: ExpansionPlanningHoldState | null = null,
): void {
  expect(result).toEqual({ code, layer, ok: false, state });
  expectDeepFrozen(result);
}

function accepted(command = createCommand()): Extract<ExpansionPlanningHoldResult, { ok: true }> {
  const result = reduceExpansionPlanningHold(undefined, command);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`expected accepted creation, got ${result.code}`);
  return result;
}

function ownKeyNames(value: unknown, out = new Set<string>()): ReadonlySet<string> {
  if (value === null || typeof value !== "object") return out;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "string") out.add(key);
    ownKeyNames((value as Record<PropertyKey, unknown>)[key], out);
  }
  return out;
}

describe("expansion planning hold creation", () => {
  it("publishes closed command, refusal and layer vocabularies", () => {
    expect(EXPANSION_HOLD_COMMAND_KINDS).toEqual([
      "graph.request_expansion",
      "expansion.transition_hold",
    ]);
    expect(EXPANSION_HOLD_CAUSES).toEqual([
      "EXPANSION_REFUSED",
      "GRAPH_ACTIVATED",
      "REVISE_PLAN",
      "GRAPH_SUPERSEDED",
      "EXPANSION_DECLINED",
      "PLANNING_CANCELLED",
      "GOAL_CANCELLED",
    ]);
    expect(EXPANSION_HOLD_ERROR_CODES).toEqual([
      "EXPANSION_HOLD_INPUT_INVALID",
      "EXPANSION_HOLD_SAFE_BOUNDARY_UNPROVEN",
      "EXPANSION_HOLD_STALE_VERSION",
      "EXPANSION_HOLD_STALE_GENERATION",
      "EXPANSION_HOLD_STALE_EPOCH",
      "EXPANSION_HOLD_BINDING_MISMATCH",
      "EXPANSION_HOLD_IDEMPOTENCY_CONFLICT",
      "EXPANSION_HOLD_ILLEGAL_TRANSITION",
      "EXPANSION_HOLD_TERMINAL_PROOF_REQUIRED",
    ]);
    expect(EXPANSION_HOLD_LAYERS).toEqual([
      "INPUT",
      "SAFE_BOUNDARY",
      "CONCURRENCY",
      "BINDING",
      "IDEMPOTENCY",
      "LIFECYCLE",
      "TERMINAL_PROOF",
    ]);
    expect(Object.isFrozen(EXPANSION_HOLD_COMMAND_KINDS)).toBe(true);
    expect(Object.isFrozen(EXPANSION_HOLD_CAUSES)).toBe(true);
    expect(Object.isFrozen(EXPANSION_HOLD_ERROR_CODES)).toBe(true);
    expect(Object.isFrozen(EXPANSION_HOLD_LAYERS)).toBe(true);
  });

  it("creates the exact ACTIVE hold and event from a proven release", () => {
    const command = createCommand();
    const result = accepted(command);
    expect(result).toEqual({
      event: {
        commandId: "command:create",
        holdId: "hold:expansion:1",
        kind: "EXPANSION_HOLD_CREATED",
        lifecycle: "ACTIVE",
        version: 1,
      },
      ok: true,
      state: {
        creationReceipt: { command },
        deadline: 4_000,
        generation: 1,
        graphEpoch: 7,
        holdId: "hold:expansion:1",
        holdKind: "EXPANSION_PLANNING",
        lifecycle: "ACTIVE",
        parentNodeRef: "node:parent",
        parentRevisionRef: "revision:active",
        parentRunRef: "run:parent",
        planningRunRef: "planning:expansion:1",
        proposalBaseHash: HASH_A,
        rationale: { text: "split bounded independent work", truthClass: "AGENT_REPORTED" },
        release: command.release,
        sourceFingerprint: HASH_B,
        terminalReceipt: null,
        version: 1,
        workerHandoff: { digest: HASH_B, ref: "handoff:worker" },
      },
    });
    expect(Object.keys(result.state).sort()).toEqual([
      "creationReceipt", "deadline", "generation", "graphEpoch", "holdId", "holdKind",
      "lifecycle", "parentNodeRef", "parentRevisionRef", "parentRunRef", "planningRunRef",
      "proposalBaseHash", "rationale", "release", "sourceFingerprint", "terminalReceipt",
      "version", "workerHandoff",
    ]);
    expect(Object.keys(result.state.release).sort()).toEqual([
      "attemptRef", "attemptState", "disposition", "effectsTerminal", "handoff", "leaseRef",
      "leaseState", "observationRef", "providerSlotRef", "providerSlotState", "reason",
      "receiptRef", "resourcesTerminal", "safeBoundaryObserved", "terminalEffectRefs",
      "terminalResourceRefs", "truthClass",
    ]);
    expect(Object.keys(result.event).sort()).toEqual([
      "commandId", "holdId", "kind", "lifecycle", "version",
    ]);
    expectDeepFrozen(result);
  });

  it("snapshots caller data and exposes no execution or child authority", () => {
    const command = createCommand();
    const result = accepted(command);
    (command.release.terminalEffectRefs as string[]).push("effect:late");
    (command.release.terminalResourceRefs as string[]).push("resource:late");
    (command.workerHandoff as { ref: string }).ref = "handoff:hijacked";
    expect(result.state.release.terminalEffectRefs).toEqual(["effect:terminal"]);
    expect(result.state.release.terminalResourceRefs).toEqual(["resource:terminal"]);
    expect(result.state.workerHandoff.ref).toBe("handoff:worker");

    const forbidden = [
      "budgetAllocation", "childRun", "commandAuthority", "effect", "graphActivation",
      "lease", "resource", "slot",
    ];
    const keys = ownKeyNames(result);
    expect(forbidden.filter((key) => keys.has(key))).toEqual([]);
  });

  it("replays the same command byte-identically and rejects a payload swap", () => {
    const command = createCommand();
    const first = accepted(command);
    const replay = reduceExpansionPlanningHold(first.state, structuredClone(command));
    expect(replay).toEqual(first);
    expect(JSON.stringify(replay)).toBe(JSON.stringify(first));
    expectDeepFrozen(replay);

    const changed = createCommand({ deadline: command.deadline + 1 });
    const before = JSON.stringify(first.state);
    expectRefusal(
      reduceExpansionPlanningHold(first.state, changed),
      "EXPANSION_HOLD_IDEMPOTENCY_CONFLICT",
      "IDEMPOTENCY",
      first.state,
    );
    expect(JSON.stringify(first.state)).toBe(before);
  });

  it("refuses every semantically unproven release at SAFE_BOUNDARY", () => {
    const base = createCommand().release;
    const unsafe = [
      { ...base, truthClass: "UNKNOWN" },
      { ...base, reason: "GOAL_CANCEL" },
      { ...base, safeBoundaryObserved: false },
      { ...base, attemptState: "RUNNING" },
      { ...base, leaseState: "ACTIVE" },
      { ...base, providerSlotState: "ACTIVE" },
      { ...base, effectsTerminal: false },
      { ...base, resourcesTerminal: false },
      { ...base, disposition: { ...base.disposition, resumable: false } },
      { ...base, disposition: { ...base.disposition, terminalTarget: "REVOKED" } },
    ];
    expect(unsafe).toHaveLength(10);
    expect(unsafe.length).toBeGreaterThan(0);
    for (const release of unsafe) {
      expectRefusal(
        reduceExpansionPlanningHold(undefined, createCommand({ release } as never)),
        "EXPANSION_HOLD_SAFE_BOUNDARY_UNPROVEN",
        "SAFE_BOUNDARY",
      );
    }
  });

  it("normalizes hostile, extra, missing, oversized and unsafe-number inputs", () => {
    const accessor = createCommand() as unknown as Record<string, unknown>;
    Object.defineProperty(accessor, "holdId", { enumerable: true, get: () => "hold:accessor" });
    const proxy = new Proxy(createCommand(), { ownKeys: () => { throw new Error("secret"); } });
    const cycle = createCommand() as unknown as Record<string, unknown>;
    cycle["cycle"] = cycle;
    const protoKey = createCommand() as unknown as Record<string, unknown>;
    Object.defineProperty(protoKey, "__proto__", {
      enumerable: true,
      value: { smuggled: true },
    });
    const indexed = ["effect:terminal"];
    Object.defineProperty(indexed, "0", { enumerable: true, get: () => "effect:getter" });
    const inherited = Object.setPrototypeOf(["resource:terminal"], Object.create(Array.prototype));
    const hostile: readonly unknown[] = [
      null,
      {},
      { ...createCommand(), extra: true },
      { ...createCommand(), holdId: "" },
      { ...createCommand(), proposalBaseHash: "A".repeat(64) },
      { ...createCommand(), sourceFingerprint: "short" },
      { ...createCommand(), deadline: Number.MAX_SAFE_INTEGER + 1 },
      { ...createCommand(), generation: 0 },
      { ...createCommand(), rationale: { text: "x".repeat(257), truthClass: "AGENT_REPORTED" } },
      accessor,
      proxy,
      cycle,
      protoKey,
      { ...createCommand(), release: { ...createCommand().release, terminalEffectRefs: indexed } },
      { ...createCommand(), release: { ...createCommand().release, terminalResourceRefs: inherited } },
    ];
    expect(hostile).toHaveLength(15);
    expect(hostile.length).toBeGreaterThan(0);
    for (const input of hostile) {
      expectRefusal(
        reduceExpansionPlanningHold(undefined, input),
        "EXPANSION_HOLD_INPUT_INVALID",
        "INPUT",
      );
    }
  });
});

describe("expansion planning hold terminal lifecycle", () => {
  const causes = [
    ["RESOLVED", "EXPANSION_REFUSED", "DAEMON_VERIFIED", null],
    ["RESOLVED", "GRAPH_ACTIVATED", "DAEMON_VERIFIED", null],
    ["SUPERSEDED", "REVISE_PLAN", "HUMAN_APPROVED", "hold:successor"],
    ["SUPERSEDED", "GRAPH_SUPERSEDED", "DAEMON_VERIFIED", "hold:successor"],
    ["CANCELLED", "EXPANSION_DECLINED", "HUMAN_APPROVED", null],
    ["CANCELLED", "PLANNING_CANCELLED", "DAEMON_VERIFIED", null],
    ["CANCELLED", "GOAL_CANCELLED", "DAEMON_VERIFIED", null],
  ] as const;

  it("accepts exactly the closed cause matrix with bound terminal proof", () => {
    expect(causes).toHaveLength(7);
    expect(causes.length).toBeGreaterThan(0);
    for (const [targetLifecycle, cause, truthClass, successorHoldRef] of causes) {
      const active = accepted().state;
      const command = transitionCommand(active, {
        cause,
        commandId: `command:${cause}`,
        targetLifecycle,
        terminalProof: {
          authorityState: "TERMINAL",
          decisionRef: `decision:${cause}`,
          successorHoldRef,
          truthClass,
        },
      });
      const result = reduceExpansionPlanningHold(active, command);
      expect(result).toEqual({
        event: {
          cause,
          commandId: `command:${cause}`,
          holdId: active.holdId,
          kind: "EXPANSION_HOLD_TERMINATED",
          lifecycle: targetLifecycle,
          version: 2,
        },
        ok: true,
        state: {
          ...active,
          lifecycle: targetLifecycle,
          terminalReceipt: { command },
          version: 2,
        },
      });
      expectDeepFrozen(result);
      if (!result.ok) throw new Error(`expected ${cause} to be accepted`);
      expect(result.state.workerHandoff).toEqual(active.workerHandoff);
      expect(result.state.release.handoff).toEqual(active.release.handoff);
    }
  });

  it("replays terminal commands exactly and rejects a same-id payload swap", () => {
    const active = accepted().state;
    const command = transitionCommand(active);
    const first = reduceExpansionPlanningHold(active, command);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected terminal acceptance");
    const replay = reduceExpansionPlanningHold(structuredClone(first.state), structuredClone(command));
    expect(replay).toEqual(first);
    expect(JSON.stringify(replay)).toBe(JSON.stringify(first));

    const changed = transitionCommand(first.state, {
      cause: "GRAPH_ACTIVATED",
      commandId: command.commandId,
      expectedVersion: command.expectedVersion,
    });
    expectRefusal(
      reduceExpansionPlanningHold(first.state, changed),
      "EXPANSION_HOLD_IDEMPOTENCY_CONFLICT",
      "IDEMPOTENCY",
      first.state,
    );
  });

  it("rejects terminal snapshots that no accepted command could produce", () => {
    const active = accepted().state;
    const terminal = reduceExpansionPlanningHold(active, transitionCommand(active));
    expect(terminal.ok).toBe(true);
    if (!terminal.ok || terminal.state.terminalReceipt === null) {
      throw new Error("expected terminal state");
    }
    const receipt = terminal.state.terminalReceipt.command;
    const forged = [
      { ...terminal.state, terminalReceipt: { command: { ...receipt, cause: "GOAL_CANCELLED" as const } } },
      { ...terminal.state, terminalReceipt: { command: {
        ...receipt,
        commandId: terminal.state.creationReceipt.command.commandId,
      } } },
    ];
    expect(forged).toHaveLength(2);
    expect(forged.length).toBeGreaterThan(0);
    for (const state of forged) {
      expectRefusal(
        reduceExpansionPlanningHold(state, transitionCommand(terminal.state, {
          commandId: "command:probe",
          expectedVersion: terminal.state.version,
        })),
        "EXPANSION_HOLD_INPUT_INVALID",
        "INPUT",
      );
    }
  });

  it("orders stale version, generation and epoch before binding", () => {
    const active = accepted().state;
    const cases = [
      [
        transitionCommand(active, { expectedVersion: active.version + 1, parentNodeRef: "node:wrong" }),
        "EXPANSION_HOLD_STALE_VERSION",
      ],
      [
        transitionCommand(active, { generation: active.generation + 1, parentNodeRef: "node:wrong" }),
        "EXPANSION_HOLD_STALE_GENERATION",
      ],
      [
        transitionCommand(active, { graphEpoch: active.graphEpoch + 1, parentNodeRef: "node:wrong" }),
        "EXPANSION_HOLD_STALE_EPOCH",
      ],
    ] as const;
    expect(cases).toHaveLength(3);
    expect(cases.length).toBeGreaterThan(0);
    for (const [command, code] of cases) {
      expectRefusal(reduceExpansionPlanningHold(active, command), code, "CONCURRENCY", active);
    }
    expectRefusal(
      reduceExpansionPlanningHold(undefined, transitionCommand(active)),
      "EXPANSION_HOLD_STALE_VERSION",
      "CONCURRENCY",
    );
  });

  it("refuses each repeated binding field independently", () => {
    const active = accepted().state;
    const commands = [
      transitionCommand(active, { holdId: "hold:wrong" }),
      transitionCommand(active, { parentNodeRef: "node:wrong" }),
      transitionCommand(active, { parentRunRef: "run:wrong" }),
      transitionCommand(active, { parentRevisionRef: "revision:wrong" }),
      transitionCommand(active, { planningRunRef: "planning:wrong" }),
      transitionCommand(active, { proposalBaseHash: HASH_B }),
      transitionCommand(active, { sourceFingerprint: HASH_A }),
    ];
    expect(commands).toHaveLength(7);
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expectRefusal(
        reduceExpansionPlanningHold(active, command),
        "EXPANSION_HOLD_BINDING_MISMATCH",
        "BINDING",
        active,
      );
    }
  });

  it("requires terminal authority and cause-specific truth without clearing ACTIVE", () => {
    const active = accepted().state;
    const commands = [
      transitionCommand(active, { terminalProof: null }),
      transitionCommand(active, {
        terminalProof: { authorityState: "TERMINAL", decisionRef: "decision:unknown", successorHoldRef: null, truthClass: "UNKNOWN" },
      }),
      transitionCommand(active, {
        terminalProof: { authorityState: "LIVE", decisionRef: "decision:live", successorHoldRef: null, truthClass: "DAEMON_VERIFIED" },
      }),
      transitionCommand(active, {
        terminalProof: { authorityState: "DRAINING", decisionRef: "decision:draining", successorHoldRef: null, truthClass: "DAEMON_VERIFIED" },
      }),
      transitionCommand(active, {
        cause: "REVISE_PLAN",
        targetLifecycle: "SUPERSEDED",
        terminalProof: { authorityState: "TERMINAL", decisionRef: "decision:revise", successorHoldRef: "hold:successor", truthClass: "DAEMON_VERIFIED" },
      }),
      transitionCommand(active, {
        cause: "GRAPH_SUPERSEDED",
        targetLifecycle: "SUPERSEDED",
        terminalProof: { authorityState: "TERMINAL", decisionRef: "decision:no-successor", successorHoldRef: null, truthClass: "DAEMON_VERIFIED" },
      }),
      transitionCommand(active, {
        terminalProof: { authorityState: "TERMINAL", decisionRef: "decision:wrong-successor", successorHoldRef: "hold:unexpected", truthClass: "DAEMON_VERIFIED" },
      }),
    ];
    expect(commands).toHaveLength(7);
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expectRefusal(
        reduceExpansionPlanningHold(active, command),
        "EXPANSION_HOLD_TERMINAL_PROOF_REQUIRED",
        "TERMINAL_PROOF",
        active,
      );
    }
  });

  it("refuses cause-to-lifecycle mismatches at LIFECYCLE", () => {
    const active = accepted().state;
    const commands = [
      transitionCommand(active, { cause: "EXPANSION_REFUSED", targetLifecycle: "CANCELLED" }),
      transitionCommand(active, { cause: "REVISE_PLAN", targetLifecycle: "RESOLVED" }),
      transitionCommand(active, { cause: "GOAL_CANCELLED", targetLifecycle: "SUPERSEDED" }),
    ];
    expect(commands).toHaveLength(3);
    for (const command of commands) {
      expectRefusal(
        reduceExpansionPlanningHold(active, command),
        "EXPANSION_HOLD_ILLEGAL_TRANSITION",
        "LIFECYCLE",
        active,
      );
    }
  });

  it("keeps terminal states terminal across every competing order", () => {
    const representatives = [
      transitionCommand(accepted().state, { cause: "EXPANSION_REFUSED", targetLifecycle: "RESOLVED" }),
      transitionCommand(accepted().state, {
        cause: "GRAPH_SUPERSEDED",
        targetLifecycle: "SUPERSEDED",
        terminalProof: { authorityState: "TERMINAL", decisionRef: "decision:supersede", successorHoldRef: "hold:successor", truthClass: "DAEMON_VERIFIED" },
      }),
      transitionCommand(accepted().state, { cause: "GOAL_CANCELLED", targetLifecycle: "CANCELLED" }),
    ];
    const orders = representatives.flatMap((first, firstIndex) =>
      representatives
        .filter((_, secondIndex) => secondIndex !== firstIndex)
        .map((second) => [first, second] as const));
    expect(orders).toHaveLength(6);
    expect(orders.length).toBeGreaterThan(0);
    for (const [firstCommand, secondTemplate] of orders) {
      const active = accepted().state;
      const first = reduceExpansionPlanningHold(active, {
        ...firstCommand,
        expectedVersion: active.version,
        generation: active.generation,
        graphEpoch: active.graphEpoch,
      });
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error("expected first terminal command to win");
      const second = {
        ...secondTemplate,
        commandId: `${secondTemplate.commandId}:second`,
        expectedVersion: first.state.version,
        generation: first.state.generation,
        graphEpoch: first.state.graphEpoch,
      };
      expectRefusal(
        reduceExpansionPlanningHold(first.state, second),
        "EXPANSION_HOLD_ILLEGAL_TRANSITION",
        "LIFECYCLE",
        first.state,
      );
      expect(first.state.workerHandoff).toEqual(active.workerHandoff);
    }
  });

  it("accepts a restarted ACTIVE snapshot and never transitions merely because the deadline passed", () => {
    const expired = accepted(createCommand({ deadline: 0 })).state;
    expect(expired.lifecycle).toBe("ACTIVE");
    const restarted = structuredClone(expired);
    const result = reduceExpansionPlanningHold(restarted, transitionCommand(restarted));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected restart transition");
    expect(result.state.lifecycle).toBe("RESOLVED");
    expect(result.state.workerHandoff).toEqual(expired.workerHandoff);
    expectDeepFrozen(result);
  });

  it("normalizes hostile terminal commands before lifecycle logic", () => {
    const active = accepted().state;
    const accessor = transitionCommand(active) as unknown as Record<string, unknown>;
    Object.defineProperty(accessor, "cause", { enumerable: true, get: () => "EXPANSION_REFUSED" });
    const proxy = new Proxy(transitionCommand(active), { getPrototypeOf: () => { throw new Error("secret"); } });
    const cycle = transitionCommand(active) as unknown as Record<string, unknown>;
    cycle["cycle"] = cycle;
    const hostile = [
      accessor,
      proxy,
      cycle,
      { ...transitionCommand(active), extra: true },
      { ...transitionCommand(active), terminalProof: { authorityState: "TERMINAL" } },
    ];
    expect(hostile).toHaveLength(5);
    expect(hostile.length).toBeGreaterThan(0);
    for (const command of hostile) {
      expectRefusal(
        reduceExpansionPlanningHold(active, command),
        "EXPANSION_HOLD_INPUT_INVALID",
        "INPUT",
        active,
      );
    }
  });
});
