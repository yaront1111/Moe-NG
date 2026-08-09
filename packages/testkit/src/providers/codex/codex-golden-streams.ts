import { createHash } from "node:crypto";

import { identifyCanonicalEvidence } from "../../evidence-digest.js";

/**
 * Golden Codex provider streams for the adapter contract (design 11.5).
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
export const CODEX_GOLDEN_CORPUS_VERSION = "moe-codex-golden-corpus/1" as const;

export const CODEX_GOLDEN_CORPUS_DATA_BEGIN = "moe-codex-golden-corpus/1 DATA BEGIN";
export const CODEX_GOLDEN_CORPUS_DATA_END = "moe-codex-golden-corpus/1 DATA END";

/** The closed corpus of design 11.5. Adding a case is a contract change. */
export const CODEX_GOLDEN_CASE_IDS = Object.freeze([
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
export type CodexGoldenCaseId = (typeof CODEX_GOLDEN_CASE_IDS)[number];

export interface CodexGoldenStream {
  readonly caseId: CodexGoldenCaseId;
  readonly label: "DEVELOPMENT_ONLY";
  readonly confirmatory: "NOT_CONFIRMATORY";
  readonly expectation: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly rawBase64: string;
}

/* moe-codex-golden-corpus/1 DATA BEGIN */
const CORPUS_JSON = `{
  "corpusVersion": "moe-codex-golden-corpus/1",
  "label": "DEVELOPMENT_ONLY",
  "confirmatory": "NOT_CONFIRMATORY",
  "cases": [
    {
      "caseId": "cancelled",
      "expectation": "Terminal result record reports subtype cancelled after a clean prefix.",
      "byteLength": 313,
      "sha256": "e49da69286242372c7bcc5716c9ede0c9d0747c2735ba438dcdff63aa7e6799c",
      "rawBase64": "eyJzY2hlbWFWZXJzaW9uIjoiY29kZXgtc3RyZWFtLWpzb24vMSIsInNlcSI6MSwidHlwZSI6InN5c3RlbSIsInN1YnR5cGUiOiJpbml0IiwicnVuSWQiOiJydW4tZ29sZGVuLWNhbmNlbGxlZCJ9Cnsic2NoZW1hVmVyc2lvbiI6ImNvZGV4LXN0cmVhbS1qc29uLzEiLCJzZXEiOjIsInR5cGUiOiJhc3Npc3RhbnQiLCJ0ZXh0IjoicmVhZGluZyBmaWxlcyJ9Cnsic2NoZW1hVmVyc2lvbiI6ImNvZGV4LXN0cmVhbS1qc29uLzEiLCJzZXEiOjMsInR5cGUiOiJyZXN1bHQiLCJzdWJ0eXBlIjoiY2FuY2VsbGVkIiwic3RvcFJlYXNvbiI6ImNhbmNlbGxlZCJ9Cg=="
    },
    {
      "caseId": "complete",
      "expectation": "Well formed CRLF stream ending in a success result; carries literal 0x0D 0x0A bytes.",
      "byteLength": 317,
      "sha256": "e412401c0cacf7e05cf473eb8fabe0d9e100f039122520c55a5deca8544b4b23",
      "rawBase64": "eyJzY2hlbWFWZXJzaW9uIjoiY29kZXgtc3RyZWFtLWpzb24vMSIsInNlcSI6MSwidHlwZSI6InN5c3RlbSIsInN1YnR5cGUiOiJpbml0IiwicnVuSWQiOiJydW4tZ29sZGVuLWNvbXBsZXRlIn0NCnsic2NoZW1hVmVyc2lvbiI6ImNvZGV4LXN0cmVhbS1qc29uLzEiLCJzZXEiOjIsInR5cGUiOiJhc3Npc3RhbnQiLCJ0ZXh0IjoiYXBwbHlpbmcgdGhlIHBhdGNoIn0NCnsic2NoZW1hVmVyc2lvbiI6ImNvZGV4LXN0cmVhbS1qc29uLzEiLCJzZXEiOjMsInR5cGUiOiJyZXN1bHQiLCJzdWJ0eXBlIjoic3VjY2VzcyIsInN0b3BSZWFzb24iOiJlbmRfdHVybiJ9DQo="
    },
    {
      "caseId": "crashed",
      "expectation": "Stream stops after a mid-run record with no terminal result record.",
      "byteLength": 203,
      "sha256": "8aff9df5d0e5532425e0fc6823b258ac2da9b92fe79981fc4cb655d5e03cfaf7",
      "rawBase64": "eyJzY2hlbWFWZXJzaW9uIjoiY29kZXgtc3RyZWFtLWpzb24vMSIsInNlcSI6MSwidHlwZSI6InN5c3RlbSIsInN1YnR5cGUiOiJpbml0IiwicnVuSWQiOiJydW4tZ29sZGVuLWNyYXNoZWQifQp7InNjaGVtYVZlcnNpb24iOiJjb2RleC1zdHJlYW0tanNvbi8xIiwic2VxIjoyLCJ0eXBlIjoiYXNzaXN0YW50IiwidGV4dCI6ImhhbGYgd2F5IHRocm91Z2gifQo="
    },
    {
      "caseId": "duplicated",
      "expectation": "Sequence 2 is delivered twice, byte identical.",
      "byteLength": 405,
      "sha256": "1b735b49f1a464dff736c8d91387b9c5437f1b966d165a28d60d32875e0c2efd",
      "rawBase64": "eyJzY2hlbWFWZXJzaW9uIjoiY29kZXgtc3RyZWFtLWpzb24vMSIsInNlcSI6MSwidHlwZSI6InN5c3RlbSIsInN1YnR5cGUiOiJpbml0IiwicnVuSWQiOiJydW4tZ29sZGVuLWR1cGxpY2F0ZWQifQp7InNjaGVtYVZlcnNpb24iOiJjb2RleC1zdHJlYW0tanNvbi8xIiwic2VxIjoyLCJ0eXBlIjoiYXNzaXN0YW50IiwidGV4dCI6ImRlbGl2ZXJlZCB0d2ljZSJ9Cnsic2NoZW1hVmVyc2lvbiI6ImNvZGV4LXN0cmVhbS1qc29uLzEiLCJzZXEiOjIsInR5cGUiOiJhc3Npc3RhbnQiLCJ0ZXh0IjoiZGVsaXZlcmVkIHR3aWNlIn0KeyJzY2hlbWFWZXJzaW9uIjoiY29kZXgtc3RyZWFtLWpzb24vMSIsInNlcSI6MywidHlwZSI6InJlc3VsdCIsInN1YnR5cGUiOiJzdWNjZXNzIiwic3RvcFJlYXNvbiI6ImVuZF90dXJuIn0K"
    },
    {
      "caseId": "malformed",
      "expectation": "Second line is a truncated JSON object that still ends with a newline.",
      "byteLength": 287,
      "sha256": "f4f19c79f384f154e24a3ed6c130e071a5a6053e0ef78f711930147a2ba3f31d",
      "rawBase64": "eyJzY2hlbWFWZXJzaW9uIjoiY29kZXgtc3RyZWFtLWpzb24vMSIsInNlcSI6MSwidHlwZSI6InN5c3RlbSIsInN1YnR5cGUiOiJpbml0IiwicnVuSWQiOiJydW4tZ29sZGVuLW1hbGZvcm1lZCJ9Cnsic2NoZW1hVmVyc2lvbiI6ImNvZGV4LXN0cmVhbS1qc29uLzEiLCJzZXEiOjIsInR5cGUiOiJhc3Npc3RhbnQiLAp7InNjaGVtYVZlcnNpb24iOiJjb2RleC1zdHJlYW0tanNvbi8xIiwic2VxIjozLCJ0eXBlIjoicmVzdWx0Iiwic3VidHlwZSI6InN1Y2Nlc3MiLCJzdG9wUmVhc29uIjoiZW5kX3R1cm4ifQo="
    },
    {
      "caseId": "reordered",
      "expectation": "Sequence 3 arrives before sequence 2.",
      "byteLength": 401,
      "sha256": "d79ac0b8ca4518354c4921d407b9a263854ab9c44e2744c1ae9316bdf34ed4ca",
      "rawBase64": "eyJzY2hlbWFWZXJzaW9uIjoiY29kZXgtc3RyZWFtLWpzb24vMSIsInNlcSI6MSwidHlwZSI6InN5c3RlbSIsInN1YnR5cGUiOiJpbml0IiwicnVuSWQiOiJydW4tZ29sZGVuLXJlb3JkZXJlZCJ9Cnsic2NoZW1hVmVyc2lvbiI6ImNvZGV4LXN0cmVhbS1qc29uLzEiLCJzZXEiOjMsInR5cGUiOiJhc3Npc3RhbnQiLCJ0ZXh0Ijoic2Vjb25kIHRob3VnaHQifQp7InNjaGVtYVZlcnNpb24iOiJjb2RleC1zdHJlYW0tanNvbi8xIiwic2VxIjoyLCJ0eXBlIjoiYXNzaXN0YW50IiwidGV4dCI6ImZpcnN0IHRob3VnaHQifQp7InNjaGVtYVZlcnNpb24iOiJjb2RleC1zdHJlYW0tanNvbi8xIiwic2VxIjo0LCJ0eXBlIjoicmVzdWx0Iiwic3VidHlwZSI6InN1Y2Nlc3MiLCJzdG9wUmVhc29uIjoiZW5kX3R1cm4ifQo="
    },
    {
      "caseId": "resumed",
      "expectation": "Stream opens at sequence 7 declaring resumedFrom; resume is UNSUPPORTED in v1.",
      "byteLength": 343,
      "sha256": "5a7bcb94b4f914c0cf74fbe83746d5993c43d8649ce86adcef137cc073dbb00d",
      "rawBase64": "eyJzY2hlbWFWZXJzaW9uIjoiY29kZXgtc3RyZWFtLWpzb24vMSIsInNlcSI6NywidHlwZSI6InN5c3RlbSIsInN1YnR5cGUiOiJyZXN1bWUiLCJydW5JZCI6InJ1bi1nb2xkZW4tcmVzdW1lZCIsInJlc3VtZWRGcm9tIjoicnVuLWdvbGRlbi1jb21wbGV0ZSJ9Cnsic2NoZW1hVmVyc2lvbiI6ImNvZGV4LXN0cmVhbS1qc29uLzEiLCJzZXEiOjgsInR5cGUiOiJhc3Npc3RhbnQiLCJ0ZXh0IjoiY29udGludWluZyJ9Cnsic2NoZW1hVmVyc2lvbiI6ImNvZGV4LXN0cmVhbS1qc29uLzEiLCJzZXEiOjksInR5cGUiOiJyZXN1bHQiLCJzdWJ0eXBlIjoic3VjY2VzcyIsInN0b3BSZWFzb24iOiJlbmRfdHVybiJ9Cg=="
    },
    {
      "caseId": "truncated",
      "expectation": "Final line is cut mid object with no trailing newline.",
      "byteLength": 259,
      "sha256": "78265efeaf2d4b993a5ca5f553e7356feaecd98eca2c833c0f77bf86f0140cd7",
      "rawBase64": "eyJzY2hlbWFWZXJzaW9uIjoiY29kZXgtc3RyZWFtLWpzb24vMSIsInNlcSI6MSwidHlwZSI6InN5c3RlbSIsInN1YnR5cGUiOiJpbml0IiwicnVuSWQiOiJydW4tZ29sZGVuLXRydW5jYXRlZCJ9Cnsic2NoZW1hVmVyc2lvbiI6ImNvZGV4LXN0cmVhbS1qc29uLzEiLCJzZXEiOjIsInR5cGUiOiJhc3Npc3RhbnQiLCJ0ZXh0IjoiY3V0IG9mZiBuZXh0In0KeyJzY2hlbWFWZXJzaW9uIjoiY29kZXgtc3RyZWFtLWpzb24vMSIsInNlcSI6MywidHlwZSI6InJlcw=="
    },
    {
      "caseId": "version-mismatched",
      "expectation": "Records switch to an unknown schema version mid stream.",
      "byteLength": 320,
      "sha256": "b3857102808afaee29c067d5a00faf3f3654ba84e9811ce7c95fce8d124f0f3b",
      "rawBase64": "eyJzY2hlbWFWZXJzaW9uIjoiY29kZXgtc3RyZWFtLWpzb24vMSIsInNlcSI6MSwidHlwZSI6InN5c3RlbSIsInN1YnR5cGUiOiJpbml0IiwicnVuSWQiOiJydW4tZ29sZGVuLXZlcnNpb24tbWlzbWF0Y2hlZCJ9Cnsic2NoZW1hVmVyc2lvbiI6ImNsYXVkZS1zdHJlYW0tanNvbi8yIiwic2VxIjoyLCJ0eXBlIjoiYXNzaXN0YW50IiwidGV4dCI6Im5ld2VyIHNjaGVtYSJ9Cnsic2NoZW1hVmVyc2lvbiI6ImNsYXVkZS1zdHJlYW0tanNvbi8yIiwic2VxIjozLCJ0eXBlIjoicmVzdWx0Iiwic3VidHlwZSI6InN1Y2Nlc3MiLCJzdG9wUmVhc29uIjoiZW5kX3R1cm4ifQo="
    }
  ]
}`;
/* moe-codex-golden-corpus/1 DATA END */

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
function parseCorpus(): readonly CodexGoldenStream[] {
  const parsed: unknown = JSON.parse(CORPUS_JSON);
  if (typeof parsed !== "object" || parsed === null) {
    throw new TypeError("codex golden corpus is not an object");
  }
  const document = parsed as Record<string, unknown>;
  if (document["corpusVersion"] !== CODEX_GOLDEN_CORPUS_VERSION) {
    throw new TypeError("codex golden corpus declares an unsupported version");
  }
  const cases = document["cases"];
  if (!Array.isArray(cases)) {
    throw new TypeError("codex golden corpus has no case list");
  }
  const streams = cases.map((entry: unknown): CodexGoldenStream => {
    if (!isCase(entry)) {
      throw new TypeError("codex golden corpus holds a malformed case");
    }
    const caseId = entry.caseId as CodexGoldenCaseId;
    if (!CODEX_GOLDEN_CASE_IDS.includes(caseId)) {
      throw new TypeError(`codex golden corpus holds an unknown case ${JSON.stringify(caseId)}`);
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
  if (seen.size !== CODEX_GOLDEN_CASE_IDS.length) {
    throw new TypeError("codex golden corpus does not cover the closed case list exactly once");
  }
  return Object.freeze(streams);
}

export const CODEX_GOLDEN_STREAMS: readonly CodexGoldenStream[] = parseCorpus();

export function codexGoldenStream(caseId: CodexGoldenCaseId): CodexGoldenStream {
  const found = CODEX_GOLDEN_STREAMS.find((stream) => stream.caseId === caseId);
  if (found === undefined) {
    throw new TypeError(`unknown codex golden case ${JSON.stringify(caseId)}`);
  }
  return found;
}

/** Returns a fresh copy so a consumer can never mutate the shared corpus. */
export function codexGoldenStreamBytes(caseId: CodexGoldenCaseId): Uint8Array {
  return decodeBase64(codexGoldenStream(caseId).rawBase64);
}

/** Canonical identity of the whole corpus, for the stability pin. */
export function codexGoldenCorpusIdentity(): { readonly digest: string } {
  return identifyCanonicalEvidence({
    corpusVersion: CODEX_GOLDEN_CORPUS_VERSION,
    cases: CODEX_GOLDEN_STREAMS.map((stream) => ({
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
export const CODEX_GOLDEN_CORPUS_DIGEST =
  "2b006bc964f353f77e5e1f1d433657bbe29b8ea2827b9fef91e3b28350ab5fc2";
