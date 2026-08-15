import { describe, expect, it } from "vitest";

import type { LegacySourceRecord } from "./import-canonical.js";
import type { ImportProvenance } from "./import-contract.js";
import { graphFindings } from "./import-reconcile-graph.js";
import { reconcileImport } from "./import-reconcile.js";
import type { ReconcileEntry } from "./import-reconcile.js";

/**
 * GOLDEN FIXTURES FOR THE dependsOn GRAPH WALK.
 *
 * These were captured against the ORIGINAL recursive walk before it was rewritten as an
 * explicit-stack traversal, and they exist to prove the rewrite is behaviour-preserving.
 * The hazard the rewrite carries is not the overflow fix — it is silent REORDERING and a
 * silently changed finding SET:
 *
 *   - a CYCLE is deduped on its TARGET alone (`cycle:${ref}`), so WHICH node discovers a
 *     shared cycle target decides the detail text and the provenance that is emitted. A
 *     walk that visits in a different order reports a different finding, not merely the
 *     same finding later.
 *   - `state.set(id, "DONE")` runs POST-ORDER. OPEN vs DONE is the only thing separating a
 *     back-edge (CYCLE, reported) from a cross-edge (already finished, silently skipped),
 *     so marking DONE early deletes cycle findings and looks like an improvement.
 *
 * Every expectation below is a hand-written literal, and the corpus asserts its own
 * cardinality, so a fixture set that silently produced nothing cannot pass vacuously.
 */

const PROVENANCE: ImportProvenance = Object.freeze({
  manifestDigest: "a".repeat(64),
  sourceDigest: "b".repeat(64),
  sourcePath: "tasks/one.json",
  sourceTime: "2024-03-04T05:06:07.000Z",
  timeBasis: "SOURCE_DECLARED",
});

const KNOWN_FIELDS = Object.freeze(["dependsOn", "owner", "state", "title"]);

type Adjacency = Readonly<Record<string, readonly string[]>>;

/**
 * One entry per key, each from its own source path so a finding's provenance names the
 * node that emitted it. Only `dependsOn` is populated, so nothing but the graph walk can
 * contribute a finding — no unknown field, no owner split, no duplicate identity.
 */
export function graphEntries(adjacency: Adjacency): readonly ReconcileEntry[] {
  return Object.keys(adjacency).map((legacyId) => {
    const sourcePath = `tasks/${legacyId}.json`;
    const record: LegacySourceRecord = {
      declaredTime: "2024-03-04T05:06:07.000Z",
      kind: "task",
      legacyId,
      payload: { dependsOn: [...(adjacency[legacyId] ?? [])] },
      sourcePath,
    };
    return { provenance: Object.freeze({ ...PROVENANCE, sourcePath }), record };
  });
}

export function reconcileGraph(entries: readonly ReconcileEntry[]): readonly string[] {
  const report = reconcileImport({
    declaredRecordCount: null,
    entries,
    knownFields: KNOWN_FIELDS,
    sourcePaths: entries.map((item) => item.record.sourcePath),
  });
  return report.findings.map(
    (found) => `${found.ambiguityClass} ${found.provenance.sourcePath} ${found.detail}`,
  );
}

function findingsOf(adjacency: Adjacency): readonly string[] {
  return reconcileGraph(graphEntries(adjacency));
}

interface GoldenCase {
  readonly adjacency: Adjacency;
  readonly expected: readonly string[];
  readonly name: string;
}

const GOLDEN: readonly GoldenCase[] = Object.freeze([
  {
    adjacency: { a: ["b"], b: ["c"], c: ["d"], d: [] },
    expected: [],
    name: "a plain chain resolves fully and reports nothing",
  },
  {
    adjacency: { a: ["b"], b: ["c"], c: ["ghost"] },
    expected: ["DANGLING_REF tasks/c.json record c depends on ghost, which was not imported"],
    name: "a chain whose tail dangles reports the tail, not the head",
  },
  {
    // The cross-edge case: `c` reaches `d` after `d` is DONE. That must stay silent.
    adjacency: { a: ["b", "c"], b: ["d"], c: ["d"], d: ["ghost"] },
    expected: ["DANGLING_REF tasks/d.json record d depends on ghost, which was not imported"],
    name: "a diamond visits the shared node once and treats the second edge as a cross-edge",
  },
  {
    adjacency: { a: ["a"] },
    expected: ["CYCLE tasks/a.json record a closes a dependsOn cycle back to a"],
    name: "a self-cycle is reported by the node itself",
  },
  {
    adjacency: { a: ["b"], b: ["a"] },
    expected: ["CYCLE tasks/b.json record b closes a dependsOn cycle back to a"],
    name: "a mutual cycle is reported by the node that closes it",
  },
  {
    adjacency: { a: ["b"], b: ["c"], c: ["a"] },
    expected: ["CYCLE tasks/c.json record c closes a dependsOn cycle back to a"],
    name: "a three-node cycle is reported by the node that closes it",
  },
  {
    // `cycle:${ref}` is keyed on the TARGET alone: exactly one finding however many
    // nodes close back to `a`. A pair key would emit two here.
    adjacency: { a: ["b", "c"], b: ["a"], c: ["a"] },
    expected: ["CYCLE tasks/b.json record b closes a dependsOn cycle back to a"],
    name: "two nodes closing back to one target yield exactly one cycle finding",
  },
  {
    // The early-DONE detector. If `b` were marked DONE before its refs were walked, `c`
    // would read the back-edge as a cross-edge and this finding would vanish.
    adjacency: { a: ["b"], b: ["c"], c: ["b"] },
    expected: ["CYCLE tasks/c.json record c closes a dependsOn cycle back to b"],
    name: "a cycle nested under an entry node is still reported",
  },
  {
    adjacency: { a: ["x", "y"], b: ["x"] },
    expected: [
      "DANGLING_REF tasks/a.json record a depends on x, which was not imported",
      "DANGLING_REF tasks/a.json record a depends on y, which was not imported",
      "DANGLING_REF tasks/b.json record b depends on x, which was not imported",
    ],
    name: "dangling refs dedupe per edge, so one absent target is reported once per source",
  },
  {
    // `a` suspends mid-loop to walk `b`, resumes, walks `c`, then falls through to the
    // dangling `ghost`. That interleaving is what a stack of plain node ids loses.
    adjacency: { a: ["b", "ghost", "c"], b: ["gone"], c: [] },
    expected: [
      "DANGLING_REF tasks/a.json record a depends on ghost, which was not imported",
      "DANGLING_REF tasks/b.json record b depends on gone, which was not imported",
    ],
    name: "a node with refs that recurse and refs that dangle reports both",
  },
  {
    adjacency: { a: ["b"], b: ["ghost1"], m: ["n"], n: ["ghost2"] },
    expected: [
      "DANGLING_REF tasks/b.json record b depends on ghost1, which was not imported",
      "DANGLING_REF tasks/n.json record n depends on ghost2, which was not imported",
    ],
    name: "disconnected components are each entered by the outer driver",
  },
  {
    adjacency: { a: ["b", "zz"], b: ["c"], c: ["a", "ghost"], d: ["d"] },
    expected: [
      "DANGLING_REF tasks/a.json record a depends on zz, which was not imported",
      "CYCLE tasks/c.json record c closes a dependsOn cycle back to a",
      "DANGLING_REF tasks/c.json record c depends on ghost, which was not imported",
      "CYCLE tasks/d.json record d closes a dependsOn cycle back to d",
    ],
    name: "cycles and dangling refs from one graph interleave and then sort deterministically",
  },
  {
    // The per-node ref sort decides WHICH node discovers the shared cycle target, and the
    // cycle is deduped on the target alone — so dropping `.sort(byCodeUnit)` on a node's
    // refs changes the emitted detail and provenance, not merely their position. Written
    // deliberately out of order so payload order and walk order disagree.
    adjacency: { a: ["zz", "aa"], aa: ["a"], zz: ["a"] },
    expected: ["CYCLE tasks/aa.json record aa closes a dependsOn cycle back to a"],
    name: "a node's refs are walked in sorted order, not payload order",
  },
]);

describe("the dependsOn walk reproduces its captured output exactly", () => {
  it("runs the whole captured corpus, so a sweep that generated nothing cannot pass", () => {
    expect(GOLDEN.length).toBe(13);
    const total = GOLDEN.reduce((sum, item) => sum + item.expected.length, 0);
    expect(total).toBe(19);
  });

  it.each(GOLDEN)("$name", ({ adjacency, expected }) => {
    expect(findingsOf(adjacency)).toEqual(expected);
  });
});

/**
 * RAW EMISSION ORDER, captured while the walk was still recursive.
 *
 * `reconcileImport` sorts its findings before returning them, and that sort is a total
 * order over distinct findings — so it ERASES the sequence the walk emitted. These two
 * cases go straight at `graphFindings` to pin the interleaving the public surface hides:
 * a parent suspends mid-loop to walk a child, the child's findings land FIRST, and the
 * parent's remaining refs are only then considered. A rewrite that pushes plain node ids
 * onto a stack instead of (id, refs, nextIndex) frames loses exactly this and would pass
 * every sorted assertion in the file.
 */
function rawWalk(adjacency: Adjacency): readonly string[] {
  return graphFindings(graphEntries(adjacency)).map(
    (found) => `${found.ambiguityClass} ${found.provenance.sourcePath} ${found.detail}`,
  );
}

describe("the walk emits findings in its captured raw order", () => {
  it("emits a suspended parent's own dangling ref AFTER the child subtree it descended into", () => {
    const adjacency: Adjacency = { a: ["b", "ghost", "c"], b: ["gone"], c: [] };
    const raw = rawWalk(adjacency);
    expect(raw).toEqual([
      "DANGLING_REF tasks/b.json record b depends on gone, which was not imported",
      "DANGLING_REF tasks/a.json record a depends on ghost, which was not imported",
    ]);
    // Teeth: the public sort reverses this pair, so the raw assertion is not a restatement
    // of the sorted one and a reordering rewrite cannot hide behind the sort.
    expect(reconcileGraph(graphEntries(adjacency))).not.toEqual(raw);
  });

  it("emits a node's own dangling refs in sorted ref order, not payload order", () => {
    // Both refs belong to ONE node, so the public sort by detail happens to agree with the
    // walk here — this raw assertion is the only thing pinning the per-node ref sort.
    expect(rawWalk({ a: ["zz", "aa"] })).toEqual([
      "DANGLING_REF tasks/a.json record a depends on aa, which was not imported",
      "DANGLING_REF tasks/a.json record a depends on zz, which was not imported",
    ]);
  });

  it("interleaves cycle and dangling findings in discovery order across a mixed graph", () => {
    const adjacency: Adjacency = { a: ["b", "zz"], b: ["c"], c: ["a", "ghost"], d: ["d"] };
    const raw = rawWalk(adjacency);
    expect(raw).toEqual([
      "CYCLE tasks/c.json record c closes a dependsOn cycle back to a",
      "DANGLING_REF tasks/c.json record c depends on ghost, which was not imported",
      "DANGLING_REF tasks/a.json record a depends on zz, which was not imported",
      "CYCLE tasks/d.json record d closes a dependsOn cycle back to d",
    ]);
    expect(reconcileGraph(graphEntries(adjacency))).not.toEqual(raw);
  });
});

/**
 * The importer's input is FROZEN LEGACY BYTES, so the depth of a `dependsOn` chain is
 * data-determined rather than merely unlucky — an operator can hand the importer a project
 * whose chain is as long as it likes. A recursive walk spends one call frame per link, so
 * a deep enough chain surfaces as an unhandled `RangeError: Maximum call stack size
 * exceeded` out of a module whose contract is "NEVER THROWS and never drops a record".
 */
function chainEntries(depth: number): readonly ReconcileEntry[] {
  const name = (index: number): string => `n${String(index).padStart(8, "0")}`;
  const adjacency: Record<string, readonly string[]> = {};
  for (let index = 0; index < depth; index += 1) {
    // Zero-padded names sort the head first, so the outer driver enters at the head and
    // the walk descends the FULL chain rather than a suffix of it.
    adjacency[name(index)] = index === depth - 1 ? ["ghost"] : [name(index + 1)];
  }
  return graphEntries(adjacency);
}

function danglingTail(depth: number): string {
  const tail = `n${String(depth - 1).padStart(8, "0")}`;
  return `DANGLING_REF tasks/${tail}.json record ${tail} depends on ghost, which was not imported`;
}

/**
 * Two nodes per level, each depending on BOTH nodes of the level below. The number of
 * distinct paths from the top is 2^levels, so a walk that re-entered an already-finished
 * node would never return; a walk that visits each node once does 2*levels of work.
 */
function ladderEntries(levels: number): readonly ReconcileEntry[] {
  const name = (level: number, side: string): string => `d${String(level).padStart(4, "0")}${side}`;
  const adjacency: Record<string, readonly string[]> = {};
  for (let level = 0; level < levels; level += 1) {
    const below = level === levels - 1
      ? ["ghost"]
      : [name(level + 1, "a"), name(level + 1, "b")];
    adjacency[name(level, "a")] = below;
    adjacency[name(level, "b")] = below;
  }
  return graphEntries(adjacency);
}

describe("the walk is depth-independent", () => {
  it("reconciles a chain far deeper than the call stack instead of throwing RangeError", () => {
    const entries = chainEntries(20_000);
    expect(entries.length).toBe(20_000);
    expect(reconcileGraph(entries)).toEqual([danglingTail(20_000)]);
  });

  it("reconciles a chain an order of magnitude deeper again, so depth is not merely tolerated", () => {
    const entries = chainEntries(200_000);
    expect(entries.length).toBe(200_000);
    expect(graphFindings(entries).map((found) => found.detail)).toEqual([
      "record n00199999 depends on ghost, which was not imported",
    ]);
  });

  it("yields the identical result when the deep chain is supplied in reverse insertion order", () => {
    const entries = chainEntries(20_000);
    expect(reconcileGraph([...entries].reverse())).toEqual([danglingTail(20_000)]);
  });

  // Bounded: a walk that lost its visited-state would run 2^60 paths and HANG rather than
  // fail, and a hang reads as a holding guard. The timeout makes the regression a red test.
  it("visits a node reachable by many paths exactly once", { timeout: 5_000 }, () => {
    const entries = ladderEntries(60);
    expect(entries.length).toBe(120);
    expect(graphFindings(entries).map((found) => found.detail)).toEqual([
      "record d0059a depends on ghost, which was not imported",
      "record d0059b depends on ghost, which was not imported",
    ]);
  });
});

describe("the walk is insensitive to input order but not to graph shape", () => {
  it("yields the identical sequence when adjacency is supplied in reverse insertion order", () => {
    const adjacency: Adjacency = { a: ["b", "zz"], b: ["c"], c: ["a", "ghost"], d: ["d"] };
    const forward = graphEntries(adjacency);
    const expected = GOLDEN[11]?.expected ?? [];
    expect(expected.length).toBe(4);
    expect(reconcileGraph(forward)).toEqual(expected);
    expect(reconcileGraph([...forward].reverse())).toEqual(expected);
  });

  it("returns byte-identical findings when the same input is reconciled twice", () => {
    const adjacency: Adjacency = { a: ["b", "c"], b: ["a"], c: ["a", "ghost"] };
    const first = findingsOf(adjacency);
    expect(first.length).toBe(2);
    expect(findingsOf(adjacency)).toEqual(first);
  });
});
