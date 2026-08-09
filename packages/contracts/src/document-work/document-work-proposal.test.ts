import { describe, expect, it } from "vitest";

import {
  ADVISORY_ENVELOPE,
  api,
  candidate,
  decoded,
  encoder,
  expectAccepted,
  expectRefusal,
  proposal,
  source,
} from "./document-work-proposal.test-fixtures.js";

describe("document-work proposal public contract", () => {
  it("publishes the exact frozen schema, error, layer, and limit vocabularies", () => {
    expect(api.DOCUMENT_WORK_PROPOSAL_SCHEMA_VERSION).toBe("moe-document-work-proposal/1");
    expect(api.DOCUMENT_WORK_PROPOSAL_ERROR_CODES).toStrictEqual([
      "DOCUMENT_WORK_PROPOSAL_INPUT_REJECTED",
      "DOCUMENT_WORK_PROPOSAL_SCHEMA_UNSUPPORTED",
      "DOCUMENT_WORK_PROPOSAL_SHAPE_INVALID",
      "DOCUMENT_WORK_PROPOSAL_LIMIT_EXCEEDED",
      "DOCUMENT_WORK_PROPOSAL_DUPLICATE_REF",
      "DOCUMENT_WORK_PROPOSAL_SOURCE_UNBOUND",
      "DOCUMENT_WORK_PROPOSAL_SOURCE_CONFLICT",
    ]);
    expect(api.DOCUMENT_WORK_PROPOSAL_LAYERS).toStrictEqual([
      "BOUNDED_JSON", "SCHEMA", "SHAPE", "LIMIT", "IDENTITY", "PROVENANCE",
    ]);
    expect(api.DOCUMENT_WORK_PROPOSAL_LIMITS).toStrictEqual({
      maxCandidates: 24,
      maxCitations: 64,
      maxDisplayPathCodeUnits: 256,
      maxObjectiveUtf8Bytes: 32 * 1024,
      maxRefCodeUnits: 256,
      maxSources: 32,
      maxTitleCodeUnits: 256,
    });
    expect([
      Object.isFrozen(api.DOCUMENT_WORK_PROPOSAL_ERROR_CODES),
      Object.isFrozen(api.DOCUMENT_WORK_PROPOSAL_LAYERS),
      Object.isFrozen(api.DOCUMENT_WORK_PROPOSAL_LIMITS),
    ]).toStrictEqual([true, true, true]);
  });

  it("accepts only an explicitly zero-authority unsubmitted agent proposal", () => {
    const accepted = expectAccepted(proposal());
    expect(accepted).toStrictEqual(proposal());
    expect([
      accepted["advisoryOnly"], accepted["authority"], accepted["submissionState"],
      accepted["truthClass"],
    ]).toStrictEqual([true, "NONE", "NOT_SUBMITTED", "AGENT_REPORTED"]);
  });

  it.each([
    ["advisoryOnly", false],
    ["authority", "FULL"],
    ["submissionState", "SUBMITTED"],
    ["truthClass", "DAEMON_VERIFIED"],
  ])("refuses a mutated forced literal %s", (key, value) => {
    expectRefusal(
      decoded(proposal({ [key]: value })),
      "DOCUMENT_WORK_PROPOSAL_SHAPE_INVALID",
      "SHAPE",
    );
  });

  it("distinguishes unsupported schema from malformed exact shapes", () => {
    expectRefusal(
      decoded(proposal({ schemaVersion: "moe-document-work-proposal/2" })),
      "DOCUMENT_WORK_PROPOSAL_SCHEMA_UNSUPPORTED",
      "SCHEMA",
    );
    expectRefusal(
      decoded({ ...proposal(), unexpected: true }),
      "DOCUMENT_WORK_PROPOSAL_SHAPE_INVALID",
      "SHAPE",
    );
    expectRefusal(
      decoded(proposal({ sources: [{ ...source(), unexpected: true }] })),
      "DOCUMENT_WORK_PROPOSAL_SHAPE_INVALID",
      "SHAPE",
    );
    const malformedCandidate = { ...candidate() };
    delete malformedCandidate.title;
    expectRefusal(
      decoded(proposal({ candidates: [malformedCandidate] })),
      "DOCUMENT_WORK_PROPOSAL_SHAPE_INVALID",
      "SHAPE",
    );
  });

  it("wraps malformed and hostile byte inputs at the bounded JSON layer", () => {
    const syntax = api.decodeDocumentWorkProposalBytes(encoder.encode("{"));
    expect(syntax).toStrictEqual({
      ...ADVISORY_ENVELOPE,
      code: "DOCUMENT_WORK_PROPOSAL_INPUT_REJECTED",
      decodeError: {
        code: "JSON_SYNTAX_INVALID",
        message: "JSON text is not syntactically valid.",
        ok: false,
      },
      layer: "BOUNDED_JSON",
      ok: false,
      outcome: "REFUSED",
    });
    const revoked = Proxy.revocable(Uint8Array.of(123), {});
    revoked.revoke();
    const hostile = api.decodeDocumentWorkProposalBytes(revoked.proxy);
    expect(hostile.code).toBe("DOCUMENT_WORK_PROPOSAL_INPUT_REJECTED");
    expect(hostile.layer).toBe("BOUNDED_JSON");
    expect({ advisoryOnly: hostile.advisoryOnly, authority: hostile.authority })
      .toStrictEqual(ADVISORY_ENVELOPE);
    expect(hostile.decodeError?.code).toBe("JSON_INPUT_TYPE_INVALID");
    expect(Object.isFrozen(hostile)).toBe(true);
  });

  it("accepts 32 sources and refuses 33", () => {
    const atLimit = Array.from({ length: 32 }, (_, index) => source(index));
    expect(expectAccepted(proposal({ sources: atLimit })).sources).toHaveLength(32);
    expectRefusal(
      decoded(proposal({ sources: [...atLimit, source(32)] })),
      "DOCUMENT_WORK_PROPOSAL_LIMIT_EXCEEDED",
      "LIMIT",
    );
  });

  it("accepts 24 candidates and refuses 25", () => {
    const sources = Array.from({ length: 24 }, (_, index) => source(index));
    const atLimit = Array.from({ length: 24 }, (_, index) => candidate(index));
    expect(expectAccepted(proposal({ candidates: atLimit, sources })).candidates).toHaveLength(24);
    expectRefusal(
      decoded(proposal({ candidates: [...atLimit, candidate(24)], sources: [...sources, source(24)] })),
      "DOCUMENT_WORK_PROPOSAL_LIMIT_EXCEEDED",
      "LIMIT",
    );
  });

  it("accepts 64 citations and refuses 65", () => {
    const sources = Array.from({ length: 32 }, (_, index) => source(index));
    const allRefs = sources.map((entry) => entry.sourceRef);
    const atLimit = [candidate(0, { sourceRefs: allRefs }), candidate(1, { sourceRefs: allRefs })];
    expect(expectAccepted(proposal({ candidates: atLimit, sources })).candidates).toHaveLength(2);
    expectRefusal(
      decoded(proposal({
        candidates: [...atLimit, candidate(2, { sourceRefs: ["source-0"] })], sources,
      })),
      "DOCUMENT_WORK_PROPOSAL_LIMIT_EXCEEDED",
      "LIMIT",
    );
  });

  it.each([
    ["project ref", () => proposal({ projectId: "p".repeat(256) }),
      () => proposal({ projectId: "p".repeat(257) })],
    ["source ref", () => {
      const ref = "s".repeat(256);
      return proposal({
        candidates: [candidate(0, { sourceRefs: [ref] })],
        sources: [source(0, { sourceRef: ref })],
      });
    }, () => proposal({ sources: [source(0, { sourceRef: "s".repeat(257) })] })],
    ["candidate ref", () => proposal({
      candidates: [candidate(0, { candidateRef: "c".repeat(256) })],
    }), () => proposal({
      candidates: [candidate(0, { candidateRef: "c".repeat(257) })],
    })],
    ["citation ref", () => {
      const ref = "r".repeat(256);
      return proposal({
        candidates: [candidate(0, { sourceRefs: [ref] })],
        sources: [source(0, { sourceRef: ref })],
      });
    }, () => proposal({
      candidates: [candidate(0, { sourceRefs: ["r".repeat(257)] })],
    })],
    ["display path", () => proposal({ sources: [source(0, { displayPath: "p".repeat(256) })] }),
      () => proposal({ sources: [source(0, { displayPath: "p".repeat(257) })] })],
    ["title", () => proposal({ candidates: [candidate(0, { title: "t".repeat(256) })] }),
      () => proposal({ candidates: [candidate(0, { title: "t".repeat(257) })] })],
    ["objective bytes", () => proposal({ candidates: [candidate(0, { objective: "o".repeat(32 * 1024) })] }),
      () => proposal({ candidates: [candidate(0, { objective: "o".repeat(32 * 1024 + 1) })] })],
  ])("pins the exact N/N+1 %s limit", (_label, atLimit, overLimit) => {
    expect(expectAccepted(atLimit())).toBeDefined();
    expectRefusal(
      decoded(overLimit()),
      "DOCUMENT_WORK_PROPOSAL_LIMIT_EXCEEDED",
      "LIMIT",
    );
  });

  it("measures objective limits in UTF-8 bytes rather than code units", () => {
    expect(expectAccepted(proposal({
      candidates: [candidate(0, { objective: "é".repeat(16 * 1024) })],
    }))).toBeDefined();
    expectRefusal(
      decoded(proposal({ candidates: [candidate(0, { objective: `é${"o".repeat(32 * 1024 - 1)}` })] })),
      "DOCUMENT_WORK_PROPOSAL_LIMIT_EXCEEDED",
      "LIMIT",
    );
  });
});
