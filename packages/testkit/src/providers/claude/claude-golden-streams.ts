import { createHash } from "node:crypto";

import { identifyCanonicalEvidence } from "../../evidence-digest.js";

/**
 * Golden Claude provider streams for the adapter contract (design 11.5).
 *
 * Every fixture here is `DEVELOPMENT_ONLY` and `NOT_CONFIRMATORY`: these are
 * plausible shapes used to pin adapter behaviour, never evidence about what the
 * installed CLI actually emits. Nothing in this corpus may be cited as proof of
 * a provider capability.
 *
 * ## Why every payload is base64
 *
 * `.gitattributes` opens with `* text=auto eol=lf`, so a committed text file
 * containing `\r\n` is silently normalised to `\n` on the way in. A raw Windows
 * provider stream is exactly such a file, and its pinned digest would then never
 * match the bytes it was computed from. Base64 is inert under that
 * normalisation, so it is the only representation that survives without editing
 * repository-wide attributes. The `complete` fixture deliberately carries CRLF
 * line endings so that this stays a tested property rather than a comment.
 *
 * ## Why the data lives in a marked block
 *
 * Runner tests consume this corpus but cannot import it: `packages/runner`
 * typechecks with `rootDir: "src"`, so a relative import of a file in another
 * package fails the runner's own gate. They read this file as data instead. The
 * marker comments below delimit a single JSON document in a template literal —
 * one extraction rule, no dependence on field order or formatting — and the
 * per-case `sha256` is taken over the RAW DECODED BYTES, so a reader can verify
 * a fixture with nothing but a sha256 implementation. That is deliberate: it
 * keeps the two packages from having to agree on a canonicalizer.
 */
export const CLAUDE_GOLDEN_CORPUS_VERSION = "moe-claude-golden-corpus/1" as const;

export const CLAUDE_GOLDEN_CORPUS_DATA_BEGIN = "moe-claude-golden-corpus/1 DATA BEGIN";
export const CLAUDE_GOLDEN_CORPUS_DATA_END = "moe-claude-golden-corpus/1 DATA END";

/** The closed corpus of design 11.5. Adding a case is a contract change. */
export const CLAUDE_GOLDEN_CASE_IDS = Object.freeze([
  "cancelled",
  "complete",
  "crashed",
  "duplicated",
  "malformed",
  "reordered",
  "resumed",
  "truncated",
  "version-mismatched",
] as const);
export type ClaudeGoldenCaseId = (typeof CLAUDE_GOLDEN_CASE_IDS)[number];

export interface ClaudeGoldenStream {
  readonly caseId: ClaudeGoldenCaseId;
  readonly label: "DEVELOPMENT_ONLY";
  readonly confirmatory: "NOT_CONFIRMATORY";
  readonly expectation: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly rawBase64: string;
}

/* moe-claude-golden-corpus/1 DATA BEGIN */
const CORPUS_JSON = `{
  "corpusVersion": "moe-claude-golden-corpus/1",
  "label": "DEVELOPMENT_ONLY",
  "confirmatory": "NOT_CONFIRMATORY",
  "cases": [
    {
      "caseId": "cancelled",
      "expectation": "Terminal result record reports subtype cancelled after a clean prefix.",
      "byteLength": 316,
      "sha256": "de75dcfea262791ae36c3b29d1e973dcc3647a156405379670b985a8adf873c5",
      "rawBase64": "eyJzY2hlbWFWZXJzaW9uIjoiY2xhdWRlLXN0cmVhbS1qc29uLzEiLCJzZXEiOjEsInR5cGUiOiJzeXN0ZW0iLCJzdWJ0eXBlIjoiaW5pdCIsInJ1bklkIjoicnVuLWdvbGRlbi1jYW5jZWxsZWQifQp7InNjaGVtYVZlcnNpb24iOiJjbGF1ZGUtc3RyZWFtLWpzb24vMSIsInNlcSI6MiwidHlwZSI6ImFzc2lzdGFudCIsInRleHQiOiJyZWFkaW5nIGZpbGVzIn0KeyJzY2hlbWFWZXJzaW9uIjoiY2xhdWRlLXN0cmVhbS1qc29uLzEiLCJzZXEiOjMsInR5cGUiOiJyZXN1bHQiLCJzdWJ0eXBlIjoiY2FuY2VsbGVkIiwic3RvcFJlYXNvbiI6ImNhbmNlbGxlZCJ9Cg=="
    },
    {
      "caseId": "complete",
      "expectation": "Well formed CRLF stream ending in a success result; carries literal 0x0D 0x0A bytes.",
      "byteLength": 320,
      "sha256": "979c868b3f1129f0fda14b279e48ff4553780c3d3bc0279ba1721c4752d1ee36",
      "rawBase64": "eyJzY2hlbWFWZXJzaW9uIjoiY2xhdWRlLXN0cmVhbS1qc29uLzEiLCJzZXEiOjEsInR5cGUiOiJzeXN0ZW0iLCJzdWJ0eXBlIjoiaW5pdCIsInJ1bklkIjoicnVuLWdvbGRlbi1jb21wbGV0ZSJ9DQp7InNjaGVtYVZlcnNpb24iOiJjbGF1ZGUtc3RyZWFtLWpzb24vMSIsInNlcSI6MiwidHlwZSI6ImFzc2lzdGFudCIsInRleHQiOiJhcHBseWluZyB0aGUgcGF0Y2gifQ0KeyJzY2hlbWFWZXJzaW9uIjoiY2xhdWRlLXN0cmVhbS1qc29uLzEiLCJzZXEiOjMsInR5cGUiOiJyZXN1bHQiLCJzdWJ0eXBlIjoic3VjY2VzcyIsInN0b3BSZWFzb24iOiJlbmRfdHVybiJ9DQo="
    },
    {
      "caseId": "crashed",
      "expectation": "Stream stops after a mid-run record with no terminal result record.",
      "byteLength": 205,
      "sha256": "82be237b5bda6902b6d52c45116364b34581418484401ef89cc57d618bb6197d",
      "rawBase64": "eyJzY2hlbWFWZXJzaW9uIjoiY2xhdWRlLXN0cmVhbS1qc29uLzEiLCJzZXEiOjEsInR5cGUiOiJzeXN0ZW0iLCJzdWJ0eXBlIjoiaW5pdCIsInJ1bklkIjoicnVuLWdvbGRlbi1jcmFzaGVkIn0KeyJzY2hlbWFWZXJzaW9uIjoiY2xhdWRlLXN0cmVhbS1qc29uLzEiLCJzZXEiOjIsInR5cGUiOiJhc3Npc3RhbnQiLCJ0ZXh0IjoiaGFsZiB3YXkgdGhyb3VnaCJ9Cg=="
    },
    {
      "caseId": "duplicated",
      "expectation": "Sequence 2 is delivered twice, byte identical.",
      "byteLength": 409,
      "sha256": "0fabdac7872e22e6b2d70e8b21ae18585c074f62c51e2eee61d74c1538a4e5dc",
      "rawBase64": "eyJzY2hlbWFWZXJzaW9uIjoiY2xhdWRlLXN0cmVhbS1qc29uLzEiLCJzZXEiOjEsInR5cGUiOiJzeXN0ZW0iLCJzdWJ0eXBlIjoiaW5pdCIsInJ1bklkIjoicnVuLWdvbGRlbi1kdXBsaWNhdGVkIn0KeyJzY2hlbWFWZXJzaW9uIjoiY2xhdWRlLXN0cmVhbS1qc29uLzEiLCJzZXEiOjIsInR5cGUiOiJhc3Npc3RhbnQiLCJ0ZXh0IjoiZGVsaXZlcmVkIHR3aWNlIn0KeyJzY2hlbWFWZXJzaW9uIjoiY2xhdWRlLXN0cmVhbS1qc29uLzEiLCJzZXEiOjIsInR5cGUiOiJhc3Npc3RhbnQiLCJ0ZXh0IjoiZGVsaXZlcmVkIHR3aWNlIn0KeyJzY2hlbWFWZXJzaW9uIjoiY2xhdWRlLXN0cmVhbS1qc29uLzEiLCJzZXEiOjMsInR5cGUiOiJyZXN1bHQiLCJzdWJ0eXBlIjoic3VjY2VzcyIsInN0b3BSZWFzb24iOiJlbmRfdHVybiJ9Cg=="
    },
    {
      "caseId": "malformed",
      "expectation": "Second line is a truncated JSON object that still ends with a newline.",
      "byteLength": 290,
      "sha256": "408472d648805201a3709d1c383a810ac375574ad14d848ae21011a6e27e57d5",
      "rawBase64": "eyJzY2hlbWFWZXJzaW9uIjoiY2xhdWRlLXN0cmVhbS1qc29uLzEiLCJzZXEiOjEsInR5cGUiOiJzeXN0ZW0iLCJzdWJ0eXBlIjoiaW5pdCIsInJ1bklkIjoicnVuLWdvbGRlbi1tYWxmb3JtZWQifQp7InNjaGVtYVZlcnNpb24iOiJjbGF1ZGUtc3RyZWFtLWpzb24vMSIsInNlcSI6MiwidHlwZSI6ImFzc2lzdGFudCIsCnsic2NoZW1hVmVyc2lvbiI6ImNsYXVkZS1zdHJlYW0tanNvbi8xIiwic2VxIjozLCJ0eXBlIjoicmVzdWx0Iiwic3VidHlwZSI6InN1Y2Nlc3MiLCJzdG9wUmVhc29uIjoiZW5kX3R1cm4ifQo="
    },
    {
      "caseId": "reordered",
      "expectation": "Sequence 3 arrives before sequence 2.",
      "byteLength": 405,
      "sha256": "4016a7970b121d4d35ce8a3ff7e6bcd9c2b25f2ddcb0ce6af9798443c803f39c",
      "rawBase64": "eyJzY2hlbWFWZXJzaW9uIjoiY2xhdWRlLXN0cmVhbS1qc29uLzEiLCJzZXEiOjEsInR5cGUiOiJzeXN0ZW0iLCJzdWJ0eXBlIjoiaW5pdCIsInJ1bklkIjoicnVuLWdvbGRlbi1yZW9yZGVyZWQifQp7InNjaGVtYVZlcnNpb24iOiJjbGF1ZGUtc3RyZWFtLWpzb24vMSIsInNlcSI6MywidHlwZSI6ImFzc2lzdGFudCIsInRleHQiOiJzZWNvbmQgdGhvdWdodCJ9Cnsic2NoZW1hVmVyc2lvbiI6ImNsYXVkZS1zdHJlYW0tanNvbi8xIiwic2VxIjoyLCJ0eXBlIjoiYXNzaXN0YW50IiwidGV4dCI6ImZpcnN0IHRob3VnaHQifQp7InNjaGVtYVZlcnNpb24iOiJjbGF1ZGUtc3RyZWFtLWpzb24vMSIsInNlcSI6NCwidHlwZSI6InJlc3VsdCIsInN1YnR5cGUiOiJzdWNjZXNzIiwic3RvcFJlYXNvbiI6ImVuZF90dXJuIn0K"
    },
    {
      "caseId": "resumed",
      "expectation": "Stream opens at sequence 7 declaring resumedFrom; resume is UNSUPPORTED in v1.",
      "byteLength": 346,
      "sha256": "b8cae9b3dfd62fba54747b8b8ad9fc13a1b616499d4148475a44962d9da67767",
      "rawBase64": "eyJzY2hlbWFWZXJzaW9uIjoiY2xhdWRlLXN0cmVhbS1qc29uLzEiLCJzZXEiOjcsInR5cGUiOiJzeXN0ZW0iLCJzdWJ0eXBlIjoicmVzdW1lIiwicnVuSWQiOiJydW4tZ29sZGVuLXJlc3VtZWQiLCJyZXN1bWVkRnJvbSI6InJ1bi1nb2xkZW4tY29tcGxldGUifQp7InNjaGVtYVZlcnNpb24iOiJjbGF1ZGUtc3RyZWFtLWpzb24vMSIsInNlcSI6OCwidHlwZSI6ImFzc2lzdGFudCIsInRleHQiOiJjb250aW51aW5nIn0KeyJzY2hlbWFWZXJzaW9uIjoiY2xhdWRlLXN0cmVhbS1qc29uLzEiLCJzZXEiOjksInR5cGUiOiJyZXN1bHQiLCJzdWJ0eXBlIjoic3VjY2VzcyIsInN0b3BSZWFzb24iOiJlbmRfdHVybiJ9Cg=="
    },
    {
      "caseId": "truncated",
      "expectation": "Final line is cut mid object with no trailing newline.",
      "byteLength": 262,
      "sha256": "07b53616f8d33b627a532b367dca2ef3385b68199f916b96e6478e6c570d73be",
      "rawBase64": "eyJzY2hlbWFWZXJzaW9uIjoiY2xhdWRlLXN0cmVhbS1qc29uLzEiLCJzZXEiOjEsInR5cGUiOiJzeXN0ZW0iLCJzdWJ0eXBlIjoiaW5pdCIsInJ1bklkIjoicnVuLWdvbGRlbi10cnVuY2F0ZWQifQp7InNjaGVtYVZlcnNpb24iOiJjbGF1ZGUtc3RyZWFtLWpzb24vMSIsInNlcSI6MiwidHlwZSI6ImFzc2lzdGFudCIsInRleHQiOiJjdXQgb2ZmIG5leHQifQp7InNjaGVtYVZlcnNpb24iOiJjbGF1ZGUtc3RyZWFtLWpzb24vMSIsInNlcSI6MywidHlwZSI6InJlcw=="
    },
    {
      "caseId": "version-mismatched",
      "expectation": "Records switch to an unknown schema version mid stream.",
      "byteLength": 321,
      "sha256": "3b0a727509c1d7d1f014b87d2bfc23224481e552790d19099c862b330e7c0816",
      "rawBase64": "eyJzY2hlbWFWZXJzaW9uIjoiY2xhdWRlLXN0cmVhbS1qc29uLzEiLCJzZXEiOjEsInR5cGUiOiJzeXN0ZW0iLCJzdWJ0eXBlIjoiaW5pdCIsInJ1bklkIjoicnVuLWdvbGRlbi12ZXJzaW9uLW1pc21hdGNoZWQifQp7InNjaGVtYVZlcnNpb24iOiJjbGF1ZGUtc3RyZWFtLWpzb24vMiIsInNlcSI6MiwidHlwZSI6ImFzc2lzdGFudCIsInRleHQiOiJuZXdlciBzY2hlbWEifQp7InNjaGVtYVZlcnNpb24iOiJjbGF1ZGUtc3RyZWFtLWpzb24vMiIsInNlcSI6MywidHlwZSI6InJlc3VsdCIsInN1YnR5cGUiOiJzdWNjZXNzIiwic3RvcFJlYXNvbiI6ImVuZF90dXJuIn0K"
    }
  ]
}`;
/* moe-claude-golden-corpus/1 DATA END */

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

interface RawCorpusCase {
  readonly caseId: string;
  readonly expectation: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly rawBase64: string;
}

function decodeBase64(rawBase64: string): Uint8Array {
  return new Uint8Array(Buffer.from(rawBase64, "base64"));
}

/**
 * sha256 over RAW bytes, deliberately not the canonical-JSON identity. This is
 * the digest an out-of-package reader re-verifies, so it must depend on nothing
 * but the bytes themselves.
 */
function digestOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isCase(value: unknown): value is RawCorpusCase {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["caseId"] === "string" &&
    typeof candidate["expectation"] === "string" &&
    typeof candidate["byteLength"] === "number" &&
    typeof candidate["sha256"] === "string" &&
    typeof candidate["rawBase64"] === "string"
  );
}

/**
 * Validation runs at module load and throws. A drifted fixture must fail loudly
 * on first import rather than quietly hand a consumer bytes that no longer match
 * the digest they were pinned to.
 */
function parseCorpus(): readonly ClaudeGoldenStream[] {
  const parsed: unknown = JSON.parse(CORPUS_JSON);
  if (typeof parsed !== "object" || parsed === null) {
    throw new TypeError("claude golden corpus is not an object");
  }
  const document = parsed as Record<string, unknown>;
  if (document["corpusVersion"] !== CLAUDE_GOLDEN_CORPUS_VERSION) {
    throw new TypeError("claude golden corpus declares an unsupported version");
  }
  const cases = document["cases"];
  if (!Array.isArray(cases)) {
    throw new TypeError("claude golden corpus has no case list");
  }
  const streams = cases.map((entry: unknown): ClaudeGoldenStream => {
    if (!isCase(entry)) {
      throw new TypeError("claude golden corpus holds a malformed case");
    }
    const caseId = entry.caseId as ClaudeGoldenCaseId;
    if (!CLAUDE_GOLDEN_CASE_IDS.includes(caseId)) {
      throw new TypeError(`claude golden corpus holds an unknown case ${JSON.stringify(caseId)}`);
    }
    if (!SHA256_PATTERN.test(entry.sha256)) {
      throw new TypeError(`case ${caseId} has no sha256 digest`);
    }
    const bytes = decodeBase64(entry.rawBase64);
    if (Buffer.from(bytes).toString("base64") !== entry.rawBase64) {
      throw new TypeError(`case ${caseId} does not round-trip through base64`);
    }
    if (bytes.byteLength !== entry.byteLength) {
      throw new TypeError(`case ${caseId} declares ${entry.byteLength} bytes but decodes to ${bytes.byteLength}`);
    }
    if (digestOf(bytes) !== entry.sha256) {
      throw new TypeError(`case ${caseId} does not match its pinned digest`);
    }
    return Object.freeze({
      caseId,
      label: "DEVELOPMENT_ONLY" as const,
      confirmatory: "NOT_CONFIRMATORY" as const,
      expectation: entry.expectation,
      byteLength: entry.byteLength,
      sha256: entry.sha256,
      rawBase64: entry.rawBase64,
    });
  });
  const seen = new Set(streams.map((stream) => stream.caseId));
  if (seen.size !== CLAUDE_GOLDEN_CASE_IDS.length) {
    throw new TypeError("claude golden corpus does not cover the closed case list exactly once");
  }
  return Object.freeze(streams);
}

export const CLAUDE_GOLDEN_STREAMS: readonly ClaudeGoldenStream[] = parseCorpus();

export function claudeGoldenStream(caseId: ClaudeGoldenCaseId): ClaudeGoldenStream {
  const found = CLAUDE_GOLDEN_STREAMS.find((stream) => stream.caseId === caseId);
  if (found === undefined) {
    throw new TypeError(`unknown claude golden case ${JSON.stringify(caseId)}`);
  }
  return found;
}

/** Returns a fresh copy so a consumer can never mutate the shared corpus. */
export function claudeGoldenStreamBytes(caseId: ClaudeGoldenCaseId): Uint8Array {
  return decodeBase64(claudeGoldenStream(caseId).rawBase64);
}

/** Canonical identity of the whole corpus, for the stability pin. */
export function claudeGoldenCorpusIdentity(): { readonly digest: string } {
  return identifyCanonicalEvidence({
    corpusVersion: CLAUDE_GOLDEN_CORPUS_VERSION,
    cases: CLAUDE_GOLDEN_STREAMS.map((stream) => ({
      caseId: stream.caseId,
      byteLength: stream.byteLength,
      sha256: stream.sha256,
    })),
  });
}

/**
 * Pinned by hand and re-verified on every run. If a fixture changes, this
 * constant must be updated in the same commit, which is what makes a silent
 * corpus edit impossible.
 */
export const CLAUDE_GOLDEN_CORPUS_DIGEST =
  "fadd4d913de06fb49723ffe2cfb3b713175b75a164531207daa5e53b43a5b8a3";
