import { describe, expect, it } from "vitest";

import * as contracts from "@moe/contracts";

interface ProposalResult {
  readonly ok: boolean;
  readonly outcome: string;
  readonly code?: string;
  readonly layer?: string;
  readonly decodeError?: { readonly code: string; readonly ok: false };
  readonly proposal?: Readonly<Record<string, unknown>>;
}

interface DocumentWorkApi {
  readonly DOCUMENT_WORK_PROPOSAL_ERROR_CODES: readonly string[];
  readonly DOCUMENT_WORK_PROPOSAL_LAYERS: readonly string[];
  readonly DOCUMENT_WORK_PROPOSAL_LIMITS: Readonly<Record<string, number>>;
  readonly DOCUMENT_WORK_PROPOSAL_SCHEMA_VERSION: string;
  readonly decodeDocumentWorkProposalBytes: (input: unknown) => ProposalResult;
}

const api = contracts as unknown as DocumentWorkApi;
const encoder = new TextEncoder();
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function bytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function source(index = 0, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    byteLength: 128 + index,
    contentSha256: index % 2 === 0 ? HASH_A : HASH_B,
    displayPath: `docs/source-${index}.md`,
    sourceRef: `source-${index}`,
    ...overrides,
  };
}

function candidate(
  index = 0,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    candidateRef: `candidate-${index}`,
    objective: `Implement candidate ${index} from the cited project documents.`,
    sourceRefs: [`source-${index}`],
    title: `Candidate ${index}`,
    ...overrides,
  };
}

function proposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    advisoryOnly: true,
    authority: "NONE",
    candidates: [candidate()],
    contextManifestDigest: HASH_B,
    projectId: "project-1",
    repositoryBaseHash: HASH_A,
    schemaVersion: "moe-document-work-proposal/1",
    sources: [source()],
    submissionState: "NOT_SUBMITTED",
    truthClass: "AGENT_REPORTED",
    ...overrides,
  };
}

function decoded(value: unknown): ProposalResult {
  return api.decodeDocumentWorkProposalBytes(bytes(value));
}

function expectRefusal(
  result: ProposalResult,
  code: string,
  layer: string,
): void {
  expect(result).toStrictEqual({ code, layer, ok: false, outcome: "REFUSED" });
  expect(Object.isFrozen(result)).toBe(true);
}

function expectAccepted(value: unknown): Readonly<Record<string, unknown>> {
  const result = decoded(value);
  expect(result.ok).toBe(true);
  if (!result.ok || result.proposal === undefined) throw new Error("proposal was refused");
  expect(result.outcome).toBe("PROPOSED");
  return result.proposal;
}

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
