/**
 * The node brief, graded against a world PRODUCTION writers built and against the REAL consumer.
 *
 * No brief in this file is hand-built. Every accepted arm asks `produceNodeBrief` for one, and
 * the composition arm feeds that answer straight into the shipped `produceLaunchTemplateFields`
 * — the consumer this row exists to satisfy — so what is proven is that the four keys and their
 * string types genuinely satisfy MISSION_KEYS, not that this file can restate MISSION_KEYS.
 *
 * A PRIOR AUDIT FOUND THE CONSUMER ACCEPTS FOUR EMPTY STRINGS. So `ok: true` alone is a vacuous
 * control here: the composition arm also traces every member back to the durable record it came
 * from, read through the production readers rather than compared to a literal this file chose.
 *
 * Layers are asserted as LITERALS rather than imported constants: a test that imports the
 * constant it asserts stays green after that constant is renamed out from under every consumer.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SqliteEventStore } from "@moe/store";

import { produceLaunchTemplateFields } from "../work/launch-template-producer.js";
import { nodeClosureOf, readCurrentNodeClosure } from "./node-closure-reader.js";
import type { NodeClosureResult } from "./node-closure-reader.js";
import {
  NODE_BRIEF_PRODUCER_CODES, admitBriefWorkspace, briefProseOf, produceNodeBrief,
} from "./node-mission-producer.js";
import type {
  NodeBriefRefusal, NodeBriefRequest, NodeBriefResult, NodeBriefWorkspaceResult,
} from "./node-mission-producer.js";
import {
  ABSENT_NODE_KEY, CATALOG_ARGV, CATALOG_TEST_STRING, NODE_CAPABILITY, NODE_KEY, PROJECT_ID,
  SOURCE_ROOT, activeGraphStore, capabilities, catalogEntry, catalogReader, closeStores, depsFor,
  foreignCatalogReader, inactiveGraphStore, renderedContext, repositoryScopeFor, RUNTIME_FACTS,
  scopeCatalogEntry,
} from "./node-mission-test-fixtures.js";

const PRODUCER_LAYER = "NODE_MISSION_PRODUCER";
const CLOSURE_LAYER = "NODE_CLOSURE_READER";
const PROJECTION_LAYER = "ACTIVE_GRAPH_PROJECTION";
const CATALOG_LAYER = "DAEMON_VERIFICATION_CATALOG";
const SCOPE_LAYER = "DAEMON_REPOSITORY_SCOPE_RESOLUTION";

const MODULE_SOURCE = fileURLToPath(new URL("./node-mission-producer.ts", import.meta.url));

/**
 * IMMUTABLE ROSTER with an EXACT count, and the second half of a bidirectional check: every
 * published code is covered by a named arm below, and no arm asserts a code the module does not
 * publish. Deleting a member of either side reds this; `length > 0` would not.
 *
 * All seven are driven through `produceNodeBrief`. The objective arm holds the readable closure
 * fixed at its direct dependency seam while varying only the admissible durable objective; that
 * pins this producer's exact refusal without redundantly re-sealing the full activation journey.
 */
const DRIVEN_CODES = Object.freeze([
  "NODE_MISSION_GRAPH_UNAVAILABLE",
  "NODE_MISSION_NODE_ABSENT",
  "NODE_MISSION_OBJECTIVE_UNUSABLE",
  "NODE_MISSION_REQUEST_MALFORMED",
  "NODE_MISSION_TEST_UNAVAILABLE",
  "NODE_MISSION_WORKSPACE_DISAGREEMENT",
  "NODE_MISSION_WORKSPACE_UNAVAILABLE",
] as const);

const CLOSURE_OVERRIDE = vi.hoisted((): { current: NodeClosureResult | null } => ({
  current: null,
}));

vi.mock("./node-closure-reader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./node-closure-reader.js")>();
  return {
    ...actual,
    readCurrentNodeClosure: (...args: Parameters<typeof actual.readCurrentNodeClosure>) =>
      CLOSURE_OVERRIDE.current ?? actual.readCurrentNodeClosure(...args),
  };
});

function refusalOf(result: NodeBriefResult | NodeBriefWorkspaceResult): NodeBriefRefusal {
  if (result.ok) throw new Error("expected a refusal, got an accepted answer");
  return result;
}

function acceptedBriefOf(store: SqliteEventStore, nodeKey: string = NODE_KEY): {
  readonly brief: Record<string, unknown>;
  readonly result: NodeBriefResult;
} {
  const result = produceNodeBrief(depsFor(store), { nodeKey, projectId: PROJECT_ID });
  if (!result.ok) {
    throw new Error(`expected a brief, got ${result.code}@${result.layer}`);
  }
  return { brief: result.brief as unknown as Record<string, unknown>, result };
}

/** The node's objective as the PRODUCTION readers hand it back — never a literal from here. */
function durableObjective(store: SqliteEventStore, nodeKey: string = NODE_KEY): string {
  const closure = readCurrentNodeClosure(store, PROJECT_ID);
  if (!closure.ok) throw new Error(`fixture closure refused: ${closure.code}`);
  const entry = nodeClosureOf(closure, nodeKey);
  if (!entry.ok) throw new Error(`fixture node missing: ${entry.code}`);
  return entry.definition.objective;
}

describe("node mission producer (task-d8bb8a98)", () => {
  afterEach(() => {
    CLOSURE_OVERRIDE.current = null;
    closeStores();
  });

  it("names no filesystem read and no shared-tree brief anywhere in its source", () => {
    const source = readFileSync(MODULE_SOURCE, "utf8");

    // The grep proves nothing against an empty read, so the denominator is pinned first.
    expect(source.length).toBeGreaterThan(2_000);
    expect(source).toContain("export function produceNodeBrief");
    expect(/node:fs|readFile/u.test(source)).toBe(false);
    expect(/NodeMission|nodeMission|nodeSpecsDir/u.test(source)).toBe(false);
  });

  it("produces a brief the REAL launch-template producer admits on the first try", () => {
    const store = activeGraphStore();
    const { brief } = acceptedBriefOf(store);

    const produced = produceLaunchTemplateFields({
      capabilities: capabilities(),
      mission: brief,
      renderedContext: renderedContext(),
      runtimeObservation: RUNTIME_FACTS,
    });

    expect(produced.ok, produced.ok ? "" : `${produced.code}`).toBe(true);
    // The four keys, exactly, in the consumer's own spelling: a fifth would have refused above.
    expect(Object.keys(brief).sort()).toStrictEqual(["instructions", "test", "title", "workspace"]);
    expect(Object.values(brief).every((value) => typeof value === "string")).toBe(true);
    // THIS ARM IS NOT ALLOWED TO BE VACUOUS ON ITS OWN. The consumer admits four EMPTY strings,
    // so ok:true is carried here by content too, not only by the sibling derivation arm.
    expect(Object.values(brief).every((value) => (value as string).length > 0)).toBe(true);
    expect(brief["instructions"]).toBe(durableObjective(store));
  });

  it("derives every member from a durable record rather than a placeholder", () => {
    const store = activeGraphStore();
    const { brief, result } = acceptedBriefOf(store);
    const objective = durableObjective(store);
    const scope = repositoryScopeFor(store)();
    if (!scope.ok) throw new Error(`fixture scope refused: ${scope.code}`);

    // Four empty strings satisfy the consumer, so emptiness is asserted against, not assumed.
    expect(Object.values(brief).every((value) => (value as string).length > 0)).toBe(true);
    expect(brief["instructions"]).toBe(objective);
    expect(brief["title"]).toBe(briefProseOf(objective)?.title);
    expect(brief["test"]).toBe(CATALOG_ARGV.join(" "));
    expect(brief["workspace"]).toBe(scope.authority.sourceRepositoryRoot);
    expect(brief["workspace"]).toBe(SOURCE_ROOT);
    if (!result.ok) throw new Error("unreachable");
    expect(result.capability).toBe(NODE_CAPABILITY);
    expect(result.nodeKey).toBe(NODE_KEY);
    expect(result.graphContentHash.length).toBe(64);
  });

  it("sources `test` from the named catalog entry through the catalog's own published mapping", () => {
    const { brief } = acceptedBriefOf(activeGraphStore());

    expect(brief["test"]).toBe(CATALOG_TEST_STRING);
  });

  it("refuses TEST_UNAVAILABLE, under the catalog's own code, when the project has no entry", () => {
    const store = activeGraphStore();

    const refusal = refusalOf(produceNodeBrief(
      depsFor(store, { catalog: foreignCatalogReader() }), { nodeKey: NODE_KEY, projectId: PROJECT_ID }));

    expect(refusal.code).toBe("NODE_MISSION_TEST_UNAVAILABLE");
    expect(refusal.layer).toBe(PRODUCER_LAYER);
    // Unrestamped: a reader can tell the catalog refused, and with which of its six repairs.
    expect(refusal.upstream?.code).toBe("VERIFICATION_CATALOG_PROJECT_ABSENT");
    expect(refusal.upstream?.layer).toBe(CATALOG_LAYER);
  });

  it("refuses TEST_UNAVAILABLE with ENTRY_ABSENT when the project is named but the capability is not", () => {
    const store = activeGraphStore();
    const catalog = catalogReader([catalogEntry({ capability: "capability-elsewhere" })]);

    const refusal = refusalOf(produceNodeBrief(
      depsFor(store, { catalog }), { nodeKey: NODE_KEY, projectId: PROJECT_ID }));

    expect(refusal.code).toBe("NODE_MISSION_TEST_UNAVAILABLE");
    expect(refusal.upstream?.code).toBe("VERIFICATION_CATALOG_ENTRY_ABSENT");
    expect(refusal.upstream?.layer).toBe(CATALOG_LAYER);
  });

  it("refuses REQUEST_MALFORMED, minted here, when no node is named", () => {
    const store = activeGraphStore();
    const deps = depsFor(store);

    const refusal = refusalOf(produceNodeBrief(deps, { nodeKey: "", projectId: PROJECT_ID }));

    expect(refusal.code).toBe("NODE_MISSION_REQUEST_MALFORMED");
    expect(refusal.layer).toBe(PRODUCER_LAYER);
    expect(refusal.upstream).toBeNull();
    // A caller arriving with nothing gets the same repair rather than a thrown TypeError: a
    // crash is not a refusal, and a caller holding one has been told nothing.
    const hostile = refusalOf(produceNodeBrief(deps, null as unknown as NodeBriefRequest));
    expect(hostile.code).toBe("NODE_MISSION_REQUEST_MALFORMED");
    expect(hostile.layer).toBe(PRODUCER_LAYER);
  });

  it("refuses GRAPH_UNAVAILABLE, naming both layers below it, when no graph is ACTIVE", () => {
    const store = inactiveGraphStore();

    const refusal = refusalOf(produceNodeBrief(
      depsFor(store), { nodeKey: NODE_KEY, projectId: PROJECT_ID }));

    expect(refusal.code).toBe("NODE_MISSION_GRAPH_UNAVAILABLE");
    expect(refusal.layer).toBe(PRODUCER_LAYER);
    expect(refusal.upstream?.code).toBe("ACTIVE_GRAPH_ABSENT");
    expect(refusal.upstream?.layer).toBe(CLOSURE_LAYER);
    expect(refusal.upstream?.sourceLayer).toBe(PROJECTION_LAYER);
  });

  it("refuses NODE_ABSENT for a key the graph does not carry, substituting no neighbour", () => {
    const store = activeGraphStore();
    const closure = readCurrentNodeClosure(store, PROJECT_ID);
    if (!closure.ok) throw new Error(`fixture closure refused: ${closure.code}`);

    // The substitution OPPORTUNITY is pinned: the graph really does carry a definition this
    // producer could have handed back instead of refusing. Without this the arm is vacuous.
    expect(closure.definitions).toHaveLength(1);
    expect(closure.definitions[0]?.nodeKey).toBe(NODE_KEY);

    const result = produceNodeBrief(depsFor(store), {
      nodeKey: ABSENT_NODE_KEY, projectId: PROJECT_ID,
    });
    const refusal = refusalOf(result);

    expect(refusal.code).toBe("NODE_MISSION_NODE_ABSENT");
    expect(refusal.layer).toBe(PRODUCER_LAYER);
    expect(refusal.upstream?.code).toBe("NODE_CLOSURE_NODE_UNKNOWN");
    expect(refusal.upstream?.layer).toBe(CLOSURE_LAYER);
    expect(refusal.detail).toContain(ABSENT_NODE_KEY);
    expect(refusal.detail).not.toContain(durableObjective(store));
    expect("brief" in refusal).toBe(false);
  });

  it("gives the three situations three distinct codes rather than one", () => {
    const active = activeGraphStore();
    const codes = [
      refusalOf(produceNodeBrief(depsFor(active), { nodeKey: "", projectId: PROJECT_ID })).code,
      refusalOf(produceNodeBrief(depsFor(inactiveGraphStore()),
        { nodeKey: NODE_KEY, projectId: PROJECT_ID })).code,
      refusalOf(produceNodeBrief(depsFor(active),
        { nodeKey: ABSENT_NODE_KEY, projectId: PROJECT_ID })).code,
    ];

    expect(new Set(codes).size).toBe(3);
    expect(codes).toStrictEqual([
      "NODE_MISSION_REQUEST_MALFORMED",
      "NODE_MISSION_GRAPH_UNAVAILABLE",
      "NODE_MISSION_NODE_ABSENT",
    ]);
  });

  it("refuses WORKSPACE_UNAVAILABLE under the scope authority's own code", () => {
    const store = activeGraphStore();
    const repositoryScope = repositoryScopeFor(store, [scopeCatalogEntry({
      scopeRef: "scope-elsewhere",
    })]);

    const refusal = refusalOf(produceNodeBrief(
      depsFor(store, { repositoryScope }), { nodeKey: NODE_KEY, projectId: PROJECT_ID }));

    expect(refusal.code).toBe("NODE_MISSION_WORKSPACE_UNAVAILABLE");
    expect(refusal.layer).toBe(PRODUCER_LAYER);
    // The catalog covers the project but not the scope the project is bound to: the operator's
    // repair is a catalog entry, and the resolver's own code says exactly that.
    expect(refusal.upstream?.code).toBe("FOUNDATION_REPOSITORY_SCOPE_ENTRY_ABSENT");
    expect(refusal.upstream?.layer).toBe(SCOPE_LAYER);
  });

  it("admits the ASSIGNMENT root and never the proposal when the two agree", () => {
    const admitted = admitBriefWorkspace(SOURCE_ROOT, SOURCE_ROOT);

    expect(admitted.ok).toBe(true);
    if (!admitted.ok) throw new Error("expected an admitted workspace");
    expect(admitted.workspace).toBe(SOURCE_ROOT);
  });

  it("refuses DISAGREEMENT rather than letting the proposal select", () => {
    const assignment = "D:\\projexts\\moe-worktrees\\attempt-1";

    const refusal = refusalOf(admitBriefWorkspace(SOURCE_ROOT, assignment));

    expect(refusal.code).toBe("NODE_MISSION_WORKSPACE_DISAGREEMENT");
    expect(refusal.layer).toBe(PRODUCER_LAYER);
    // The proposal must not have won, and must not have been silently discarded either.
    expect("workspace" in refusal).toBe(false);
  });

  it("states the objective mapping in one production function that refuses a blank first line", () => {
    expect(briefProseOf("Land node-a.")).toStrictEqual({
      instructions: "Land node-a.", title: "Land node-a.",
    });
    expect(briefProseOf("Land it.\nThen prove it.")).toStrictEqual({
      instructions: "Land it.\nThen prove it.", title: "Land it.",
    });
    expect(briefProseOf("Land it.\r\nThen prove it.")?.title).toBe("Land it.");
    // Admissible durable text the brief cannot honestly carry: a refusal, never a blank title.
    expect(briefProseOf("\nLand it.")).toBeNull();
    expect(briefProseOf("   ")).toBeNull();
  });

  it("refuses an unusable durable objective at the producer layer", () => {
    const store = activeGraphStore();
    const closure = readCurrentNodeClosure(store, PROJECT_ID);
    if (!closure.ok) throw new Error(`fixture closure refused: ${closure.code}`);
    CLOSURE_OVERRIDE.current = Object.freeze({
      ...closure,
      definitions: Object.freeze(closure.definitions.map((definition) =>
        definition.nodeKey === NODE_KEY
          ? Object.freeze({ ...definition, objective: "\nLand it." })
          : definition)),
    });

    const refusal = refusalOf(produceNodeBrief(
      depsFor(store), { nodeKey: NODE_KEY, projectId: PROJECT_ID }));

    expect(refusal.code).toBe("NODE_MISSION_OBJECTIVE_UNUSABLE");
    expect(refusal.layer).toBe(PRODUCER_LAYER);
    expect(refusal.upstream).toBeNull();
  });

  it("publishes exactly seven refusal codes, and exactly the seven driven here", () => {
    expect(NODE_BRIEF_PRODUCER_CODES).toHaveLength(7);
    expect(DRIVEN_CODES).toHaveLength(7);
    expect([...NODE_BRIEF_PRODUCER_CODES].sort()).toStrictEqual([...DRIVEN_CODES].sort());
    expect(Object.isFrozen(NODE_BRIEF_PRODUCER_CODES)).toBe(true);
  });
});
