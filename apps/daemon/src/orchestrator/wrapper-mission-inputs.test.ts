import { afterEach, expect, it } from "vitest";

import type { SqliteEventStore } from "@moe/store";

import { submitDesignRevision } from "../design/design-store.js";
import {
  designRevisionFixture, designSkipFixture, secondDesignRevisionFixture,
} from "../design/design-test-fixtures.js";
import {
  GOAL_ID, PROJECT_ID, RUN_ID, approveGate1, approvePlan, boundWorld, closeStores,
  committedRevision, submit,
} from "../planning/plan-reject-test-fixtures.js";
import type { NodeMission } from "./agent-wrapper.js";
import { codeMission, compilerMission } from "./agent-mission-text.js";
import { activeCompiledGraphs } from "./compiled-node-source.js";
import type { ActiveCompiledGraph } from "./compiled-node-source.js";
import { compiledExecutionRef } from "./compiled-execution-ref.js";
import { createDesignBriefResolver } from "./wrapper-mission-inputs.js";

/**
 * THE COMPOSITION, NOT A HAND-BUILT BRIEF.
 *
 * `agent-mission-text.test.ts` builds a `DesignBrief` by hand and calls the paragraph builders
 * directly. Those 42 arms were all green while NO production caller supplied `designBrief` at
 * all, so every live compiler seat read "NO DESIGN ACCOMPANIES THIS BRIEF" over a goal whose
 * design was durably present. That is the blind spot this file closes: every arm here drives the
 * REAL resolver against a REAL `SqliteEventStore` carrying REAL submitted design records, and
 * asserts THE ACTUAL MISSION BYTES a seat would receive — never a value handed to the builder.
 */

afterEach(closeStores);

const EXPIRES = "2026-09-07T00:00:00.000Z";
const DECOMPOSITION = "planning.submit_decomposition";
/** A code step's kind is not in `COMPILER_STEPS`, which is what selects the node lane. */
const CODE_KIND = "review.submit";
const NODE: NodeMission = {
  instructions: "Land the record read and its page.",
  test: "pnpm test", title: "node-slice", workspace: "/w",
};

/** Gate 1 approved, a plan compiled and APPROVED, so the goal is execution-enabled. */
function plannedWorld(): { readonly ref: ReturnType<typeof committedRevision>; readonly store: SqliteEventStore } {
  const store = boundWorld();
  const ref = committedRevision(store);
  approveGate1(store, ref);
  return { ref, store };
}

function design(
  store: SqliteEventStore, ref: ReturnType<typeof committedRevision>,
  version: number, revision: unknown,
): void {
  const result = submitDesignRevision(store, {
    commandId: `design-${String(version)}`, contractRef: ref,
    correlationId: `design-${String(version)}`, decidedAt: "2026-09-05T09:00:00.000Z",
    expectedVersion: version - 1, goalRef: GOAL_ID, principalId: "designer-agent",
    projectId: PROJECT_ID, revision,
  });
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
}

/** The bytes a PLANNING seat would receive, resolved exactly as `agent-wrapper.ts:302` does. */
function compilerBytes(store: SqliteEventStore | undefined, target: string | null = GOAL_ID): string {
  const resolve = createDesignBriefResolver({ projectId: PROJECT_ID, store });
  return compilerMission("work-1", DECOMPOSITION, EXPIRES, target, null, null, PROJECT_ID,
    resolve(DECOMPOSITION, target));
}

/** The bytes a CODING seat would receive, resolved exactly as `agent-wrapper.ts:289` does. */
function nodeBytes(
  store: SqliteEventStore, nodeRef: string,
  readActive?: (store: SqliteEventStore, projectId: string) => readonly ActiveCompiledGraph[],
): string {
  const resolve = createDesignBriefResolver({
    projectId: PROJECT_ID, store, ...(readActive === undefined ? {} : { readActive }),
  });
  return codeMission("work-1", nodeRef, EXPIRES, NODE, { accept: null, submit: null },
    PROJECT_ID, resolve(CODE_KIND, nodeRef));
}

/** Compiles and approves the plan, then answers the sealed nodeRef a real seat would be staffed on. */
function activeNodeRef(store: SqliteEventStore, ref: ReturnType<typeof committedRevision>): string {
  const sealed = submit(store, ref);
  if (!sealed.ok) throw new Error(`${sealed.code}@${String(sealed.layer)}`);
  approvePlan(store, RUN_ID);
  const graph = activeCompiledGraphs(store, PROJECT_ID)[0];
  if (graph === undefined) throw new Error("fixture produced no active compiled graph");
  return compiledExecutionRef(PROJECT_ID, graph, "node-slice");
}

it("emits the design paragraph with the real design ref when a design is durably PRESENT", () => {
  const { ref, store } = plannedWorld();
  design(store, ref, 1, designRevisionFixture());
  const text = compilerBytes(store);
  expect(text).toContain(`A DESIGN EXISTS for this goal, submitted under design ref "${GOAL_ID}@v1"`);
  expect(text).toContain("Plan the decomposition FROM it");
  // The unwired-caller sentence is what every real seat read before this row.
  expect(text).not.toContain("NO DESIGN ACCOMPANIES");
});

it("names REAL entities and screens from the stored record in the coding brief", () => {
  const { ref, store } = plannedWorld();
  design(store, ref, 1, designRevisionFixture());
  const text = nodeBytes(store, activeNodeRef(store, ref));
  // Read off the fixture record rather than retyped, so a fixture edit cannot leave this green
  // while asserting a name the design no longer draws.
  const revision = designRevisionFixture();
  const entity = revision.dataModel[0]!.entity;
  const screen = revision.screens[0]!.screens[0]!.screen;
  expect(entity).toBe("User");
  expect(text).toContain(`part of the design submitted under "${GOAL_ID}@v1"`);
  expect(text).toContain(`entities ${entity}`);
  expect(text).toContain(`screens ${screen}`);
  expect(text).not.toContain("No design accompanies this brief");
});

it("emits the operator's declared skip and never the unwired-caller sentence", () => {
  const { ref, store } = plannedWorld();
  design(store, ref, 1, designSkipFixture());
  const text = compilerBytes(store);
  expect(text).toContain("NO DESIGN EXISTS for this goal BECAUSE THE DESIGN STEP WAS SKIPPED");
  expect(text).toContain(`stating "${designSkipFixture().reason}"`);
  expect(text).toContain("do not wait for a design that is never coming");
  expect(text).not.toContain("NO DESIGN ACCOMPANIES");
});

it("keeps today's ABSENT sentence verbatim when the goal truly has no design", () => {
  const { store } = plannedWorld();
  const text = compilerBytes(store);
  expect(text).toContain(
    "NO DESIGN ACCOMPANIES THIS BRIEF, and the operator has not declared that it plans without one.",
  );
  expect(text).not.toContain("A DESIGN EXISTS");
  expect(text).not.toContain("COULD NOT BE READ");
});

it("says UNREADABLE with its code AND its layer, distinguishably from ABSENT", () => {
  const { store } = plannedWorld();
  // The design aggregate alone is made unreadable; every other read still works, so the arm
  // measures the design path rather than a broken store.
  const blinded = new Proxy(store, {
    get(target, key) {
      if (key === "readEvents") {
        return (aggregateId: string) => {
          if (aggregateId === `design:${GOAL_ID}`) throw new Error("design aggregate unavailable");
          return target.readEvents(aggregateId);
        };
      }
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as SqliteEventStore;
  const text = compilerBytes(blinded);
  expect(text).toContain("THE DESIGN STATE FOR THIS GOAL COULD NOT BE READ");
  expect(text).toContain("DESIGN_STORE_UNAVAILABLE");
  expect(text).toContain("answered by the LEDGER layer");
  expect(text).toContain("THAT IS A FAILED READ, NOT A GOAL WITHOUT A DESIGN");
  // The whole point of the fourth outcome: it is not the ABSENT sentence.
  expect(text).not.toContain("NO DESIGN ACCOMPANIES");
});

it("refuses a node whose planned binding cannot be read instead of calling it ABSENT", () => {
  const { ref, store } = plannedWorld();
  design(store, ref, 1, designRevisionFixture());
  activeNodeRef(store, ref);
  const graph = activeCompiledGraphs(store, PROJECT_ID)[0]!;
  // The same sealed body under a run ref that bound nothing — the shape a plan whose
  // `CompiledContractBound` leg is missing presents. `readDesignRevision` answers
  // DESIGN_RECORD_MALFORMED, which is a failed read and must NOT collapse to ABSENT.
  const orphaned = { ...graph, planningRunRef: "run-never-compiled" };
  // Derived from the ORPHANED graph, because the run ref is part of the ref's own hash tuple:
  // reusing the real nodeRef here would simply fail to resolve and assert nothing.
  const orphanedRef = compiledExecutionRef(PROJECT_ID, orphaned, "node-slice");
  expect(orphanedRef).not.toBe(compiledExecutionRef(PROJECT_ID, graph, "node-slice"));
  const text = nodeBytes(store, orphanedRef, () => [orphaned]);
  expect(text).toContain("The design state for your goal could not be read");
  expect(text).toContain("DESIGN_RECORD_MALFORMED");
  expect(text).toContain("answered by the LEDGER layer");
  expect(text).toContain("record in your report that the design was UNREADABLE rather than missing");
  expect(text).not.toContain("No design accompanies this brief");
});

it("carries the PLANNED design version into a node mission while the compiler reads LATEST", () => {
  const { ref, store } = plannedWorld();
  design(store, ref, 1, designRevisionFixture());
  // Compile against version 1, THEN publish version 2. A "latest" read would answer @v2 here.
  const nodeRef = activeNodeRef(store, ref);
  design(store, ref, 2, secondDesignRevisionFixture());

  const node = nodeBytes(store, nodeRef);
  expect(node).toContain(`${GOAL_ID}@v1`);
  expect(node).not.toContain(`${GOAL_ID}@v2`);
  // Version 2 adds the Session entity; the node must not cite what its plan never saw.
  expect(node).not.toContain("Session");

  // The compiler seat is staffed BEFORE a plan exists, so it plans from the CURRENT design.
  const compiler = compilerBytes(store);
  expect(compiler).toContain(`${GOAL_ID}@v2`);
  expect(compiler).not.toContain(`${GOAL_ID}@v1"`);
});

it("resolves a sealed nodeRef to its goal through activeCompiledGraphs, and no other ref", () => {
  const { ref, store } = plannedWorld();
  design(store, ref, 1, designRevisionFixture());
  const nodeRef = activeNodeRef(store, ref);
  const resolve = createDesignBriefResolver({ projectId: PROJECT_ID, store });

  expect(resolve(CODE_KIND, nodeRef)).toMatchObject({ outcome: "PRESENT", ref: `${GOAL_ID}@v1` });
  // An unknown nodeRef is the ONE legitimate null: the caller knows nothing, and says nothing.
  expect(resolve(CODE_KIND, "node:v1:" + "0".repeat(64))).toBeNull();
  expect(codeMission("w", "node-x", EXPIRES, NODE, { accept: null, submit: null }, PROJECT_ID,
    resolve(CODE_KIND, "node:v1:" + "0".repeat(64)))).not.toContain("design");
});

it("answers null rather than ABSENT before the wrapper has a store handle", () => {
  // Composition-time guard: `verifierStore` is assigned after the options object is built in
  // some orderings, and a resolver that threw there would take the whole binary down.
  const resolve = createDesignBriefResolver({ projectId: PROJECT_ID, store: undefined });
  expect(resolve(DECOMPOSITION, GOAL_ID)).toBeNull();
  const { store } = plannedWorld();
  expect(createDesignBriefResolver({ projectId: PROJECT_ID, store })(DECOMPOSITION, null)).toBeNull();
});
