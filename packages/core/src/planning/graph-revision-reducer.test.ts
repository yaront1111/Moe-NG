import { RUNTIME_LIFECYCLES } from "@moe/contracts";
import { describe, expect, it } from "vitest";

import type {
  GraphRevisionCommand,
  GraphRevisionLifecycle,
  GraphRevisionState,
} from "./graph-revision-contract.js";
import {
  GRAPH_REVISION_COMMAND_KINDS,
  GRAPH_REVISION_TRANSITIONS,
  reduceGraphRevision,
} from "./graph-revision-reducer.js";
import {
  ACTIVATION,
  APPROVAL,
  BINDING,
  GRAPH_HASH,
  PLAN_HASH,
  STALE_HASH,
  SUBMISSION,
  accepted,
  commandFor,
  expectError,
  expectIllegal,
  state,
} from "./graph-revision-test-fixtures.js";

describe("graph revision creation and submission", () => {
  it("creates an immutable draft whose content identity is fixed forever", () => {
    const result = reduceGraphRevision(undefined, commandFor("graph_revision.create", 0));
    expect(accepted(result)).toEqual(state("DRAFT", { version: 1 }));
    expect(result.ok && result.events).toEqual([{
      commandId: "cmd-graph_revision.create", goalRef: "goal-1", graphContentHash: GRAPH_HASH,
      kind: "GraphRevisionCreated", planHash: PLAN_HASH, revisionId: "graph-revision-1",
      version: 1,
    }]);
  });

  it("fails closed on malformed creation input", () => {
    expectError(reduceGraphRevision(undefined, commandFor("graph_revision.create", 1)),
      "UNKNOWN_ERROR");
    expectError(reduceGraphRevision(undefined, { ...commandFor("graph_revision.create", 0),
      graphContentHash: "nothex" } as GraphRevisionCommand), "UNKNOWN_ERROR");
    expectError(reduceGraphRevision(undefined, commandFor("graph_revision.submit", 0)),
      "UNKNOWN_ERROR");
  });

  it("submits a draft for approval and keeps content untouched", () => {
    const next = accepted(reduceGraphRevision(state("DRAFT"),
      commandFor("graph_revision.submit")));
    expect(next).toMatchObject({ graphContentHash: GRAPH_HASH, lifecycle: "PENDING_APPROVAL",
      planHash: PLAN_HASH, submissionRef: "submission-1", version: 8 });
    const weak = { ...commandFor("graph_revision.submit"),
      witness: { ...SUBMISSION, truthClass: "AGENT_REPORTED" } } as GraphRevisionCommand;
    expectIllegal(reduceGraphRevision(state("DRAFT"), weak), "graph_revision.submit", "DRAFT");
  });
});

describe("graph revision approval and activation", () => {
  it("binds the full design-528 hash set on approval", () => {
    const next = accepted(reduceGraphRevision(state("PENDING_APPROVAL"),
      commandFor("graph.approve")));
    expect(next).toMatchObject({ lifecycle: "APPROVED", version: 8 });
    expect(next.boundHashes).toEqual(BINDING);
  });

  it("rebounds an approval whose graph hash is not this revision's sealed content", () => {
    const source = state("PENDING_APPROVAL");
    const before = JSON.stringify(source);
    const stale = { ...commandFor("graph.approve"),
      approval: { ...APPROVAL, graphHash: STALE_HASH } } as GraphRevisionCommand;
    expectError(reduceGraphRevision(source, stale), "REVISION_REBOUND");
    expect(JSON.stringify(source)).toBe(before);
  });

  it("records the canonical compound approval and activation in one result", () => {
    const compound = { ...commandFor("graph.approve"), activation: ACTIVATION };
    const result = reduceGraphRevision(state("PENDING_APPROVAL"),
      compound as GraphRevisionCommand);
    const next = accepted(result);
    expect(next).toMatchObject({ lifecycle: "ACTIVE", version: 9 });
    expect(result.ok && result.events.map((event) => event.kind))
      .toEqual(["GraphRevisionApproved", "GraphRevisionActivated"]);
    expect(result.ok && result.events.map((event) => event.version)).toEqual([8, 9]);
  });

  it("rebounds a compound decision whose activation disagrees with its own approval", () => {
    const source = state("PENDING_APPROVAL");
    const before = JSON.stringify(source);
    const split = { ...commandFor("graph.approve"),
      activation: { ...ACTIVATION, budgetHash: STALE_HASH } };
    expectError(reduceGraphRevision(source, split as GraphRevisionCommand), "REVISION_REBOUND");
    expect(JSON.stringify(source)).toBe(before);
  });

  it("activates an approved revision and carries the goal composition reference", () => {
    const single = { commandId: "cmd-activate", expectedVersion: 7, kind: "graph.approve",
      activation: ACTIVATION };
    const result = reduceGraphRevision(state("APPROVED"), single as GraphRevisionCommand);
    expect(accepted(result)).toMatchObject({ lifecycle: "ACTIVE", version: 8 });
    expect(result.ok && result.events).toEqual([{ commandId: "cmd-activate",
      expectedGoalVersion: 3, goalRef: "goal-1", kind: "GraphRevisionActivated", version: 8,
      witness: ACTIVATION }]);
  });

  it("rebounds stale approval bytes at activation with zero state change", () => {
    const source = state("APPROVED");
    const before = JSON.stringify(source);
    for (const key of ["budgetHash", "policyHash", "qualityHash"] as const) {
      const command = { commandId: "cmd-activate", expectedVersion: 7, kind: "graph.approve",
        activation: { ...ACTIVATION, [key]: STALE_HASH } };
      expectError(reduceGraphRevision(source, command as GraphRevisionCommand),
        "REVISION_REBOUND");
      expect(JSON.stringify(source)).toBe(before);
    }
    const drifted = { commandId: "cmd-activate", expectedVersion: 7, kind: "graph.approve",
      activation: { ...ACTIVATION, expectedGoalVersion: 4 } };
    expectError(reduceGraphRevision(source, drifted as GraphRevisionCommand), "REVISION_REBOUND");
  });

  it("refuses an approval decision on an already approved revision", () => {
    expectIllegal(reduceGraphRevision(state("APPROVED"), commandFor("graph.approve")),
      "graph.approve", "APPROVED");
    const bare = { commandId: "cmd-approve", expectedVersion: 7, kind: "graph.approve" };
    expectIllegal(reduceGraphRevision(state("PENDING_APPROVAL"), bare as GraphRevisionCommand),
      "graph.approve", "PENDING_APPROVAL");
  });
});

describe("graph revision refusal and terminal authority", () => {
  it("rejects a revision before activation from every pre-active state", () => {
    for (const lifecycle of ["DRAFT", "PENDING_APPROVAL", "APPROVED"] as const) {
      const next = accepted(reduceGraphRevision(state(lifecycle),
        commandFor("graph_revision.reject")));
      expect(next).toMatchObject({ graphContentHash: GRAPH_HASH, lifecycle: "REJECTED",
        planHash: PLAN_HASH, version: 8 });
    }
    expectIllegal(reduceGraphRevision(state("ACTIVE"), commandFor("graph_revision.reject")),
      "graph_revision.reject", "ACTIVE");
  });

  it("never moves an active revision backward and never mutates its content", () => {
    let refused = 0;
    for (const kind of GRAPH_REVISION_COMMAND_KINDS) {
      if (kind === "graph.supersede") continue;
      expectIllegal(reduceGraphRevision(state("ACTIVE"), commandFor(kind)), kind, "ACTIVE");
      refused += 1;
    }
    expect(refused).toBe(GRAPH_REVISION_COMMAND_KINDS.length - 1);
    const forward = accepted(reduceGraphRevision(state("ACTIVE"), commandFor("graph.supersede")));
    expect(forward).toMatchObject({ lifecycle: "SUPERSEDED", version: 8 });
    const mutation = { ...commandFor("graph_revision.submit"), graphContentHash: STALE_HASH,
      planHash: STALE_HASH };
    const next = accepted(reduceGraphRevision(state("DRAFT"), mutation as GraphRevisionCommand));
    expect(next).toMatchObject({ graphContentHash: GRAPH_HASH, planHash: PLAN_HASH });
  });

  it("returns SUPERSEDED_AUTHORITY, not a degraded code, from a superseded revision", () => {
    for (const kind of GRAPH_REVISION_COMMAND_KINDS) {
      expectError(reduceGraphRevision(state("SUPERSEDED"), commandFor(kind)),
        "SUPERSEDED_AUTHORITY");
    }
  });
});

describe("graph revision concurrency", () => {
  it("uses ILLEGAL_TRANSITION for a missing command identity because the registry forbids"
    + " IDEMPOTENCY_CONFLICT from this aggregate", () => {
    const anonymous = { ...commandFor("graph_revision.submit"), commandId: "" };
    expectIllegal(reduceGraphRevision(state("DRAFT"), anonymous as GraphRevisionCommand),
      "graph_revision.submit", "DRAFT");
  });

  it("separates version conflicts from malformed versions and unknown commands", () => {
    expectError(reduceGraphRevision(state("DRAFT"), commandFor("graph_revision.submit", 6)),
      "EXPECTED_VERSION_CONFLICT", { actualVersion: 7, expectedVersion: 6 });
    expectIllegal(reduceGraphRevision(state("DRAFT"), commandFor("graph_revision.submit", 1.5)),
      "graph_revision.submit", "DRAFT");
    expectError(reduceGraphRevision(null as unknown as GraphRevisionState,
      commandFor("graph_revision.submit")), "UNKNOWN_ERROR");
    expectError(reduceGraphRevision(state("DRAFT"),
      { ...commandFor("graph_revision.submit"), kind: "graph.unknown" } as unknown as
        GraphRevisionCommand), "UNKNOWN_ERROR");
    const badContent = { ...state("DRAFT"), graphContentHash: "nothex" } as GraphRevisionState;
    expectError(reduceGraphRevision(badContent, commandFor("graph_revision.submit")),
      "UNKNOWN_ERROR");
  });

  it("guards the version ceiling including the compound activation delta", () => {
    const last = Number.MAX_SAFE_INTEGER - 1;
    const compound = { ...commandFor("graph.approve", last), activation: ACTIVATION };
    expectIllegal(reduceGraphRevision(state("PENDING_APPROVAL", { version: last }),
      compound as GraphRevisionCommand), "graph.approve", "PENDING_APPROVAL");
    const single = { commandId: "cmd-activate", expectedVersion: Number.MAX_SAFE_INTEGER,
      kind: "graph.approve", activation: ACTIVATION };
    expectIllegal(reduceGraphRevision(state("APPROVED", { version: Number.MAX_SAFE_INTEGER }),
      single as GraphRevisionCommand), "graph.approve", "APPROVED");
  });

  it("covers every command kind against every lifecycle", () => {
    const seen = new Set<string>();
    for (const kind of GRAPH_REVISION_COMMAND_KINDS) {
      const allowed: readonly GraphRevisionLifecycle[] = GRAPH_REVISION_TRANSITIONS[kind];
      for (const lifecycle of RUNTIME_LIFECYCLES.GRAPH_REVISION) {
        seen.add(`${kind}:${lifecycle}`);
        const result = reduceGraphRevision(state(lifecycle), commandFor(kind));
        if (allowed.includes(lifecycle) && lifecycle !== "SUPERSEDED") continue;
        if (lifecycle === "SUPERSEDED") {
          expectError(result, "SUPERSEDED_AUTHORITY");
          continue;
        }
        expectIllegal(result, kind, lifecycle);
      }
    }
    expect(seen.size)
      .toBe(GRAPH_REVISION_COMMAND_KINDS.length * RUNTIME_LIFECYCLES.GRAPH_REVISION.length);
  });
});
