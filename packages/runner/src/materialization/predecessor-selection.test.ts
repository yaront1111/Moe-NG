import { describe, expect, it } from "vitest";

import { canonicalJson } from "../canonical.js";
import {
  MAX_ARTIFACTS_PER_PREDECESSOR,
  MAX_PREDECESSOR_CANDIDATES,
  MAX_SELECTED_INPUTS,
} from "./materialization-kernel.js";
import { selectPredecessorInputs } from "./predecessor-selection.js";

const BASE = "0".repeat(40);
const digest = (character: string): string => character.repeat(64);

type Shape = Record<string, unknown>;

function artifact(identity: string, overrides: Shape = {}): Shape {
  return { artifactIdentity: identity, sha256: digest("a"), byteLength: 12, ...overrides };
}

function candidate(overrides: Shape = {}): Shape {
  return {
    nodeKey: "node/alpha",
    topologicalIndex: 0,
    resultRef: "result:alpha",
    attemptRef: "attempt:alpha",
    epoch: 1,
    adoptionRef: "adoption:alpha",
    milestone: "ACCEPTED",
    artifacts: [artifact("art:one")],
    ...overrides,
  };
}

function select(
  candidates: unknown,
  requiredMilestone: unknown = "ACCEPTED",
  baseIdentity: unknown = BASE,
): ReturnType<typeof selectPredecessorInputs> {
  return selectPredecessorInputs({ baseIdentity, requiredMilestone, candidates });
}

function refusal(result: { readonly ok: boolean }): {
  readonly code: string;
  readonly layer: string;
  readonly detail: string | null;
} {
  expect(result.ok).toBe(false);
  const failure = result as unknown as { code: string; layer: string; detail: string | null };
  return { code: failure.code, layer: failure.layer, detail: failure.detail };
}

function identities(result: { readonly ok: boolean }): readonly string[] {
  expect(result.ok).toBe(true);
  const selection = result as unknown as {
    selection: { entries: readonly { artifactIdentity: string }[] };
  };
  return selection.selection.entries.map((entry) => entry.artifactIdentity);
}

describe("deterministic ordering", () => {
  // Graph base first, then transitive accepted predecessor results in
  // topological order, ties broken by stable nodeKey, each artifact identity
  // exactly once (design line 380).
  const closure = [
    candidate({
      nodeKey: "node/zulu",
      topologicalIndex: 1,
      resultRef: "result:zulu",
      attemptRef: "attempt:zulu",
      adoptionRef: "adoption:zulu",
      artifacts: [artifact("art:zulu-second"), artifact("art:zulu-first")],
    }),
    candidate({
      nodeKey: "node/bravo",
      topologicalIndex: 2,
      resultRef: "result:bravo",
      attemptRef: "attempt:bravo",
      adoptionRef: "adoption:bravo",
      artifacts: [artifact("art:bravo")],
    }),
    candidate({
      nodeKey: "node/alpha",
      topologicalIndex: 1,
      artifacts: [artifact("art:alpha")],
    }),
  ];

  // Hand-written, NOT computed by calling the function under test: an expectation
  // derived from the subject can never disagree with it.
  const EXPECTED = [
    "art:alpha",
    "art:zulu-first",
    "art:zulu-second",
    "art:bravo",
  ];

  it("orders by topological index, then by stable nodeKey, then by artifact identity", () => {
    expect(identities(select(closure))).toEqual(EXPECTED);
  });

  it("produces the same sequence for every permutation of the caller's input", () => {
    const permutations = [
      [closure[0], closure[1], closure[2]],
      [closure[2], closure[1], closure[0]],
      [closure[1], closure[0], closure[2]],
      [closure[1], closure[2], closure[0]],
    ];
    for (const permutation of permutations) {
      expect(identities(select(permutation))).toEqual(EXPECTED);
    }
  });

  it("is byte-identical across repeated calls", () => {
    expect(canonicalJson(select(closure))).toBe(canonicalJson(select(closure)));
  });

  it("carries the graph base and every producer identity through to the selection", () => {
    const result = select([candidate()]) as unknown as { selection: Shape };
    expect(result.selection["baseIdentity"]).toBe(BASE);
    expect((result.selection["entries"] as readonly Shape[])[0]).toEqual({
      artifactIdentity: "art:one",
      sha256: digest("a"),
      byteLength: 12,
      producerNodeKey: "node/alpha",
      producerResultRef: "result:alpha",
      producerAttemptRef: "attempt:alpha",
      producerEpoch: 1,
      producerAdoptionRef: "adoption:alpha",
    });
  });

  it("freezes the selection and its entries", () => {
    const result = select([candidate()]);
    const selection = (result as unknown as { selection: { entries: readonly Shape[] } }).selection;
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(selection)).toBe(true);
    expect(Object.isFrozen(selection.entries)).toBe(true);
    expect(Object.isFrozen(selection.entries[0])).toBe(true);
  });
});

describe("dedupe versus ambiguity", () => {
  // These are DIFFERENT outcomes and get separate tests on purpose. Folding them
  // into one code would let a genuine producer conflict pass as a harmless
  // duplicate, which is the failure this pair exists to prevent.
  it("dedupes one artifact identity reached twice through different paths", () => {
    const reachedTwice = [candidate(), candidate()];
    expect(identities(select(reachedTwice))).toEqual(["art:one"]);
  });

  it("dedupes a producer listed twice with several artifacts", () => {
    const many = candidate({ artifacts: [artifact("art:two"), artifact("art:one")] });
    expect(identities(select([many, many]))).toEqual(["art:one", "art:two"]);
  });

  it("refuses one artifact identity offered by two distinct producers", () => {
    const rival = candidate({
      nodeKey: "node/bravo",
      resultRef: "result:bravo",
      attemptRef: "attempt:bravo",
      adoptionRef: "adoption:bravo",
    });
    expect(refusal(select([candidate(), rival]))).toEqual({
      code: "RUNNER_MATERIALIZATION_PRODUCER_AMBIGUOUS",
      layer: "SELECTION",
      detail: "art:one",
    });
  });

  it("refuses two distinct producers even when the offered bytes agree", () => {
    // Identical bytes are not identical provenance. Accepting this would let the
    // manifest bind an adoption identity chosen by list order.
    const rival = candidate({ nodeKey: "node/bravo", adoptionRef: "adoption:bravo" });
    expect(refusal(select([candidate(), rival])).code).toBe(
      "RUNNER_MATERIALIZATION_PRODUCER_AMBIGUOUS",
    );
  });

  it("refuses one artifact identity offered by two producers with different digests", () => {
    // Distinct nodeKeys, so only the artifact-identity claim can be answering
    // here — the producer-record check below cannot reach this case.
    const forked = candidate({
      nodeKey: "node/bravo",
      resultRef: "result:bravo",
      attemptRef: "attempt:bravo",
      adoptionRef: "adoption:bravo",
      artifacts: [artifact("art:one", { sha256: digest("b") })],
    });
    expect(refusal(select([candidate(), forked]))).toEqual({
      code: "RUNNER_MATERIALIZATION_PRODUCER_AMBIGUOUS",
      layer: "SELECTION",
      detail: "art:one",
    });
  });

  it("refuses one nodeKey offering the same identity with two different digests", () => {
    // Same nodeKey, so the producer-record check answers FIRST and names the
    // node. Pinned separately so a later reordering of the two checks cannot
    // silently change which fact a caller is told.
    const forked = candidate({ artifacts: [artifact("art:one", { sha256: digest("b") })] });
    expect(refusal(select([candidate(), forked]))).toEqual({
      code: "RUNNER_MATERIALIZATION_PRODUCER_AMBIGUOUS",
      layer: "SELECTION",
      detail: "node/alpha",
    });
  });

  it("refuses one nodeKey carrying two disagreeing producer records", () => {
    const forked = candidate({ attemptRef: "attempt:other", artifacts: [artifact("art:two")] });
    expect(refusal(select([candidate(), forked]))).toEqual({
      code: "RUNNER_MATERIALIZATION_PRODUCER_AMBIGUOUS",
      layer: "SELECTION",
      detail: "node/alpha",
    });
  });
});

describe("milestone qualification", () => {
  it("refuses a predecessor below the required milestone rather than skipping it", () => {
    const early = candidate({ milestone: "RESULT_SEALED" });
    expect(refusal(select([early], "ACCEPTED"))).toEqual({
      code: "RUNNER_MATERIALIZATION_MILESTONE_UNQUALIFIED",
      layer: "SELECTION",
      detail: "node/alpha",
    });
  });

  it("accepts a predecessor exactly at the required milestone", () => {
    const exact = candidate({ milestone: "EVIDENCE_SEALED" });
    expect(identities(select([exact], "EVIDENCE_SEALED"))).toEqual(["art:one"]);
  });

  it("accepts a predecessor above the required milestone", () => {
    expect(identities(select([candidate()], "EVIDENCE_SEALED"))).toEqual(["art:one"]);
  });

  it("names the first unqualified producer in selection order, not in caller order", () => {
    const late = candidate({
      nodeKey: "node/zulu",
      topologicalIndex: 9,
      resultRef: "result:zulu",
      attemptRef: "attempt:zulu",
      adoptionRef: "adoption:zulu",
      milestone: "CANDIDATE_SEALED",
      artifacts: [artifact("art:zulu")],
    });
    const early = candidate({ milestone: "CANDIDATE_SEALED" });
    expect(refusal(select([late, early])).detail).toBe("node/alpha");
    expect(refusal(select([early, late])).detail).toBe("node/alpha");
  });
});

describe("bounds and hostile shapes", () => {
  it("refuses an oversized closure on the bound", () => {
    const oversized = Array.from({ length: MAX_PREDECESSOR_CANDIDATES + 1 }, (_unused, index) =>
      candidate({ nodeKey: `node/n${index}`, artifacts: [artifact(`art:${index}`)] }),
    );
    expect(refusal(select(oversized))).toEqual({
      code: "RUNNER_MATERIALIZATION_CLOSURE_LIMIT",
      layer: "SELECTION",
      detail: null,
    });
  });

  it("refuses an oversized artifact list on one predecessor", () => {
    const fat = candidate({
      artifacts: Array.from({ length: MAX_ARTIFACTS_PER_PREDECESSOR + 1 }, (_unused, index) =>
        artifact(`art:${index}`),
      ),
    });
    expect(refusal(select([fat]))).toEqual({
      code: "RUNNER_MATERIALIZATION_ARTIFACT_LIMIT",
      layer: "SELECTION",
      detail: "node/alpha",
    });
  });

  it("refuses a selection larger than the ceiling even when every part is legal", () => {
    const perNode = MAX_ARTIFACTS_PER_PREDECESSOR;
    const nodes = Math.floor(MAX_SELECTED_INPUTS / perNode) + 1;
    const closure = Array.from({ length: nodes }, (_unused, node) =>
      candidate({
        nodeKey: `node/n${node}`,
        topologicalIndex: node,
        artifacts: Array.from({ length: perNode }, (_ignored, index) =>
          artifact(`art:${node}-${index}`),
        ),
      }),
    );
    expect(refusal(select(closure))).toEqual({
      code: "RUNNER_MATERIALIZATION_SELECTION_LIMIT",
      layer: "SELECTION",
      detail: null,
    });
  });

  it("refuses a base identity that is not a commit", () => {
    expect(refusal(select([candidate()], "ACCEPTED", "not-a-commit"))).toEqual({
      code: "RUNNER_MATERIALIZATION_BASE_INVALID",
      layer: "SELECTION",
      detail: null,
    });
  });

  const hostileClosures: readonly (readonly [string, unknown])[] = [
    ["a non-array closure", { length: 1 }],
    ["an unknown required milestone", "SOMEDAY"],
  ];

  it("refuses a non-array closure", () => {
    expect(refusal(select(hostileClosures[0]![1]))).toEqual({
      code: "RUNNER_MATERIALIZATION_CLOSURE_MALFORMED",
      layer: "SELECTION",
      detail: null,
    });
  });

  it("refuses an unknown required milestone", () => {
    expect(refusal(select([candidate()], hostileClosures[1]![1]))).toEqual({
      code: "RUNNER_MATERIALIZATION_CLOSURE_MALFORMED",
      layer: "SELECTION",
      detail: null,
    });
  });

  const hostileCandidates: readonly (readonly [string, () => unknown])[] = [
    ["custom prototype", () => Object.setPrototypeOf(candidate(), { smuggled: true })],
    ["extra key", () => ({ ...candidate(), extra: 1 })],
    ["missing key", () => {
      const partial = candidate();
      delete partial["adoptionRef"];
      return partial;
    }],
    ["wrong type", () => candidate({ epoch: "1" })],
    ["getter-bearing", () => {
      let reads = 0;
      return Object.defineProperty(candidate(), "nodeKey", {
        enumerable: true,
        get: () => (reads++ === 0 ? "node/alpha" : "node/other"),
      });
    }],
    ["negative topological index", () => candidate({ topologicalIndex: -1 })],
    ["empty artifact list", () => candidate({ artifacts: [] })],
    ["node key the graph cannot name", () => candidate({ nodeKey: "node alpha" })],
    ["unknown milestone", () => candidate({ milestone: "ALMOST" })],
    ["artifact with a short digest", () => candidate({ artifacts: [artifact("art:one", { sha256: "abc" })] })],
    ["artifact with a negative byte length", () => candidate({ artifacts: [artifact("art:one", { byteLength: -1 })] })],
    ["artifact with an extra key", () => candidate({ artifacts: [artifact("art:one", { extra: 1 })] })],
    ["duplicate artifact identity within one predecessor", () => candidate({ artifacts: [artifact("art:one"), artifact("art:one")] })],
  ];

  for (const [name, build] of hostileCandidates) {
    it(`refuses ${name} with RUNNER_MATERIALIZATION_CANDIDATE_MALFORMED at layer SELECTION`, () => {
      expect(refusal(select([build()]))).toEqual({
        code: "RUNNER_MATERIALIZATION_CANDIDATE_MALFORMED",
        layer: "SELECTION",
        detail: null,
      });
    });
  }

  it("accepts an empty closure as a base-only selection", () => {
    expect(identities(select([]))).toEqual([]);
  });
});
