/**
 * The CURRENT-HOLD binding surface, driven from the bare package root `@moe/scheduler`.
 *
 * The package `exports` map is exclusive, so a deep subpath would not resolve for a real
 * consumer; every specifier below is therefore the bare root. Nothing here reimplements the
 * production comparison — each property is asserted against `bindCurrentExpansionHold` itself,
 * and every delegated verdict is compared against the SAME core surface called directly, so a
 * re-coded delegation cannot pass by matching a literal transcribed twice.
 *
 * Refusals pin code AND layer AND origin AND target, because four surfaces can answer here:
 * this bridge, the core hold reducer, and the core planning-expansion inspector — and the
 * fairness contract once the admission composer is in the picture.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import {
  inspectPlanningExpansionContract, reduceExpansionPlanningHold, validExpansionHoldBinding,
} from "@moe/core";
import type { ExpansionPlanningHoldState, PlanningExpansionHoldBinding } from "@moe/core";

import * as scheduler from "@moe/scheduler";
import type {
  ExpansionBindingIssue, ExpansionBindingIssueCode, ExpansionBindingLayer,
  ExpansionBindingOrigin, ExpansionBindingRefusal, ExpansionCurrentAuthority,
  ExpansionCurrentHoldRequest, ExpansionCurrentHoldResult,
} from "@moe/scheduler";
/**
 * THE TYPE CLOSURE, proven the only way a type-only export can be: by naming it through the bare
 * root. `Object.keys` cannot see a type, so the namespace count guard is blind here — if the root
 * ever stopped re-exporting these two, `tsc` would fail with TS2305 on this import and on the
 * annotations below, and nothing else in the suite would notice. A consumer must be able to write
 * the request and read the result without ever reaching into `@moe/core`.
 */
import type {
  ExpansionPlanningHoldState as RootHoldState,
  PlanningExpansionHoldBinding as RootHoldBinding,
} from "@moe/scheduler";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const HANDOFF = { digest: DIGEST_B, ref: "handoff:worker" };

function holdCommand(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    commandId: "command:create", deadline: 4_000, expectedVersion: 0, generation: 1,
    graphEpoch: 11, holdId: "hold:expansion:1", kind: "graph.request_expansion",
    parentNodeRef: "node:parent", parentRevisionRef: "revision:active",
    parentRunRef: "run:parent", planningRunRef: "planning:expansion:1",
    proposalBaseHash: DIGEST_A,
    rationale: { text: "split bounded independent work", truthClass: "AGENT_REPORTED" },
    release: {
      attemptRef: "attempt:released", attemptState: "RELEASED",
      disposition: {
        resumable: true, strongestReason: "WORK_RELEASE_OR_PAUSE", terminalTarget: "RELEASED",
      },
      effectsTerminal: true, handoff: { ...HANDOFF },
      leaseRef: "lease:released", leaseState: "RELEASED",
      observationRef: "observation:safe-boundary", providerSlotRef: "slot:released",
      providerSlotState: "RELEASED", reason: "WORK_RELEASE_OR_PAUSE",
      receiptRef: "receipt:release", resourcesTerminal: true, safeBoundaryObserved: true,
      terminalEffectRefs: ["effect:terminal"], terminalResourceRefs: ["resource:terminal"],
      truthClass: "DAEMON_VERIFIED",
    },
    sourceFingerprint: DIGEST_B, workerHandoff: { ...HANDOFF },
    ...overrides,
  };
}

function activeHold(overrides: Readonly<Record<string, unknown>> = {}): ExpansionPlanningHoldState {
  const result = reduceExpansionPlanningHold(undefined, holdCommand(overrides));
  if (!result.ok) throw new Error(`hold refused: ${result.code}`);
  return result.state;
}

const CURRENT: ExpansionCurrentAuthority = {
  goalVersion: 7, graphEpoch: 11, holdId: "hold:expansion:1", holdVersion: 1,
  planningRunRef: "planning:expansion:1",
};

/** The exact production request type, named so a shape change breaks compilation here. */
function baseRequest(): ExpansionCurrentHoldRequest {
  return { currentAuthority: { ...CURRENT }, hold: activeHold() };
}

function holdRequest(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return { ...baseRequest(), ...overrides };
}

const EXPECTED_BINDING: PlanningExpansionHoldBinding = {
  generation: 1, goalVersion: 7, graphEpoch: 11, holdId: "hold:expansion:1",
  lifecycle: "ACTIVE", parentNodeRef: "node:parent", parentRunRef: "run:parent",
  proposalBaseHash: DIGEST_A, sourceFingerprint: DIGEST_B, truthClass: "DAEMON_VERIFIED",
  workerHandoff: { digest: DIGEST_B, ref: "handoff:worker" },
};

/** The single issue a refusal carried, failing loudly if there was not exactly one. */
function onlyIssue(result: ExpansionCurrentHoldResult): ExpansionBindingIssue {
  if (result.ok) throw new Error("expected a refusal");
  const refusal: ExpansionBindingRefusal = result;
  expect(refusal.issues).toHaveLength(1);
  return refusal.issues[0] as ExpansionBindingIssue;
}

/** A refusal must carry NO binding at all — an absent verdict, never an empty one. */
function refusedWithoutBinding(value: unknown): ExpansionCurrentHoldResult {
  const result: ExpansionCurrentHoldResult = scheduler.bindCurrentExpansionHold(value);
  expect(result.ok).toBe(false);
  expect(Object.prototype.hasOwnProperty.call(result, "binding")).toBe(false);
  return result;
}

/**
 * The three refusal vocabularies MOVED source file in this change. Nothing else pins them by
 * value — every other assertion is a `toContain`, which stays green if a code is dropped or the
 * set silently grows. Transcribed by hand in the production order, so a lost entry, an unreviewed
 * addition and a thawed array are each one failing assertion.
 */
it("keeps the moved refusal vocabularies frozen and byte-identical", () => {
  expect([...scheduler.EXPANSION_BINDING_ORIGINS])
    .toEqual(["BRIDGE", "EXPANSION_HOLD", "FAIRNESS", "PLANNING_CONTRACT"]);
  expect([...scheduler.EXPANSION_BINDING_LAYERS])
    .toEqual(["CURRENT_AUTHORITY", "FAIRNESS", "HOLD", "PREPARATION", "REQUEST"]);
  expect([...scheduler.EXPANSION_BINDING_ISSUE_CODES]).toEqual([
    "EXPANSION_BINDING_CURRENT_AUTHORITY_UNKNOWN", "EXPANSION_BINDING_GOAL_VERSION_MISMATCH",
    "EXPANSION_BINDING_GRAPH_EPOCH_MISMATCH", "EXPANSION_BINDING_HOLD_ID_MISMATCH",
    "EXPANSION_BINDING_HOLD_INACTIVE", "EXPANSION_BINDING_HOLD_STATE_MISMATCH",
    "EXPANSION_BINDING_HOLD_VERSION_MISMATCH",
    "EXPANSION_BINDING_OPPORTUNITY_WINNER_MISMATCH", "EXPANSION_BINDING_PLANNING_RUN_MISMATCH",
    "EXPANSION_BINDING_PREPARATION_IDENTITY_MISMATCH", "EXPANSION_BINDING_REQUEST_MALFORMED",
  ]);
  for (const vocabulary of [scheduler.EXPANSION_BINDING_ORIGINS, scheduler.EXPANSION_BINDING_LAYERS,
    scheduler.EXPANSION_BINDING_ISSUE_CODES]) {
    expect(Object.isFrozen(vocabulary)).toBe(true);
  }
});

it("completes its whole type closure from the bare root, with no @moe/core import", () => {
  // Written entirely in ROOT-published types: hold in, binding out, nothing deep-imported.
  const hold: RootHoldState = activeHold();
  const request: ExpansionCurrentHoldRequest = { currentAuthority: { ...CURRENT }, hold };
  const result: ExpansionCurrentHoldResult = scheduler.bindCurrentExpansionHold(request);
  if (!result.ok) throw new Error(result.issues.map((one) => one.code).join(","));
  const binding: RootHoldBinding = result.binding;
  expect([binding.holdId, binding.truthClass, binding.lifecycle])
    .toEqual(["hold:expansion:1", "DAEMON_VERIFIED", "ACTIVE"]);
});

it("binds one ACTIVE hold to the exact eleven-field core planning binding", () => {
  const result: ExpansionCurrentHoldResult = scheduler.bindCurrentExpansionHold(baseRequest());
  if (!result.ok) throw new Error(result.issues.map((one) => one.code).join(","));
  const binding: PlanningExpansionHoldBinding = result.binding;
  expect(binding).toEqual(EXPECTED_BINDING);
  // Exact bytes, not merely a superset: an extra minted field would pass `toEqual` on a subset.
  expect(Object.keys(binding).sort()).toEqual([
    "generation", "goalVersion", "graphEpoch", "holdId", "lifecycle", "parentNodeRef",
    "parentRunRef", "proposalBaseHash", "sourceFingerprint", "truthClass", "workerHandoff",
  ]);
  // Not asserted, RE-INSPECTED: core's own predicate agrees the derived binding is valid.
  expect(validExpansionHoldBinding(binding)).toBe(true);
});

it("returns a deeply frozen result detached from every caller record", () => {
  const current: Record<string, unknown> = { ...CURRENT };
  const handoff = { ...HANDOFF };
  const hold: Record<string, unknown> = { ...activeHold(), workerHandoff: handoff };
  const result = scheduler.bindCurrentExpansionHold({ currentAuthority: current, hold });
  if (!result.ok) throw new Error(result.issues.map((one) => one.code).join(","));
  expect([Object.isFrozen(result), Object.isFrozen(result.binding),
    Object.isFrozen(result.binding.workerHandoff)]).toEqual([true, true, true]);
  current["goalVersion"] = 9;
  handoff.ref = "handoff:other";
  hold["holdId"] = "hold:expansion:9";
  expect([result.binding.goalVersion, result.binding.workerHandoff.ref, result.binding.holdId])
    .toEqual([7, "handoff:worker", "hold:expansion:1"]);
});

it("mints no run, child, lease, effect, slot or activation authority", () => {
  const result = scheduler.bindCurrentExpansionHold(baseRequest());
  if (!result.ok) throw new Error("expected an accepted binding");
  const keys = new Set<string>();
  const walk = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) { keys.add(key); walk(nested); }
  };
  walk(result.binding);
  // `parentRunRef` names the PARENT work the hold was taken from; nothing else matches.
  expect([...keys].filter((key) => /run|lease|effect|slot|allocation|dispatch|activat/iu.test(key)))
    .toEqual(["parentRunRef"]);
});

// ---------------------------------------------------------------------------
// Hostile request shapes. Every one is REFUSED at the REQUEST layer by this
// bridge, and none of them may invoke a getter or a proxy trap on the way.
// ---------------------------------------------------------------------------

function revokedProxy(): unknown {
  const revocable = Proxy.revocable<Record<string, unknown>>({}, {});
  revocable.revoke();
  return revocable.proxy;
}

function sparseRequest(): unknown {
  const sparse: unknown[] = [];
  sparse.length = 2;
  return sparse;
}

const REQUEST_SHAPE_CASES: readonly (readonly [string, () => unknown])[] = [
  ["a non-record request", () => null],
  ["an undefined request", () => undefined],
  ["a string request", () => "currentAuthority"],
  ["an array request", () => []],
  ["a sparse array request", sparseRequest],
  ["a revoked proxy request", revokedProxy],
  ["a live proxy request", () => new Proxy(baseRequest() as object, {})],
  ["a request with an extra key", () => ({ ...baseRequest(), extra: 1 })],
  ["a request with a symbol key", () => ({ ...baseRequest(), [Symbol("hidden")]: 1 })],
  ["a request with a non-enumerable extra key", () => Object.defineProperty(
    { ...baseRequest() }, "extra", { enumerable: false, value: 1 },
  )],
  ["a request on a custom prototype",
    () => Object.assign(Object.create({ inherited: true }) as object, baseRequest())],
  ["a request missing its hold", () => ({ currentAuthority: { ...CURRENT } })],
  ["a request missing its current authority", () => ({ hold: activeHold() })],
  ["a request whose hold is an accessor", () => Object.defineProperty(
    { currentAuthority: { ...CURRENT } }, "hold",
    { enumerable: true, get: () => activeHold() },
  )],
  ["a request whose current authority is an accessor", () => Object.defineProperty(
    { hold: activeHold() }, "currentAuthority", { enumerable: true, get: () => ({ ...CURRENT }) },
  )],
];

it("generated one request-shape case per enumerated hostile shape", () => {
  expect(REQUEST_SHAPE_CASES.length).toBe(15);
  expect(new Set(REQUEST_SHAPE_CASES.map(([name]) => name)).size).toBe(15);
});

it.each(REQUEST_SHAPE_CASES)("refuses %s at the request layer", (_name, build) => {
  const result = refusedWithoutBinding(build());
  const issue = onlyIssue(result);
  if (result.ok) throw new Error("expected a refusal");
  const code: string = issue.code;
  const layer: string = issue.layer;
  const origin: ExpansionBindingOrigin = issue.origin;
  expect([code, layer, origin, issue.missingInput, issue.target, result.disposition]).toEqual([
    "EXPANSION_BINDING_REQUEST_MALFORMED", "REQUEST", "BRIDGE", null, null, "REFUSED",
  ]);
  const known: ExpansionBindingIssueCode = code as ExpansionBindingIssueCode;
  const layers: ExpansionBindingLayer = layer as ExpansionBindingLayer;
  expect(scheduler.EXPANSION_BINDING_ISSUE_CODES).toContain(known);
  expect(scheduler.EXPANSION_BINDING_LAYERS).toContain(layers);
  expect(scheduler.EXPANSION_BINDING_ORIGINS).toContain(origin);
});

it("never invokes an accessor while refusing the record that carries it", () => {
  let reads = 0;
  const request = Object.defineProperty({ currentAuthority: { ...CURRENT } }, "hold", {
    enumerable: true,
    get: () => { reads += 1; return activeHold(); },
  });
  expect(() => scheduler.bindCurrentExpansionHold(request)).not.toThrow();
  expect(onlyIssue(scheduler.bindCurrentExpansionHold(request)).code)
    .toBe("EXPANSION_BINDING_REQUEST_MALFORMED");
  expect(reads).toBe(0);
});

// ---------------------------------------------------------------------------
// The hold itself: shape, lifecycle, reducer replay, presented-versus-replayed.
// ---------------------------------------------------------------------------

const HOLD_CASES: readonly (readonly [string, () => unknown, string, string])[] = [
  ["a hold that is not a hold record", () => ({ holdId: "hold:1" }),
    "EXPANSION_BINDING_REQUEST_MALFORMED", "REQUEST"],
  ["a hold missing one key", () => {
    const hold: Record<string, unknown> = { ...activeHold() };
    delete hold["graphEpoch"];
    return hold;
  }, "EXPANSION_BINDING_REQUEST_MALFORMED", "REQUEST"],
  ["a hold with an extra key", () => ({ ...activeHold(), extra: 1 }),
    "EXPANSION_BINDING_REQUEST_MALFORMED", "REQUEST"],
  ["a hold that is a revoked proxy", revokedProxy,
    "EXPANSION_BINDING_REQUEST_MALFORMED", "REQUEST"],
  ["a hold carrying no readable creation command", () => ({ ...activeHold(), creationReceipt: {} }),
    "EXPANSION_BINDING_REQUEST_MALFORMED", "REQUEST"],
  ["a hold whose creation receipt carries an extra key",
    () => ({ ...activeHold(), creationReceipt: { command: holdCommand(), extra: 1 } }),
    "EXPANSION_BINDING_REQUEST_MALFORMED", "REQUEST"],
  ["a terminated hold", () => ({ ...activeHold(), lifecycle: "RESOLVED", version: 2 }),
    "EXPANSION_BINDING_HOLD_INACTIVE", "HOLD"],
  ["an ACTIVE hold at a version the create reducer never mints",
    () => ({ ...activeHold(), version: 2 }), "EXPANSION_BINDING_HOLD_INACTIVE", "HOLD"],
  ["an ACTIVE hold carrying a terminal receipt",
    () => ({ ...activeHold(), terminalReceipt: { command: holdCommand() } }),
    "EXPANSION_BINDING_HOLD_INACTIVE", "HOLD"],
];

it("generated one hold case per enumerated hold perturbation", () => {
  expect(HOLD_CASES.length).toBe(9);
  expect([...new Set(HOLD_CASES.map(([, , code]) => code))].length).toBe(2);
});

it.each(HOLD_CASES)("refuses %s with its own code and layer", (_name, build, code, layer) => {
  const issue = onlyIssue(refusedWithoutBinding(holdRequest({ hold: build() })));
  expect([issue.code, issue.layer, issue.origin, issue.missingInput, issue.target])
    .toEqual([code, layer, "BRIDGE", null, null]);
});

it("delegates a hold the core reducer refuses, keeping the reducer's code and layer", () => {
  const command = holdCommand();
  const release = command["release"] as Record<string, unknown>;
  const creation = { ...command, release: { ...release, safeBoundaryObserved: false } };
  const hold = { ...activeHold(), creationReceipt: { command: creation } };
  const direct = reduceExpansionPlanningHold(undefined, creation);
  expect(direct.ok).toBe(false);
  if (direct.ok) throw new Error("expected a refusal");
  const issue = onlyIssue(refusedWithoutBinding(holdRequest({ hold })));
  // Compared against the reducer called DIRECTLY, never against a transcribed literal.
  expect([issue.code, issue.layer, issue.origin, issue.target])
    .toEqual([direct.code, direct.layer, "EXPANSION_HOLD", null]);
  expect(issue.code).toBe("EXPANSION_HOLD_SAFE_BOUNDARY_UNPROVEN");
});

const FORGED_FIELDS: readonly string[] = [
  "deadline", "generation", "graphEpoch", "holdId", "parentNodeRef", "parentRevisionRef",
  "parentRunRef", "planningRunRef", "proposalBaseHash", "sourceFingerprint",
];

it("generated one forgery case per replayable hold leaf", () => {
  expect(FORGED_FIELDS.length).toBe(10);
});

it.each(FORGED_FIELDS)("refuses a hold whose %s was forged after the reducer produced it",
  (field) => {
    const honest = activeHold();
    const source = honest as unknown as Record<string, unknown>;
    const forged = typeof source[field] === "number"
      ? (source[field] as number) + 1 : `${String(source[field])}.forged`;
    const issue = onlyIssue(refusedWithoutBinding(
      holdRequest({ hold: { ...honest, [field]: forged } }),
    ));
    expect([issue.code, issue.layer, issue.origin, issue.target])
      .toEqual(["EXPANSION_BINDING_HOLD_STATE_MISMATCH", "HOLD", "BRIDGE", null]);
  });

it("refuses a hold whose nested worker handoff was forged", () => {
  const honest = activeHold();
  const workerHandoff = { ...honest.workerHandoff, ref: "handoff:other" };
  const issue = onlyIssue(refusedWithoutBinding(
    holdRequest({ hold: { ...honest, workerHandoff } }),
  ));
  expect([issue.code, issue.layer, issue.target])
    .toEqual(["EXPANSION_BINDING_HOLD_STATE_MISMATCH", "HOLD", null]);
});

// ---------------------------------------------------------------------------
// Current authority: absence is UNKNOWN, disagreement is REFUSED. The two are
// different verdicts and are never allowed to collapse into one another.
// ---------------------------------------------------------------------------

const AUTHORITY_FIELDS: readonly string[] =
  ["goalVersion", "graphEpoch", "holdId", "holdVersion", "planningRunRef"];

it("generated one missing-authority case per current authority field", () => {
  expect(AUTHORITY_FIELDS.length).toBe(5);
});

it.each(AUTHORITY_FIELDS)("holds current authority UNKNOWN when %s is absent", (field) => {
  const current: Record<string, unknown> = { ...CURRENT };
  delete current[field];
  const result = refusedWithoutBinding(holdRequest({ currentAuthority: current }));
  const issue = onlyIssue(result);
  if (result.ok) throw new Error("expected a refusal");
  expect([result.disposition, issue.code, issue.layer, issue.origin, issue.missingInput,
    issue.target]).toEqual([
    "UNKNOWN", "EXPANSION_BINDING_CURRENT_AUTHORITY_UNKNOWN", "CURRENT_AUTHORITY", "BRIDGE",
    "currentAuthority", null,
  ]);
});

const INVALID_AUTHORITY_CASES: readonly (readonly [string, () => unknown])[] = [
  ["a negative goalVersion", () => ({ ...CURRENT, goalVersion: -1 })],
  ["a string goalVersion", () => ({ ...CURRENT, goalVersion: "7" })],
  ["a fractional graphEpoch", () => ({ ...CURRENT, graphEpoch: 1.5 })],
  ["a NaN graphEpoch", () => ({ ...CURRENT, graphEpoch: Number.NaN })],
  ["an empty holdId", () => ({ ...CURRENT, holdId: "" })],
  ["a numeric holdId", () => ({ ...CURRENT, holdId: 7 })],
  ["a negative-zero holdVersion", () => ({ ...CURRENT, holdVersion: -0 })],
  ["a null planningRunRef", () => ({ ...CURRENT, planningRunRef: null })],
  ["an authority with an extra key", () => ({ ...CURRENT, extra: 1 })],
  ["an authority with a symbol key", () => ({ ...CURRENT, [Symbol("hidden")]: 1 })],
  ["an authority carrying an accessor", () => Object.defineProperty(
    { ...CURRENT, goalVersion: 0 }, "goalVersion",
    { configurable: true, enumerable: true, get: () => 7 },
  )],
  ["an authority that is a revoked proxy", revokedProxy],
];

it("generated one invalid-authority case per enumerated perturbation", () => {
  expect(INVALID_AUTHORITY_CASES.length).toBe(12);
  expect(new Set(INVALID_AUTHORITY_CASES.map(([name]) => name)).size).toBe(12);
});

it.each(INVALID_AUTHORITY_CASES)("holds current authority UNKNOWN for %s", (_name, build) => {
  const result = refusedWithoutBinding(holdRequest({ currentAuthority: build() }));
  const issue = onlyIssue(result);
  if (result.ok) throw new Error("expected a refusal");
  // UNKNOWN, never REFUSED: an unreadable authority is the ABSENCE of a verdict.
  expect([result.disposition, issue.code, issue.missingInput, issue.target])
    .toEqual(["UNKNOWN", "EXPANSION_BINDING_CURRENT_AUTHORITY_UNKNOWN", "currentAuthority", null]);
});

const HOLD_MISMATCH_CASES: readonly (readonly [string, () => unknown, string])[] = [
  ["a current graphEpoch the hold was not taken at", () => ({ ...CURRENT, graphEpoch: 12 }),
    "EXPANSION_BINDING_GRAPH_EPOCH_MISMATCH"],
  ["a current holdId naming another hold", () => ({ ...CURRENT, holdId: "hold:expansion:2" }),
    "EXPANSION_BINDING_HOLD_ID_MISMATCH"],
  ["a current holdVersion ahead of the hold", () => ({ ...CURRENT, holdVersion: 2 }),
    "EXPANSION_BINDING_HOLD_VERSION_MISMATCH"],
  ["a current planningRunRef naming another run",
    () => ({ ...CURRENT, planningRunRef: "planning:other" }),
    "EXPANSION_BINDING_PLANNING_RUN_MISMATCH"],
];

it("generated one mismatch case per hold-backed current fact", () => {
  expect(HOLD_MISMATCH_CASES.length).toBe(4);
  expect([...new Set(HOLD_MISMATCH_CASES.map(([, , code]) => code))].length).toBe(4);
});

it.each(HOLD_MISMATCH_CASES)("refuses %s", (_name, build, code) => {
  const result = refusedWithoutBinding(holdRequest({ currentAuthority: build() }));
  const issue = onlyIssue(result);
  if (result.ok) throw new Error("expected a refusal");
  expect([issue.code, issue.layer, issue.origin, issue.missingInput, issue.target,
    result.disposition]).toEqual([code, "CURRENT_AUTHORITY", "BRIDGE", null, null, "REFUSED"]);
  expect(scheduler.EXPANSION_BINDING_ISSUE_CODES).toContain(code as ExpansionBindingIssueCode);
});

/**
 * A TERMINATED hold laundered back to ACTIVE carries no in-band evidence of its own
 * termination: strip the terminal receipt and the value is byte-identical to what the reducer
 * produces for a live hold, so replaying its creation command reconstructs it happily. The
 * DAEMON'S CURRENT HOLD VERSION is what catches it, which is why it is a required input.
 */
it("catches a laundered hold by the daemon's current hold version, not by the value", () => {
  const active = activeHold();
  const terminated = reduceExpansionPlanningHold(active, {
    cause: "EXPANSION_REFUSED", commandId: "command:end", expectedVersion: 1,
    generation: active.generation, graphEpoch: active.graphEpoch, holdId: active.holdId,
    kind: "expansion.transition_hold", parentNodeRef: active.parentNodeRef,
    parentRevisionRef: active.parentRevisionRef, parentRunRef: active.parentRunRef,
    planningRunRef: active.planningRunRef, proposalBaseHash: active.proposalBaseHash,
    sourceFingerprint: active.sourceFingerprint, targetLifecycle: "RESOLVED",
    terminalProof: {
      authorityState: "TERMINAL", decisionRef: "decision:1", successorHoldRef: null,
      truthClass: "DAEMON_VERIFIED",
    },
  });
  if (!terminated.ok) throw new Error(`could not terminate: ${terminated.code}`);
  const honest = onlyIssue(refusedWithoutBinding(holdRequest({ hold: terminated.state })));
  expect([honest.code, honest.layer]).toEqual(["EXPANSION_BINDING_HOLD_INACTIVE", "HOLD"]);
  const laundered = { ...terminated.state, lifecycle: "ACTIVE", version: 1, terminalReceipt: null };
  const issue = onlyIssue(refusedWithoutBinding({
    currentAuthority: { ...CURRENT, holdVersion: 2 }, hold: laundered,
  }));
  expect([issue.code, issue.layer])
    .toEqual(["EXPANSION_BINDING_HOLD_VERSION_MISMATCH", "CURRENT_AUTHORITY"]);
});

// ---------------------------------------------------------------------------
// The core planning-expansion inspector: the ONE surface whose target this
// module copies verbatim rather than minting.
// ---------------------------------------------------------------------------

/**
 * `goalVersion` 0 is a legal scheduler count and an ILLEGAL planning binding version, so it is
 * the one input separating "the bridge built a binding" from "core accepts the binding built".
 */
it("delegates a derived binding core refuses, preserving core's code, layer and target", () => {
  const result = refusedWithoutBinding(
    holdRequest({ currentAuthority: { ...CURRENT, goalVersion: 0 } }),
  );
  const issue = onlyIssue(result);
  const direct = inspectPlanningExpansionContract("HOLD_BINDING", { ...EXPECTED_BINDING, goalVersion: 0 });
  expect(direct.ok).toBe(false);
  if (direct.ok) throw new Error("expected a refusal");
  // Every field compared against the SAME inspector called directly — including `target`,
  // which is COPIED and never derived from the code or the layer.
  expect([issue.code, issue.layer, issue.target, issue.origin, issue.missingInput])
    .toEqual([direct.code, direct.layer, direct.target, "PLANNING_CONTRACT", null]);
  expect([issue.code, issue.target])
    .toEqual(["PLANNING_EXPANSION_HOLD_BINDING_INVALID", "HOLD_BINDING"]);
  expect(validExpansionHoldBinding({ ...EXPECTED_BINDING, goalVersion: 0 })).toBe(false);
});

// ---------------------------------------------------------------------------
// Root reachability: the runtime bridge and the bare-specifier consumer edge.
// ---------------------------------------------------------------------------

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

it("publishes exactly the one-line LF runtime bridge beside the module", () => {
  const bridge = readFileSync(
    resolve(PACKAGE_ROOT, "src/expansion/expansion-current-hold.js"), "utf8",
  );
  expect(bridge).toBe('export * from "./expansion-current-hold.ts";\n');
});

const execFileAsync = promisify(execFile);

/**
 * cwd is the package root so the bare specifier resolves through this package's own `exports`
 * map via Node's self-reference rule — the exact resolution a real daemon consumer gets. The
 * child is killed on timeout rather than left to outlive the run.
 */
it("is reachable and callable from plain Node through the bare package specifier", async () => {
  const source = `
const report = (value) => process.stdout.write(JSON.stringify(value));
const ns = await import("@moe/scheduler");
const hold = ns.bindCurrentExpansionHold(null);
report({ kind: typeof ns.bindCurrentExpansionHold, ok: hold.ok, code: hold.issues[0].code,
  target: hold.issues[0].target });
`;
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", source],
    { cwd: PACKAGE_ROOT, shell: false, timeout: 20_000 },
  );
  expect(JSON.parse(stdout) as unknown).toEqual({
    kind: "function", ok: false, code: "EXPANSION_BINDING_REQUEST_MALFORMED", target: null,
  });
}, 30_000);
