import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  GRAPH_CONTENT_ISSUE_CODES,
  GRAPH_CONTENT_LAYERS,
  GRAPH_CONTENT_SCHEMA_VERSION,
  MAX_GRAPH_CONTENT_BYTES,
  decodeGraphContent,
  encodeGraphContent,
} from "./graph-content.js";
import type { GraphContentIssue, GraphContentResult } from "./graph-content.js";
import { validateGraphSnapshot } from "./validate-graph.js";
import { ABSOLUTE_MAX_GRAPH_NODES } from "./graph-policy.js";
import type { GraphEdge, GraphNode, GraphSnapshot } from "./graph-model.js";
import {
  devAdvisoryEdge,
  devHardEdge,
  devNode,
  devSnapshot,
} from "./test-fixtures.js";

// --- fixtures ----------------------------------------------------------------

/**
 * Three nodes, two HARD edges into the completion node plus one ADVISORY edge.
 * Deliberately shaped so a mutation can flip the advisory edge, re-point it, or
 * add a fourth node WITHOUT breaking completion closure — a mutation that makes
 * the graph invalid would prove nothing about identity.
 */
function baseNodes(): GraphNode[] {
  return [devNode("dev-a"), devNode("dev-b"), devNode("dev-c")];
}

function baseEdges(): GraphEdge[] {
  return [
    devHardEdge("dev-e1", "dev-a", "dev-c"),
    devHardEdge("dev-e2", "dev-b", "dev-c"),
    devAdvisoryEdge("dev-e3", "dev-a", "dev-b"),
  ];
}

function baseSnapshot(): GraphSnapshot {
  return devSnapshot(baseNodes(), baseEdges(), "dev-c");
}

const DECODER = new TextDecoder("utf-8", { fatal: true });
const ENCODER = new TextEncoder();

function textOf(bytes: Uint8Array): string {
  return DECODER.decode(bytes);
}

function okValue(result: GraphContentResult) {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`expected ok, got ${JSON.stringify(result.issues)}`);
  }
  return result.value;
}

function pairsOf(result: GraphContentResult): readonly (readonly [string, string])[] {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected a refusal, got an accepted value");
  }
  return result.issues.map(
    (issue: GraphContentIssue) => [issue.code, issue.layer] as const,
  );
}

/** Every ordering of a 3-element list, so ordering coverage is exhaustive. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) {
    return [[...items]];
  }
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += 1) {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of permutations(rest)) {
      out.push([items[index]!, ...tail]);
    }
  }
  return out;
}

// --- accepted encoding -------------------------------------------------------

describe("encodeGraphContent — accepted canonical identity", () => {
  it("returns a frozen envelope with a domain-separated lowercase sha-256 hash", () => {
    const value = okValue(encodeGraphContent(baseSnapshot()));

    expect(value.schemaVersion).toBe(GRAPH_CONTENT_SCHEMA_VERSION);
    expect(value.graphContentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.snapshot)).toBe(true);
    expect(Object.isFrozen(value.snapshot.nodes)).toBe(true);
    expect(Object.isFrozen(value.snapshot.nodes[0])).toBe(true);
    expect(Object.isFrozen(value.snapshot.edges[0])).toBe(true);
  });

  it("is NOT the raw graphIdentity string — the hash is a digest over it", () => {
    const validated = validateGraphSnapshot(baseSnapshot());
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const value = okValue(encodeGraphContent(baseSnapshot()));
    expect(value.graphContentHash).not.toBe(validated.graph.graphIdentity);
    expect(textOf(value.bytes)).not.toContain(validated.graph.graphIdentity);
  });

  it("emits canonical sorted snapshot content, not caller order", () => {
    const reversed = devSnapshot(
      [...baseNodes()].reverse(),
      [...baseEdges()].reverse(),
      "dev-c",
    );
    const value = okValue(encodeGraphContent(reversed));
    expect(value.snapshot.nodes.map((node) => node.nodeKey))
      .toEqual(["dev-a", "dev-b", "dev-c"]);
    expect(value.snapshot.edges.map((edge) => edge.edgeKey))
      .toEqual(["dev-e1", "dev-e2", "dev-e3"]);
  });

  it("serializes one fixed-key envelope with no whitespace", () => {
    const value = okValue(encodeGraphContent(baseSnapshot()));
    const text = textOf(value.bytes);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["schema", "hash", "snapshot"]);
    expect(Object.keys(parsed["snapshot"] as Record<string, unknown>))
      .toEqual(["nodes", "edges", "completionNodeKey"]);
    expect(text).not.toMatch(/[\n\t]|: |, /u);
    expect(text.startsWith("{\"schema\":")).toBe(true);
  });

  it("hands back detached bytes a caller cannot use to corrupt a later call", () => {
    const first = okValue(encodeGraphContent(baseSnapshot()));
    // Non-empty typed arrays cannot be frozen (TypeError: Cannot freeze array
    // buffer views with elements), so the contract is "frozen envelope, COPIED
    // bytes". Detachment is what a freeze would otherwise have bought.
    first.bytes[0] = 0x00;
    const second = okValue(encodeGraphContent(baseSnapshot()));
    expect(second.bytes[0]).toBe("{".charCodeAt(0));
    expect(second.bytes).not.toBe(first.bytes);
    expect(second.bytes.buffer).not.toBe(first.bytes.buffer);
  });

  it("ignores caller mutation of the input arrays after the call returns", () => {
    const nodes = baseNodes();
    const snapshot = devSnapshot(nodes, baseEdges(), "dev-c");
    const value = okValue(encodeGraphContent(snapshot));
    const before = value.graphContentHash;
    nodes.push(devNode("dev-z"));
    expect(value.snapshot.nodes).toHaveLength(3);
    expect(value.graphContentHash).toBe(before);
  });
});

// --- ordering and structural sensitivity -------------------------------------

describe("encodeGraphContent — ordering is not content, structure is", () => {
  it("encodes every node/edge ordering to byte-identical output", () => {
    const orderings = permutations(baseNodes())
      .flatMap((nodes) => permutations(baseEdges()).map((edges) => ({ nodes, edges })));
    // 3! node orderings x 3! edge orderings. A sweep that produced zero cases
    // would pass every assertion below, so the count is asserted first.
    expect(orderings).toHaveLength(36);

    const expected = okValue(encodeGraphContent(baseSnapshot()));
    for (const { nodes, edges } of orderings) {
      const value = okValue(encodeGraphContent(devSnapshot(nodes, edges, "dev-c")));
      expect(textOf(value.bytes)).toBe(textOf(expected.bytes));
      expect(value.graphContentHash).toBe(expected.graphContentHash);
    }
  });

  const STRUCTURAL_MUTATIONS: readonly (readonly [string, () => GraphSnapshot])[] = [
    ["node execution bearing flipped", () => devSnapshot(
      [devNode("dev-a", false), devNode("dev-b"), devNode("dev-c")],
      baseEdges(), "dev-c")],
    ["advisory edge promoted to hard", () => devSnapshot(
      baseNodes(),
      [...baseEdges().slice(0, 2), devHardEdge("dev-e3", "dev-a", "dev-b")],
      "dev-c")],
    ["advisory edge re-pointed", () => devSnapshot(
      baseNodes(),
      [...baseEdges().slice(0, 2), devAdvisoryEdge("dev-e3", "dev-b", "dev-a")],
      "dev-c")],
    ["edge key renamed", () => devSnapshot(
      baseNodes(),
      [...baseEdges().slice(0, 2), devAdvisoryEdge("dev-e9", "dev-a", "dev-b")],
      "dev-c")],
    ["node added with a hard edge", () => devSnapshot(
      [...baseNodes(), devNode("dev-d")],
      [...baseEdges(), devHardEdge("dev-e4", "dev-d", "dev-c")],
      "dev-c")],
    ["completion node changed", () => devSnapshot(
      [devNode("dev-a"), devNode("dev-b")],
      [devHardEdge("dev-e1", "dev-a", "dev-b")],
      "dev-b")],
  ];

  it("gives every structurally distinct graph a distinct identity", () => {
    expect(STRUCTURAL_MUTATIONS.length).toBeGreaterThan(0);
    const base = okValue(encodeGraphContent(baseSnapshot()));
    const seen = new Map<string, string>([[base.graphContentHash, "base"]]);
    for (const [label, build] of STRUCTURAL_MUTATIONS) {
      const value = okValue(encodeGraphContent(build()));
      expect(value.graphContentHash).not.toBe(base.graphContentHash);
      expect(textOf(value.bytes)).not.toBe(textOf(base.bytes));
      const collision = seen.get(value.graphContentHash);
      expect(collision, `${label} collided with ${collision ?? ""}`).toBeUndefined();
      seen.set(value.graphContentHash, label);
    }
    expect(seen.size).toBe(STRUCTURAL_MUTATIONS.length + 1);
  });

  const POLICY_OVERRIDES: readonly (readonly [string, unknown])[] = [
    ["undefined", undefined],
    ["raised node ceiling", { maxNodes: ABSOLUTE_MAX_GRAPH_NODES }],
    ["raised edge ceilings", { maxHardEdges: 128, maxTotalEdges: 128 }],
    ["raised review threshold", { minGatedDescendantsForReview: 3 }],
  ];

  it("excludes policy from content identity exactly as graphIdentity does", () => {
    expect(POLICY_OVERRIDES.length).toBeGreaterThan(0);
    const expected = okValue(encodeGraphContent(baseSnapshot()));
    for (const [label, override] of POLICY_OVERRIDES) {
      const value = okValue(encodeGraphContent(baseSnapshot(), override));
      expect(value.graphContentHash, label).toBe(expected.graphContentHash);
      expect(textOf(value.bytes), label).toBe(textOf(expected.bytes));
    }
  });
});

// --- round trip --------------------------------------------------------------

describe("decodeGraphContent — accepted round trip", () => {
  it("returns the canonical snapshot and the same hash", () => {
    const encoded = okValue(encodeGraphContent(baseSnapshot()));
    const decoded = okValue(decodeGraphContent(encoded.bytes));

    expect(decoded.graphContentHash).toBe(encoded.graphContentHash);
    expect(decoded.snapshot).toEqual(encoded.snapshot);
    expect(decoded.schemaVersion).toBe(GRAPH_CONTENT_SCHEMA_VERSION);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.snapshot.nodes[0])).toBe(true);
  });

  it("re-encodes to the same bytes it accepted", () => {
    const encoded = okValue(encodeGraphContent(baseSnapshot()));
    const decoded = okValue(decodeGraphContent(encoded.bytes));
    expect(textOf(decoded.bytes)).toBe(textOf(encoded.bytes));
    const again = okValue(encodeGraphContent(decoded.snapshot));
    expect(again.graphContentHash).toBe(encoded.graphContentHash);
  });

  it("accepts a caller Buffer and detaches from the caller's memory", () => {
    const encoded = okValue(encodeGraphContent(baseSnapshot()));
    const caller = Buffer.from(encoded.bytes);
    const decoded = okValue(decodeGraphContent(caller));
    expect(decoded.graphContentHash).toBe(encoded.graphContentHash);
    // Buffer.prototype.slice aliases; a decoder that kept the caller's view
    // would change identity under the caller's feet.
    caller[10] = 0x20;
    expect(textOf(decoded.bytes)).toBe(textOf(encoded.bytes));
  });
});

// --- refusals ----------------------------------------------------------------

describe("decodeGraphContent — fails closed on exact code and layer", () => {
  function canonicalText(): string {
    return textOf(okValue(encodeGraphContent(baseSnapshot())).bytes);
  }

  const NOT_BYTES: readonly (readonly [string, unknown])[] = [
    ["null", null],
    ["undefined", undefined],
    ["string", "{}"],
    ["number", 7],
    ["plain object", {}],
    ["array of byte values", [123, 125]],
    ["ArrayBuffer", new ArrayBuffer(2)],
    ["DataView", new DataView(new ArrayBuffer(2))],
    ["Int8Array", new Int8Array(2)],
    ["proxy over bytes", new Proxy(new Uint8Array([1]), {})],
    ["record wearing a length", { length: 1, 0: 123 }],
  ];

  it("refuses every non-byte input as GRAPH_CONTENT_NOT_BYTES", () => {
    expect(NOT_BYTES.length).toBeGreaterThan(0);
    for (const [label, input] of NOT_BYTES) {
      expect(pairsOf(decodeGraphContent(input)), label)
        .toEqual([["GRAPH_CONTENT_NOT_BYTES", "GRAPH_CONTENT_CODEC"]]);
    }
  });

  it("refuses bytes past the ceiling before decoding them", () => {
    const oversized = new Uint8Array(MAX_GRAPH_CONTENT_BYTES + 1);
    expect(pairsOf(decodeGraphContent(oversized)))
      .toEqual([["GRAPH_CONTENT_TOO_LARGE", "GRAPH_CONTENT_CODEC"]]);
  });

  const UNREADABLE: readonly (readonly [string, Uint8Array])[] = [
    ["empty", new Uint8Array(0)],
    ["invalid utf-8 lead byte", new Uint8Array([0xff, 0xfe, 0xfd])],
    ["truncated utf-8 sequence", new Uint8Array([0x7b, 0xc3])],
    ["lone surrogate encoding", new Uint8Array([0xed, 0xa0, 0x80])],
    ["not json", ENCODER.encode("nope")],
    ["truncated json", ENCODER.encode("{\"schema\":")],
    ["trailing content after json", ENCODER.encode("{} {}")],
  ];

  it("refuses unreadable bytes as GRAPH_CONTENT_UNREADABLE", () => {
    expect(UNREADABLE.length).toBeGreaterThan(0);
    for (const [label, input] of UNREADABLE) {
      expect(pairsOf(decodeGraphContent(input)), label)
        .toEqual([["GRAPH_CONTENT_UNREADABLE", "GRAPH_CONTENT_CODEC"]]);
    }
  });

  const MALFORMED: readonly (readonly [string, string])[] = [
    ["json null", "null"],
    ["json array", "[]"],
    ["json scalar", "42"],
    ["missing hash", "{\"schema\":\"MOE-GRAPH-CONTENT/1\",\"snapshot\":{}}"],
    ["extra envelope key", "{\"schema\":\"MOE-GRAPH-CONTENT/1\",\"hash\":\""
      + "a".repeat(64) + "\",\"snapshot\":{\"nodes\":[],\"edges\":[],"
      + "\"completionNodeKey\":\"dev-a\"},\"extra\":1}"],
    ["hash not hex", "{\"schema\":\"MOE-GRAPH-CONTENT/1\",\"hash\":\"" + "Z".repeat(64)
      + "\",\"snapshot\":{\"nodes\":[],\"edges\":[],\"completionNodeKey\":\"dev-a\"}}"],
    ["hash uppercase", "{\"schema\":\"MOE-GRAPH-CONTENT/1\",\"hash\":\"" + "A".repeat(64)
      + "\",\"snapshot\":{\"nodes\":[],\"edges\":[],\"completionNodeKey\":\"dev-a\"}}"],
    ["hash wrong length", "{\"schema\":\"MOE-GRAPH-CONTENT/1\",\"hash\":\"" + "a".repeat(63)
      + "\",\"snapshot\":{\"nodes\":[],\"edges\":[],\"completionNodeKey\":\"dev-a\"}}"],
    ["prototype pollution key", "{\"schema\":\"MOE-GRAPH-CONTENT/1\",\"hash\":\""
      + "a".repeat(64) + "\",\"snapshot\":{\"nodes\":[],\"edges\":[],"
      + "\"completionNodeKey\":\"dev-a\"},\"__proto__\":{\"x\":1}}"],
  ];

  it("refuses a malformed envelope as GRAPH_CONTENT_MALFORMED", () => {
    expect(MALFORMED.length).toBeGreaterThan(0);
    for (const [label, text] of MALFORMED) {
      expect(pairsOf(decodeGraphContent(ENCODER.encode(text))), label)
        .toEqual([["GRAPH_CONTENT_MALFORMED", "GRAPH_CONTENT_CODEC"]]);
    }
  });

  it("refuses an unsupported schema tag", () => {
    const text = canonicalText().replace(
      "MOE-GRAPH-CONTENT/1",
      "MOE-GRAPH-CONTENT/2",
    );
    expect(pairsOf(decodeGraphContent(ENCODER.encode(text))))
      .toEqual([["GRAPH_CONTENT_UNSUPPORTED_SCHEMA", "GRAPH_CONTENT_CODEC"]]);
  });

  it("preserves the graph validator's own code and layer, unrestamped", () => {
    const text = canonicalText().replace("\"dev-e2\"", "\"dev-e1\"");
    const pairs = pairsOf(decodeGraphContent(ENCODER.encode(text)));
    expect(pairs.map(([code]) => code)).toContain("GRAPH_DUPLICATE_EDGE");
    for (const [code, layer] of pairs) {
      expect(layer).toBe("GRAPH_VALIDATION");
      // The codec must not restamp a structural failure as one of its own.
      expect(GRAPH_CONTENT_ISSUE_CODES).not.toContain(code);
    }
  });

  it("routes a structurally impossible snapshot to the validator, not the codec", () => {
    // The envelope is well formed, so the refusal must come from the graph
    // kernel with its own code — a codec-layer answer here would mean the
    // codec had taken over a judgement that is not its to make.
    const text = "{\"schema\":\"MOE-GRAPH-CONTENT/1\",\"hash\":\""
      + "a".repeat(64) + "\",\"snapshot\":7}";
    expect(pairsOf(decodeGraphContent(ENCODER.encode(text))))
      .toEqual([["GRAPH_MALFORMED_SNAPSHOT", "GRAPH_VALIDATION"]]);
  });

  it("refuses a digest that does not match the content it claims", () => {
    const encoded = okValue(encodeGraphContent(baseSnapshot()));
    const text = textOf(encoded.bytes).replace(encoded.graphContentHash, "b".repeat(64));
    expect(pairsOf(decodeGraphContent(ENCODER.encode(text))))
      .toEqual([["GRAPH_CONTENT_DIGEST_MISMATCH", "GRAPH_CONTENT_IDENTITY"]]);
  });

  it("refuses a swapped value whose bytes are still perfectly canonical", () => {
    // Same spelling, different content: re-encoding this input reproduces it
    // byte for byte, so ONLY the digest recomputation can catch it.
    const swapped = devSnapshot(
      [devNode("dev-a", false), devNode("dev-b"), devNode("dev-c")],
      baseEdges(), "dev-c",
    );
    const honest = okValue(encodeGraphContent(baseSnapshot()));
    const forged = okValue(encodeGraphContent(swapped));
    const text = textOf(forged.bytes).replace(
      forged.graphContentHash,
      honest.graphContentHash,
    );
    expect(pairsOf(decodeGraphContent(ENCODER.encode(text))))
      .toEqual([["GRAPH_CONTENT_DIGEST_MISMATCH", "GRAPH_CONTENT_IDENTITY"]]);
  });

  it("refuses every alternate spelling of correct content", () => {
    const canonical = canonicalText();
    // Each variant parses to the SAME content, so its digest recomputes
    // correctly and only the byte re-encode comparison can reject it.
    const variants: readonly (readonly [string, string])[] = [
      ["leading whitespace", ` ${canonical}`],
      ["trailing newline", `${canonical}\n`],
      ["spaced after colon", canonical.replace("{\"schema\":", "{\"schema\": ")],
      ["reordered envelope keys", canonical
        .replace(/^\{"schema":("[^"]*"),"hash":("[^"]*"),/u, "{\"hash\":$2,\"schema\":$1,")],
      ["duplicate schema key", canonical
        .replace("{\"schema\":", "{\"schema\":\"MOE-GRAPH-CONTENT/1\",\"schema\":")],
      ["escaped ascii key", canonical.replace("\"nodes\"", "\"\\u006eodes\"")],
    ];
    expect(variants.length).toBeGreaterThan(0);
    for (const [label, text] of variants) {
      expect(text, label).not.toBe(canonical);
      expect(pairsOf(decodeGraphContent(ENCODER.encode(text))), label)
        .toEqual([["GRAPH_CONTENT_NONCANONICAL", "GRAPH_CONTENT_IDENTITY"]]);
    }
  });

  it("refuses a single flipped raw byte", () => {
    const encoded = okValue(encodeGraphContent(baseSnapshot()));
    const mutated = new Uint8Array(encoded.bytes);
    mutated[mutated.length - 2] = 0x20;
    const pairs = pairsOf(decodeGraphContent(mutated));
    expect(pairs).toHaveLength(1);
    expect(GRAPH_CONTENT_ISSUE_CODES).toContain(pairs[0]![0]);
  });
});

// --- bounds and text handling ------------------------------------------------

describe("graph content bounds", () => {
  /**
   * MAX_GRAPH_CONTENT_BYTES is arithmetic derived from the kernel's absolute
   * ceilings. If that arithmetic is too tight the codec cannot decode a graph
   * the validator accepts — a ceiling nothing else would catch, because every
   * other fixture here is tiny.
   */
  it("encodes and decodes a graph at the kernel's absolute ceilings", () => {
    const longKey = (prefix: string, index: number): string => {
      const stem = `${prefix}${index}-`;
      return stem + "k".repeat(128 - stem.length);
    };
    const nodes = Array.from({ length: 64 }, (_unused, index) =>
      devNode(longKey("dev-n", index)));
    const completion = nodes[0]!.nodeKey;
    const edges: GraphEdge[] = nodes.slice(1).map((node, index) =>
      devHardEdge(longKey("dev-h", index), node.nodeKey, completion));
    while (edges.length < 128) {
      const index = edges.length;
      edges.push(devAdvisoryEdge(
        longKey("dev-x", index), nodes[1]!.nodeKey, nodes[2]!.nodeKey,
      ));
    }
    expect([nodes.length, edges.length]).toEqual([64, 128]);
    expect(nodes[0]!.nodeKey).toHaveLength(128);

    const policy = { maxNodes: 64, maxHardEdges: 128, maxTotalEdges: 128 };
    const encoded = okValue(encodeGraphContent(
      devSnapshot(nodes, edges, completion), policy,
    ));
    expect(encoded.bytes.length).toBeLessThanOrEqual(MAX_GRAPH_CONTENT_BYTES);
    // Not a vacuous headroom check: the worst case must genuinely be large.
    expect(encoded.bytes.length).toBeGreaterThan(60_000);
    const decoded = okValue(decodeGraphContent(encoded.bytes));
    expect(decoded.graphContentHash).toBe(encoded.graphContentHash);
  });

  it("refuses a deeply nested json bomb without throwing", () => {
    const depth = 200_000;
    const bomb = ENCODER.encode("[".repeat(depth) + "]".repeat(depth));
    const result = decodeGraphContent(bomb);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Either ceiling or parse refusal is correct; a THROW is not.
    expect(GRAPH_CONTENT_ISSUE_CODES).toContain(result.issues[0]?.code);
    expect(result.issues[0]?.layer).toBe("GRAPH_CONTENT_CODEC");
  });

  it("never normalizes a non-ascii key — it refuses it at the validator", () => {
    // A codec that NFC/NFD-normalized keys would give one graph two identities.
    const text = "{\"schema\":\"MOE-GRAPH-CONTENT/1\",\"hash\":\"" + "a".repeat(64)
      + "\",\"snapshot\":{\"nodes\":[{\"nodeKey\":\"dev-\\u00e9\","
      + "\"executionBearing\":true}],\"edges\":[],"
      + "\"completionNodeKey\":\"dev-\\u00e9\"}}";
    const pairs = pairsOf(decodeGraphContent(ENCODER.encode(text)));
    for (const [code, layer] of pairs) {
      expect(layer).toBe("GRAPH_VALIDATION");
      expect(GRAPH_CONTENT_ISSUE_CODES).not.toContain(code);
    }
    expect(pairs.length).toBeGreaterThan(0);
  });
});

// --- hostile encode input ----------------------------------------------------

describe("encodeGraphContent — hostile input never reaches the hash", () => {
  const HOSTILE: readonly (readonly [string, () => unknown, string])[] = [
    ["proxy snapshot", () => new Proxy(baseSnapshot(), {}), "GRAPH_MALFORMED_SNAPSHOT"],
    ["proxy node list", () => devSnapshot(
      new Proxy(baseNodes(), {}) as GraphNode[], baseEdges(), "dev-c"),
      "GRAPH_MALFORMED_SNAPSHOT"],
    ["subclassed node list", () => devSnapshot(
      Object.setPrototypeOf(baseNodes(), Object.create(Array.prototype)) as GraphNode[],
      baseEdges(), "dev-c"), "GRAPH_MALFORMED_SNAPSHOT"],
    ["record wearing a length", () => ({
      nodes: { length: 1, 0: devNode("dev-a") },
      edges: [], completionNodeKey: "dev-a",
    }), "GRAPH_MALFORMED_SNAPSHOT"],
    ["extra envelope key", () => ({ ...baseSnapshot(), extra: 1 }),
      "GRAPH_MALFORMED_SNAPSHOT"],
    ["accessor node element", () => {
      const nodes = baseNodes();
      Object.defineProperty(nodes, "0", {
        get: () => devNode("dev-a"), configurable: true,
      });
      return devSnapshot(nodes, baseEdges(), "dev-c");
    }, "GRAPH_MALFORMED_NODE"],
    ["accessor node key", () => {
      const nodes = baseNodes();
      nodes[0] = Object.defineProperty(
        { executionBearing: true } as unknown as GraphNode,
        "nodeKey",
        { get: () => "dev-a", enumerable: true },
      );
      return devSnapshot(nodes, baseEdges(), "dev-c");
    }, "GRAPH_MALFORMED_NODE"],
    ["symbol key on a node", () => {
      const nodes = baseNodes();
      (nodes[0] as unknown as Record<symbol, unknown>)[Symbol("x")] = 1;
      return devSnapshot(nodes, baseEdges(), "dev-c");
    }, "GRAPH_MALFORMED_NODE"],
    ["extra node key", () => {
      const nodes = baseNodes();
      nodes[0] = { ...devNode("dev-a"), extra: 1 } as unknown as GraphNode;
      return devSnapshot(nodes, baseEdges(), "dev-c");
    }, "GRAPH_MALFORMED_NODE"],
    ["sparse node list", () => {
      const nodes: GraphNode[] = [devNode("dev-a")];
      nodes.length = 3;
      nodes[2] = devNode("dev-c");
      return devSnapshot(nodes, baseEdges(), "dev-c");
    }, "GRAPH_MALFORMED_NODE"],
    ["not an object", () => 7, "GRAPH_MALFORMED_SNAPSHOT"],
    ["null", () => null, "GRAPH_MALFORMED_SNAPSHOT"],
  ];

  it("refuses every hostile shape with the validator's own code", () => {
    expect(HOSTILE.length).toBeGreaterThan(0);
    for (const [label, build, code] of HOSTILE) {
      const result = encodeGraphContent(build());
      const pairs = pairsOf(result);
      expect(pairs.map(([issueCode]) => issueCode), label).toContain(code);
      for (const [, layer] of pairs) {
        expect(layer, label).toBe("GRAPH_VALIDATION");
      }
    }
  });

  it("refuses a malformed policy override at the validator's layer", () => {
    const pairs = pairsOf(encodeGraphContent(baseSnapshot(), { maxNodes: -1 }));
    expect(pairs).toEqual([["GRAPH_MALFORMED_POLICY", "GRAPH_VALIDATION"]]);
  });
});

// --- runtime bridges ---------------------------------------------------------

/**
 * Every non-test module here needs a committed one-line `.js` sibling: internal
 * imports are written with `.js` specifiers, and the plain-Node entrypoint smoke
 * worker resolves them literally. Vitest resolves the `.ts` directly and tsc
 * never looks at these files, so a missing or CRLF bridge is invisible to both
 * — this byte comparison is the only cheap guard.
 */
describe("runtime bridges", () => {
  it.each([
    ["graph-content", "graph-content.ts"],
    ["graph-content-format", "graph-content-format.ts"],
  ])("publishes the exact one-line LF bridge for %s", (name, target) => {
    const bridge = readFileSync(
      new URL(`./${name}.js`, import.meta.url),
      "utf8",
    );
    expect(bridge).toBe(`export * from "./${target}";\n`);
  });
});

// --- vocabulary --------------------------------------------------------------

describe("graph content vocabulary", () => {
  it("declares closed, frozen, sorted vocabularies", () => {
    expect(Object.isFrozen(GRAPH_CONTENT_ISSUE_CODES)).toBe(true);
    expect(Object.isFrozen(GRAPH_CONTENT_LAYERS)).toBe(true);
    expect([...GRAPH_CONTENT_ISSUE_CODES])
      .toEqual([...GRAPH_CONTENT_ISSUE_CODES].sort());
    expect([...GRAPH_CONTENT_LAYERS]).toEqual([...GRAPH_CONTENT_LAYERS].sort());
    expect(new Set(GRAPH_CONTENT_ISSUE_CODES).size)
      .toBe(GRAPH_CONTENT_ISSUE_CODES.length);
  });

  /**
   * A code the module declares but no path can emit is a guard this module only
   * claims to have. Every member below is produced by a real refusal above.
   */
  it("emits every declared codec code from a real path", () => {
    const canonical = textOf(okValue(encodeGraphContent(baseSnapshot())).bytes);
    const encoded = okValue(encodeGraphContent(baseSnapshot()));
    const produced = new Set<string>();
    const record = (result: GraphContentResult): void => {
      for (const [code] of pairsOf(result)) produced.add(code);
    };

    record(decodeGraphContent("not bytes"));
    record(decodeGraphContent(new Uint8Array(MAX_GRAPH_CONTENT_BYTES + 1)));
    record(decodeGraphContent(new Uint8Array([0xff])));
    record(decodeGraphContent(ENCODER.encode("[]")));
    record(decodeGraphContent(ENCODER.encode(
      canonical.replace("MOE-GRAPH-CONTENT/1", "MOE-GRAPH-CONTENT/2"))));
    record(decodeGraphContent(ENCODER.encode(
      textOf(encoded.bytes).replace(encoded.graphContentHash, "b".repeat(64)))));
    record(decodeGraphContent(ENCODER.encode(` ${canonical}`)));

    expect([...produced].sort()).toEqual([...GRAPH_CONTENT_ISSUE_CODES]);
  });

  it("uses every declared layer", () => {
    const used = new Set<string>();
    for (const [, layer] of pairsOf(decodeGraphContent(null))) used.add(layer);
    const encoded = okValue(encodeGraphContent(baseSnapshot()));
    for (const [, layer] of pairsOf(decodeGraphContent(ENCODER.encode(
      textOf(encoded.bytes).replace(encoded.graphContentHash, "b".repeat(64)))))) {
      used.add(layer);
    }
    for (const [, layer] of pairsOf(encodeGraphContent(null))) used.add(layer);
    expect([...used].sort()).toEqual([...GRAPH_CONTENT_LAYERS]);
  });
});
