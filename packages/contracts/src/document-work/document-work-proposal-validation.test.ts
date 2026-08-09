import { describe, expect, it } from "vitest";

import {
  CONTROL_CODE_POINTS,
  HASH_A,
  HASH_B,
  api,
  bytes,
  candidate,
  decoded,
  expectAccepted,
  expectRefusal,
  proposal,
  source,
} from "./document-work-proposal.test-fixtures.js";

describe("document-work proposal provenance and immutability", () => {
  it("refuses duplicate source, candidate, and per-candidate citation refs", () => {
    for (const value of [
      proposal({ sources: [source(), source()] }),
      proposal({ candidates: [candidate(), candidate()] }),
      proposal({ candidates: [candidate(0, { sourceRefs: ["source-0", "source-0"] })] }),
    ]) {
      expectRefusal(
        decoded(value),
        "DOCUMENT_WORK_PROPOSAL_DUPLICATE_REF",
        "IDENTITY",
      );
    }
  });

  it("reports duplicate identity before unbound provenance regardless of candidate order", () => {
    const multiset = [
      candidate(2, { sourceRefs: ["source-missing"] }),
      candidate(1, { sourceRefs: ["source-0"] }),
      candidate(1, { sourceRefs: ["source-0"] }),
    ];
    for (const candidates of [multiset, [...multiset].reverse()]) {
      expectRefusal(
        decoded(proposal({ candidates })),
        "DOCUMENT_WORK_PROPOSAL_DUPLICATE_REF",
        "IDENTITY",
      );
    }
  });

  it("rejects conflicting source identities for one display path but permits identical aliases", () => {
    const shared = { byteLength: 128, contentSha256: HASH_A, displayPath: "docs/shared.md" };
    const identicalAliases = [source(0, shared), source(1, shared)];
    expect(expectAccepted(proposal({ sources: identicalAliases })).sources).toHaveLength(2);

    for (const conflicting of [
      source(1, { ...shared, contentSha256: HASH_B }),
      source(1, { ...shared, byteLength: 129 }),
    ]) {
      expectRefusal(
        decoded(proposal({ sources: [source(0, shared), conflicting] })),
        "DOCUMENT_WORK_PROPOSAL_SOURCE_CONFLICT",
        "PROVENANCE",
      );
    }
  });

  it.each(CONTROL_CODE_POINTS)(
    "rejects U+%s from every bounded single-line field",
    (codePoint) => {
      const contaminated = `safe${String.fromCodePoint(codePoint)}value`;
      for (const value of [
        proposal({ projectId: contaminated }),
        proposal({ sources: [source(0, { sourceRef: contaminated })] }),
        proposal({ sources: [source(0, { displayPath: contaminated })] }),
        proposal({ candidates: [candidate(0, { candidateRef: contaminated })] }),
        proposal({ candidates: [candidate(0, { title: contaminated })] }),
        proposal({ candidates: [candidate(0, { sourceRefs: [contaminated] })] }),
      ]) {
        expectRefusal(
          decoded(value),
          "DOCUMENT_WORK_PROPOSAL_SHAPE_INVALID",
          "SHAPE",
        );
      }
    },
  );

  it("allows normal multiline objectives while continuing to refuse NUL", () => {
    const multiline = "Read the docs.\r\n\tThen propose bounded work.";
    const accepted = expectAccepted(proposal({
      candidates: [candidate(0, { objective: multiline })],
    }));
    const acceptedCandidates = accepted["candidates"] as readonly Record<string, unknown>[];
    expect(acceptedCandidates[0]?.objective).toBe(multiline);
    expectRefusal(
      decoded(proposal({ candidates: [candidate(0, { objective: "before\u0000after" })] })),
      "DOCUMENT_WORK_PROPOSAL_SHAPE_INVALID",
      "SHAPE",
    );
  });

  it("refuses every candidate citation not bound by the source set", () => {
    expectRefusal(
      decoded(proposal({ candidates: [candidate(0, { sourceRefs: ["source-missing"] })] })),
      "DOCUMENT_WORK_PROPOSAL_SOURCE_UNBOUND",
      "PROVENANCE",
    );
  });

  it.each(["A".repeat(64), "a".repeat(63), `${"a".repeat(64)}a`, "z".repeat(64)])(
    "refuses malformed lowercase SHA-256 identity %s",
    (digest) => {
      expectRefusal(
        decoded(proposal({ repositoryBaseHash: digest })),
        "DOCUMENT_WORK_PROPOSAL_SHAPE_INVALID",
        "SHAPE",
      );
      expectRefusal(
        decoded(proposal({ sources: [source(0, { contentSha256: digest })] })),
        "DOCUMENT_WORK_PROPOSAL_SHAPE_INVALID",
        "SHAPE",
      );
    },
  );

  it("normalizes identity order and returns a deeply frozen detached proposal", () => {
    const input = proposal({
      candidates: [candidate(1, { sourceRefs: ["source-1", "source-0"] }), candidate(0)],
      sources: [source(1), source(0)],
    });
    const inputBytes = bytes(input);
    const result = api.decodeDocumentWorkProposalBytes(inputBytes);
    inputBytes.fill(0);
    expect(result.ok).toBe(true);
    if (!result.ok || result.proposal === undefined) throw new Error("proposal was refused");
    const sources = result.proposal["sources"] as readonly Readonly<Record<string, unknown>>[];
    const candidates = result.proposal["candidates"] as readonly Readonly<Record<string, unknown>>[];
    expect(sources.map((entry) => entry.sourceRef)).toStrictEqual(["source-0", "source-1"]);
    expect(candidates.map((entry) => entry.candidateRef)).toStrictEqual([
      "candidate-0", "candidate-1",
    ]);
    expect(candidates[1]?.sourceRefs).toStrictEqual(["source-0", "source-1"]);
    expect([
      Object.isFrozen(result), Object.isFrozen(result.proposal), Object.isFrozen(sources),
      Object.isFrozen(sources[0]), Object.isFrozen(candidates), Object.isFrozen(candidates[0]),
      Object.isFrozen(candidates[1]?.sourceRefs),
    ]).toStrictEqual([true, true, true, true, true, true, true]);
  });
});
