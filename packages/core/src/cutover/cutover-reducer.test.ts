import { RUNTIME_LIFECYCLES } from "@moe/contracts";
// Arm 4(D): the BARE package specifier, not a relative path. `packages/core/package.json`
// pins `exports: { ".": "./src/index.ts" }` — a single subpath — so this is the only shape a
// consumer can use, and an unexported symbol is invisible here even though its file compiles.
import * as coreBarrel from "@moe/core";
import { describe, expect, it } from "vitest";

import {
  CUTOVER_COMMAND_KINDS,
  CUTOVER_TARGET_STATES,
  CUTOVER_TERMINAL_STATES,
  CUTOVER_TRANSITIONS,
  reduceCutover,
} from "./cutover-reducer.js";
import type {
  CutoverAttemptState,
  CutoverCommand,
  CutoverCommandKind,
  CutoverReducerResult,
  CutoverState,
} from "./cutover-contract.js";

const APPROVAL = Object.freeze({
  approvalRef: "approval-1", truthClass: "HUMAN_APPROVED" as const,
});
const INVENTORY = Object.freeze({
  inventoryRef: "inventory-1", truthClass: "DAEMON_VERIFIED" as const,
});
const QUIESCE_PROOF = Object.freeze({
  identicalManifestRef: "manifest-1", truthClass: "DAEMON_VERIFIED" as const,
  writeLockRef: "lock-1",
});
const IMPORT_VERIFICATION = Object.freeze({
  importHeadRef: "import-head-1", restoreDrillRef: "restore-1",
  truthClass: "DAEMON_VERIFIED" as const,
});
const ABORT = Object.freeze({
  legacyUnfrozenRef: "unfrozen-1", truthClass: "HUMAN_APPROVED" as const,
});

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Reflect.ownKeys(value)) {
      freezeDeep((value as Record<PropertyKey, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function state(lifecycle: CutoverState, version = 7): CutoverAttemptState {
  return freezeDeep({
    activateApprovalRef: lifecycle === "ACTIVATE_APPROVED" || lifecycle === "ACTIVE"
      ? "approval-2" : null,
    attemptId: "cutover-1",
    importHeadRef: lifecycle === "PREVIEWED" || lifecycle === "QUIESCE_APPROVED"
      || lifecycle === "QUIESCING" || lifecycle === "QUIESCED" ? null : "import-head-1",
    lifecycle,
    quiesceApprovalRef: lifecycle === "PREVIEWED" ? null : "approval-1",
    sourceManifestRef: "source-manifest-1",
    version,
  });
}

/** One well-formed command per kind, at the version the fixture state carries. */
function command(kind: CutoverCommandKind, expectedVersion = 7): CutoverCommand {
  const base = { commandId: `command-${kind}`, expectedVersion };
  switch (kind) {
    case "cutover.preview":
      return freezeDeep({
        ...base, attemptId: "cutover-1", kind, sourceManifestRef: "source-manifest-1",
        witness: INVENTORY,
      });
    case "cutover.admit_quiesce_approval":
    case "cutover.admit_activate_approval":
      return freezeDeep({ ...base, kind, witness: APPROVAL });
    case "cutover.begin_quiesce":
    case "cutover.activate":
      return freezeDeep({ ...base, kind });
    case "cutover.complete_quiesce":
      return freezeDeep({ ...base, kind, witness: QUIESCE_PROOF });
    case "cutover.verify_import":
      return freezeDeep({ ...base, kind, witness: IMPORT_VERIFICATION });
    case "cutover.abort":
      return freezeDeep({ ...base, kind, witness: ABORT });
  }
}

function rejection(result: CutoverReducerResult): { code: string; details: unknown; layer: string } {
  if (result.ok) throw new Error("expected a refusal, got an accepted result");
  return { code: result.error.code, details: result.error.details, layer: result.layer };
}

/** Reading the table through this helper keeps the empty creation list from narrowing to never. */
function admittedSources(kind: CutoverCommandKind): readonly CutoverState[] {
  return CUTOVER_TRANSITIONS[kind];
}

const LEGAL_EDGES: readonly (readonly [CutoverState, CutoverCommandKind])[] =
  CUTOVER_COMMAND_KINDS.flatMap((kind) =>
    admittedSources(kind).map((source) => [source, kind] as const));

const ILLEGAL_EDGES: readonly (readonly [CutoverState, CutoverCommandKind])[] =
  RUNTIME_LIFECYCLES.CUTOVER.flatMap((source) =>
    CUTOVER_COMMAND_KINDS
      .filter((kind) => !admittedSources(kind).includes(source))
      .map((kind) => [source, kind] as const));

describe("task-b5315f42 reduceCutover legal edges", () => {
  it("creates PREVIEWED from no prior state at version 1", () => {
    const result = reduceCutover(undefined, command("cutover.preview", 0));
    if (!result.ok) throw new Error(`expected acceptance, got ${result.error.code}`);
    expect(result.state.lifecycle).toBe("PREVIEWED");
    expect(result.state.version).toBe(1);
    expect(result.state.attemptId).toBe("cutover-1");
    expect(result.events.map((event) => event.kind)).toEqual(["CutoverAttemptPreviewed"]);
    expect(Object.isFrozen(result.state)).toBe(true);
  });

  it.each(LEGAL_EDGES.filter(([, kind]) => kind !== "cutover.preview"))(
    "admits %s -> %s and advances the version by exactly one",
    (source, kind) => {
      const result = reduceCutover(state(source), command(kind));
      if (!result.ok) throw new Error(`expected acceptance, got ${result.error.code}`);
      expect(result.state.lifecycle).toBe(CUTOVER_TARGET_STATES[kind]);
      expect(result.state.version).toBe(8);
      expect(result.events).toHaveLength(1);
      expect(result.events[0]?.commandKind).toBe(kind);
      expect(result.events[0]?.version).toBe(8);
    },
  );

  it("records the quiesce approval, the activate approval and the import head", () => {
    const quiesced = reduceCutover(state("PREVIEWED"), command("cutover.admit_quiesce_approval"));
    const verified = reduceCutover(state("QUIESCED"), command("cutover.verify_import"));
    const activatable = reduceCutover(
      state("IMPORT_VERIFIED"), command("cutover.admit_activate_approval"),
    );
    if (!quiesced.ok || !verified.ok || !activatable.ok) throw new Error("expected acceptances");
    expect(quiesced.state.quiesceApprovalRef).toBe("approval-1");
    expect(verified.state.importHeadRef).toBe("import-head-1");
    expect(activatable.state.activateApprovalRef).toBe("approval-1");
  });

  it("reaches ACTIVE only through the full design chain", () => {
    let current = reduceCutover(undefined, command("cutover.preview", 0));
    const chain: CutoverCommandKind[] = [
      "cutover.admit_quiesce_approval", "cutover.begin_quiesce", "cutover.complete_quiesce",
      "cutover.verify_import", "cutover.admit_activate_approval", "cutover.activate",
    ];
    const seen: CutoverState[] = [];
    for (const kind of chain) {
      if (!current.ok) throw new Error(`chain broke before ${kind}: ${current.error.code}`);
      seen.push(current.state.lifecycle);
      current = reduceCutover(current.state, command(kind, current.state.version));
    }
    if (!current.ok) throw new Error(`chain broke at the end: ${current.error.code}`);
    expect(seen).toEqual([
      "PREVIEWED", "QUIESCE_APPROVED", "QUIESCING", "QUIESCED", "IMPORT_VERIFIED",
      "ACTIVATE_APPROVED",
    ]);
    expect(current.state.lifecycle).toBe("ACTIVE");
    expect(current.state.version).toBe(7);
  });
});

describe("task-b5315f42 reduceCutover refusals name their code and layer", () => {
  it("refuses an illegal edge with ILLEGAL_TRANSITION carrying the source state", () => {
    const { code, details, layer } = rejection(
      reduceCutover(state("PREVIEWED"), command("cutover.activate")),
    );
    expect(code).toBe("ILLEGAL_TRANSITION");
    expect(layer).toBe("CUTOVER");
    expect(details).toEqual({
      aggregateKind: "CUTOVER", commandKind: "cutover.activate", sourceState: "PREVIEWED",
    });
  });

  it("refuses an expected-version mismatch with ILLEGAL_TRANSITION, not EXPECTED_VERSION_CONFLICT",
    () => {
      // EXPECTED_VERSION_CONFLICT admits srcs(GOAL, GRAPH_REVISION, NODE_RUN, PLANNING_RUN,
      // PROJECT) and NOT CUTOVER, so raising it here would degrade to UNKNOWN_ERROR.
      const { code, details } = rejection(
        reduceCutover(state("PREVIEWED"), command("cutover.admit_quiesce_approval", 3)),
      );
      expect(code).toBe("ILLEGAL_TRANSITION");
      expect(details).toEqual({
        aggregateKind: "CUTOVER", commandKind: "cutover.admit_quiesce_approval",
        sourceState: "PREVIEWED",
      });
    });

  it("refuses a malformed command with INPUT_INVALID raised without a source", () => {
    const malformed = { commandId: "", expectedVersion: 7, kind: "cutover.begin_quiesce" };
    expect(rejection(reduceCutover(state("QUIESCE_APPROVED"), malformed as CutoverCommand)).code)
      .toBe("INPUT_INVALID");
    const unknownKind = { commandId: "c", expectedVersion: 7, kind: "cutover.teleport" };
    expect(rejection(reduceCutover(state("QUIESCE_APPROVED"), unknownKind as unknown as
      CutoverCommand)).code).toBe("INPUT_INVALID");
  });

  it("refuses a non-creation command against an absent state with INPUT_INVALID", () => {
    // No source state exists to tag, and ILLEGAL_TRANSITION without a source degrades to
    // UNKNOWN_ERROR because its validSources is non-empty.
    expect(rejection(reduceCutover(undefined, command("cutover.activate", 0))).code)
      .toBe("INPUT_INVALID");
  });

  it("refuses a structurally invalid state with CUTOVER_STATE_INVALID when its lifecycle reads",
    () => {
      const broken = { ...state("QUIESCING"), version: -1 } as CutoverAttemptState;
      const { code, details } = rejection(
        reduceCutover(broken, command("cutover.complete_quiesce")),
      );
      expect(code).toBe("CUTOVER_STATE_INVALID");
      expect(details).toEqual({ sourceState: "QUIESCING" });
    });

  it("refuses an unreadable lifecycle with INPUT_INVALID, because no CUTOVER source is taggable",
    () => {
      // isKnownLifecycleSource requires source.state to be a member of the CUTOVER tuple, so
      // CUTOVER_STATE_INVALID is unraisable here and would degrade to UNKNOWN_ERROR.
      const alien = { ...state("QUIESCING"), lifecycle: "TELEPORTED" } as unknown as
        CutoverAttemptState;
      expect(rejection(reduceCutover(alien, command("cutover.complete_quiesce"))).code)
        .toBe("INPUT_INVALID");
    });

  it("never degrades any refusal to UNKNOWN_ERROR", () => {
    const refusals: CutoverReducerResult[] = [
      reduceCutover(undefined, command("cutover.activate", 0)),
      reduceCutover(state("PREVIEWED"), command("cutover.admit_quiesce_approval", 3)),
      reduceCutover(state("QUIESCING"), { commandId: "", expectedVersion: 7,
        kind: "cutover.complete_quiesce" } as CutoverCommand),
      reduceCutover({ ...state("QUIESCING"), version: -1 } as CutoverAttemptState,
        command("cutover.complete_quiesce")),
      reduceCutover(undefined, undefined as unknown as CutoverCommand),
      ...ILLEGAL_EDGES.map(([source, kind]) => reduceCutover(state(source), command(kind))),
    ];
    // 8 states x 8 commands - 12 legal edges = 52 illegal pairs, plus the 5 shaped refusals.
    expect(LEGAL_EDGES).toHaveLength(12);
    expect(ILLEGAL_EDGES).toHaveLength(52);
    expect(refusals).toHaveLength(57);
    for (const result of refusals) {
      expect(result.ok).toBe(false);
      expect(rejection(result).code).not.toBe("UNKNOWN_ERROR");
      expect(rejection(result).layer).toBe("CUTOVER");
    }
  });

  it("keeps ACTIVE and ABORTED out of every edge's source list", () => {
    for (const terminal of CUTOVER_TERMINAL_STATES) {
      for (const kind of CUTOVER_COMMAND_KINDS) {
        expect(admittedSources(kind)).not.toContain(terminal);
      }
    }
  });
});

describe("task-b5315f42 reduceCutover properties", () => {
  it("handles exactly the vocabulary CUTOVER tuple, both directions, 8 of 8", () => {
    // Derived from the edge table and the target states, never from a constant written beside
    // the assertion: an expected value copied out of the module under test is a fixed point
    // that no mutation can red.
    const handled = new Set<string>();
    for (const kind of CUTOVER_COMMAND_KINDS) {
      for (const source of admittedSources(kind)) handled.add(source);
      handled.add(CUTOVER_TARGET_STATES[kind]);
    }
    const vocabulary = [...RUNTIME_LIFECYCLES.CUTOVER];
    expect(vocabulary).toHaveLength(8);
    expect(handled.size).toBe(8);
    // Direction 1: every vocabulary state is handled.
    expect(vocabulary.filter((state) => !handled.has(state))).toEqual([]);
    // Direction 2: every handled state is in the vocabulary.
    expect([...handled].filter((state) => !vocabulary.includes(state as CutoverState))).toEqual([]);
    expect([...handled].sort()).toEqual([...vocabulary].sort());
  });

  it("keeps ACTIVE terminal against all 8 commands, abort included", () => {
    // Design :1289-1290: `cutover.activate` commits and only then may the first v2
    // authoritative command run; after it, automatic rollback is NOT promised. An abort edge
    // out of ACTIVE would encode a guarantee the system cannot keep, so the asymmetry is the
    // point — abort is universally reachable from PRE-ACTIVE states and from nowhere else.
    let executed = 0;
    for (const kind of CUTOVER_COMMAND_KINDS) {
      const { code, details, layer } = rejection(reduceCutover(state("ACTIVE"), command(kind)));
      expect(code).toBe("ILLEGAL_TRANSITION");
      expect(layer).toBe("CUTOVER");
      expect(details).toEqual({
        aggregateKind: "CUTOVER", commandKind: kind, sourceState: "ACTIVE",
      });
      executed += 1;
    }
    expect(executed).toBe(CUTOVER_COMMAND_KINDS.length);
    expect(executed).toBe(8);
  });

  it("refuses all 52 illegal (state, command) pairs: 8 x 8 = 64 total minus 12 legal", () => {
    const total = RUNTIME_LIFECYCLES.CUTOVER.length * CUTOVER_COMMAND_KINDS.length;
    expect(total).toBe(64);
    expect(LEGAL_EDGES).toHaveLength(12);
    expect(ILLEGAL_EDGES).toHaveLength(total - LEGAL_EDGES.length);
    expect(ILLEGAL_EDGES.length).toBe(52);
    let executed = 0;
    for (const [source, kind] of ILLEGAL_EDGES) {
      const { code, details, layer } = rejection(reduceCutover(state(source), command(kind)));
      expect(code).toBe("ILLEGAL_TRANSITION");
      expect(layer).toBe("CUTOVER");
      expect(details).toEqual({ aggregateKind: "CUTOVER", commandKind: kind, sourceState: source });
      executed += 1;
    }
    expect(executed).toBe(52);
  });

  it("reaches the reducer, its edge table and its roster through the bare @moe/core specifier",
    () => {
      expect(typeof coreBarrel.reduceCutover).toBe("function");
      expect(coreBarrel.reduceCutover).toBe(reduceCutover);
      expect(coreBarrel.CUTOVER_COMMAND_KINDS).toEqual(CUTOVER_COMMAND_KINDS);
      expect(coreBarrel.CUTOVER_TRANSITIONS).toEqual(CUTOVER_TRANSITIONS);
      // Reached through the barrel, the reducer still refuses the same way it does directly.
      const viaBarrel = coreBarrel.reduceCutover(state("PREVIEWED"), command("cutover.activate"));
      expect(rejection(viaBarrel).code).toBe("ILLEGAL_TRANSITION");
    });
});
